type Env = Record<string, string | undefined>;

export type RunResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };
export type Runner = (bin: string, args: string[], env: Env, timeoutMs: number) => RunResult;

export const DEFAULT_TIMEOUT_MS = 10_000;

// Bun 1.1.34 ignores the `timeout` option of both Bun.spawnSync and node:child_process spawnSync (checked: a
// 5s sleep with a 300ms timeout runs for 5s), so a shell watchdog kills the child instead.
const WATCHDOG = `T=$1; shift
"$@" &
pid=$!
( trap 'kill $s 2>/dev/null; exit 0' TERM; sleep "$T" & s=$!; wait $s; kill -9 $pid 2>/dev/null ) >/dev/null 2>&1 &
wd=$!
wait $pid
rc=$?
kill $wd 2>/dev/null
exit $rc`;

export const spawnRunner: Runner = (bin, args, env, timeoutMs) => {
  const r = Bun.spawnSync(["/bin/sh", "-c", WATCHDOG, "herdr", String(timeoutMs / 1000), bin, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = r.exitCode ?? 1;
  // 137 = killed by the watchdog's SIGKILL
  return { exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), timedOut: exitCode === 137 };
};

export type AsyncRunner = (bin: string, args: string[], env: Env, timeoutMs: number) => Promise<RunResult>;

/**
 * Like spawnRunner, but never blocks the event loop. The daemon uses it for everything it runs after startup: in Bun
 * 1.1.34 a Bun.spawnSync made from daemon work could stall forever after its child had exited (see the stress test).
 */
export const spawnAsync: AsyncRunner = async (bin, args, env, timeoutMs) => {
  let proc;
  try {
    proc = Bun.spawn([bin, ...args], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (e) {
    return { exitCode: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
  // Collected as it arrives: a grandchild that inherited the pipes can keep them open after the child is killed.
  const out = collect(proc.stdout);
  const err = collect(proc.stderr);
  let timedOut = false;
  let killed!: () => void;
  const afterKill = new Promise<void>((r) => (killed = r));
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
    killed();
  }, timeoutMs);
  try {
    const all = Promise.all([out.done, err.done, proc.exited]).then(() => {});
    // After a kill, wait for the exit and a short grace for the pipes, never for a grandchild to close them.
    await Promise.race([all, afterKill.then(() => Promise.race([all, proc.exited.then(() => Bun.sleep(KILL_GRACE_MS))]))]);
    return { exitCode: proc.exitCode ?? (timedOut ? 137 : 1), stdout: out.text(), stderr: err.text(), timedOut };
  } finally {
    clearTimeout(timer);
    if (timedOut) {
      out.cancel();
      err.cancel();
    }
  }
};

const KILL_GRACE_MS = 200;

function collect(stream: ReadableStream<Uint8Array>): { done: Promise<void>; text(): string; cancel(): void } {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const done = (async () => {
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) return;
        chunks.push(value);
      }
    } catch {
      // cancelled after a timeout
    }
  })();
  return {
    done,
    text: () => Buffer.concat(chunks).toString(),
    cancel: () => void reader.cancel().catch(() => {}),
  };
}

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export interface AgentListing {
  pane: string;
  status: AgentStatus;
  kind: string;
}

/** A pane's place in its tab, in terminal cells. */
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What `herdr pane layout` tells of the tab around a pane (Herdr's PaneLayoutSnapshot; splits are left out). */
export interface PaneLayout {
  tabId: string;
  zoomed: boolean;
  panes: { paneId: string; rect: PaneRect }[];
}

export interface HerdrBridge {
  createTab(o: { workspace: string; cwd: string; label: string; env: Record<string, string> }): { tabId: string; rootPaneId: string };
  renameTab(tabId: string, label: string): void;
  closeTab(tabId: string): void;
  tabExists(tabId: string): boolean;
  splitPane(o: { pane: string; direction: "right" | "down"; cwd: string; env: Record<string, string> }): string;
  renamePane(paneId: string, label: string): void;
  runInPane(paneId: string, command: string): void;
  agentStart(o: { name: string; kind: string; pane: string; args: string[]; timeoutMs?: number }): void;
  /** Like agentStart without blocking the event loop: the spawn job watches the pane while Herdr waits for readiness. */
  agentStartAsync?(o: { name: string; kind: string; pane: string; args: string[]; timeoutMs?: number }): Promise<void>;
  agentPrompt(target: string, text: string): void;
  closePane(pane: string): void;
  agentExists(target: string): boolean;
  agentList(): AgentListing[];
  // Optional: without them a worker is split as before, never placed by layout.
  /** The layout of the tab `pane` is in. */
  paneLayout?(pane: string): PaneLayout;
  tabList?(workspace: string): { tabId: string; label: string }[];
  paneList?(workspace: string): { paneId: string; tabId: string }[];
}

/**
 * Reads a pane's screen and its agent's state, and types keys into it: what the spawn job needs to answer an agent's
 * startup dialog. All async, so the job keeps going (its agent start, its report) while it watches.
 */
export interface PaneScreen {
  agentListAsync(): Promise<AgentListing[]>;
  /** The visible screen as text. */
  paneReadAsync(pane: string): Promise<string>;
  /** One named key, such as `down` or `enter`. */
  paneSendKeysAsync(pane: string, key: string): Promise<void>;
}

const envArgs = (env: Record<string, string>) => Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Drives Herdr through its CLI. Every call parses the JSON `result`, and herdr's JSON errors become HerdrError. */
export class HerdrCli implements HerdrBridge, PaneScreen {
  constructor(private readonly opts: { bin: string; env?: Env; runner?: Runner; asyncRunner?: AsyncRunner; timeoutMs?: number }) {}

  get bin(): string {
    return this.opts.bin;
  }

  createTab(o: { workspace: string; cwd: string; label: string; env: Record<string, string> }) {
    const args = ["tab", "create", "--workspace", o.workspace, "--cwd", o.cwd, "--label", o.label, "--no-focus", ...envArgs(o.env)];
    const result = this.call(args);
    return { tabId: field(args, result, "tab", "tab_id"), rootPaneId: field(args, result, "root_pane", "pane_id") };
  }

  renameTab(tabId: string, label: string): void {
    this.call(["tab", "rename", tabId, label]);
  }

  closeTab(tabId: string): void {
    this.call(["tab", "close", tabId]);
  }

  tabExists(tabId: string): boolean {
    try {
      this.call(["tab", "get", tabId]);
      return true;
    } catch (e) {
      if (e instanceof HerdrError && (e.code === "tab_not_found" || e.code === "not_found")) return false;
      throw e;
    }
  }

  paneExists(pane: string): boolean {
    try {
      this.call(["pane", "get", pane]);
      return true;
    } catch (e) {
      if (e instanceof HerdrError && (e.code === "pane_not_found" || e.code === "not_found")) return false;
      throw e;
    }
  }

  splitPane(o: { pane: string; direction: "right" | "down"; cwd: string; env: Record<string, string> }): string {
    const args = ["pane", "split", o.pane, "--direction", o.direction, "--cwd", o.cwd, "--no-focus", ...envArgs(o.env)];
    return field(args, this.call(args), "pane", "pane_id");
  }

  renamePane(paneId: string, label: string): void {
    this.call(["pane", "rename", paneId, label]);
  }

  runInPane(paneId: string, command: string): void {
    // Real Herdr prints nothing on stdout for a successful `pane run`.
    this.call(["pane", "run", paneId, command], undefined, { emptyOk: true });
  }

  agentStart(o: { name: string; kind: string; pane: string; args: string[]; timeoutMs?: number }): void {
    const herdrTimeout = o.timeoutMs ?? 60_000;
    this.call(agentStartArgs(o, herdrTimeout), herdrTimeout + 10_000);
  }

  async agentStartAsync(o: { name: string; kind: string; pane: string; args: string[]; timeoutMs?: number }): Promise<void> {
    const herdrTimeout = o.timeoutMs ?? 60_000;
    await this.callAsync(agentStartArgs(o, herdrTimeout), herdrTimeout + 10_000);
  }

  agentPrompt(target: string, text: string): void {
    this.call(["agent", "prompt", target, text]);
  }

  closePane(pane: string): void {
    this.call(["pane", "close", pane]);
  }

  agentExists(target: string): boolean {
    try {
      this.call(["agent", "get", target]);
      return true;
    } catch (e) {
      if (e instanceof HerdrError && (e.code === "agent_not_found" || e.code === "pane_not_found" || e.code === "not_found")) return false;
      throw e;
    }
  }

  agentList(): AgentListing[] {
    return parseAgents(this.call(["agent", "list"]));
  }

  paneLayout(pane: string): PaneLayout {
    const layout = parsePaneLayout(this.call(["pane", "layout", "--pane", pane]));
    if (!layout) throw new HerdrError("bad_output", "herdr pane layout: response missing layout");
    return layout;
  }

  tabList(workspace: string): { tabId: string; label: string }[] {
    return parseTabs(this.call(["tab", "list", "--workspace", workspace]));
  }

  paneList(workspace: string): { paneId: string; tabId: string }[] {
    const panes = list(this.call(["pane", "list", "--workspace", workspace]), "panes", "herdr pane list");
    return panes.flatMap((p) => (typeof p.pane_id === "string" && typeof p.tab_id === "string" ? [{ paneId: p.pane_id, tabId: p.tab_id }] : []));
  }

  // The async twins below never block the daemon's event loop; the daemon uses them for all its effects and polls.

  async agentListAsync(): Promise<AgentListing[]> {
    return parseAgents(await this.callAsync(["agent", "list"]));
  }

  async createTabAsync(o: { workspace: string; cwd: string; label: string; env: Record<string, string> }) {
    const args = ["tab", "create", "--workspace", o.workspace, "--cwd", o.cwd, "--label", o.label, "--no-focus", ...envArgs(o.env)];
    const result = await this.callAsync(args);
    return { tabId: field(args, result, "tab", "tab_id"), rootPaneId: field(args, result, "root_pane", "pane_id") };
  }

  async closeTabAsync(tabId: string): Promise<void> {
    await this.callAsync(["tab", "close", tabId]);
  }

  async tabExistsAsync(tabId: string): Promise<boolean> {
    try {
      await this.callAsync(["tab", "get", tabId]);
      return true;
    } catch (e) {
      if (e instanceof HerdrError && (e.code === "tab_not_found" || e.code === "not_found")) return false;
      throw e;
    }
  }

  async tabListAsync(workspace: string): Promise<{ tabId: string; label: string }[]> {
    return parseTabs(await this.callAsync(["tab", "list", "--workspace", workspace]));
  }

  async agentPromptAsync(target: string, text: string): Promise<void> {
    await this.callAsync(["agent", "prompt", target, text]);
  }

  async closePaneAsync(pane: string): Promise<void> {
    await this.callAsync(["pane", "close", pane]);
  }

  async agentExistsAsync(target: string): Promise<boolean> {
    try {
      await this.callAsync(["agent", "get", target]);
      return true;
    } catch (e) {
      if (e instanceof HerdrError && (e.code === "agent_not_found" || e.code === "pane_not_found" || e.code === "not_found")) return false;
      throw e;
    }
  }

  async paneReadAsync(pane: string, timeoutMs?: number): Promise<string> {
    // `pane read` prints the screen itself, not a JSON result.
    return (await this.callAsync(["pane", "read", pane, "--source", "visible"], timeoutMs, { raw: true })) as string;
  }

  async paneSendKeysAsync(pane: string, key: string): Promise<void> {
    await this.callAsync(["pane", "send-keys", pane, key], undefined, { raw: true });
  }

  private call(args: string[], timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, o: { emptyOk?: boolean } = {}): unknown {
    return this.result(args, (this.opts.runner ?? spawnRunner)(this.opts.bin, args, this.opts.env ?? process.env, timeoutMs), timeoutMs, o);
  }

  private async callAsync(args: string[], timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, o: { raw?: boolean } = {}): Promise<unknown> {
    return this.result(args, await (this.opts.asyncRunner ?? spawnAsync)(this.opts.bin, args, this.opts.env ?? process.env, timeoutMs), timeoutMs, o);
  }

  private result(args: string[], r: RunResult, timeoutMs: number, o: { emptyOk?: boolean; raw?: boolean } = {}): unknown {
    const what = `herdr ${args.slice(0, 2).join(" ")}`;
    if (r.timedOut) throw new HerdrError("timeout", `${what}: timed out after ${timeoutMs}ms`);
    if (r.exitCode !== 0) {
      let code = "herdr_failed";
      let message = r.stderr.trim() || `exited with ${r.exitCode}`;
      try {
        const err = (JSON.parse(r.stderr) as { error?: { code?: string; message?: string } }).error;
        if (err?.code) {
          code = err.code;
          message = err.message ?? message;
        }
      } catch {
        // stderr was not JSON; keep the raw text
      }
      throw new HerdrError(code, `${what}: ${message}`);
    }
    if (o.raw) return r.stdout;
    if (o.emptyOk && r.stdout.trim() === "") return undefined;
    try {
      return (JSON.parse(r.stdout) as { result?: unknown }).result;
    } catch {
      throw new HerdrError("bad_output", `${what}: unparseable output`);
    }
  }
}

/** `herdr agent start` waits up to `herdrTimeout` for the agent to be ready (a startup dialog keeps it from that). */
function agentStartArgs(o: { name: string; kind: string; pane: string; args: string[] }, herdrTimeout: number): string[] {
  return ["agent", "start", o.name, "--kind", o.kind, "--pane", o.pane, "--timeout", String(herdrTimeout), "--", ...o.args];
}

function field(args: string[], value: unknown, ...keys: string[]): string {
  let cur: unknown = value;
  for (const k of keys) cur = typeof cur === "object" && cur !== null ? (cur as Record<string, unknown>)[k] : undefined;
  if (typeof cur !== "string") throw new HerdrError("bad_output", `herdr ${args.slice(0, 2).join(" ")}: response missing ${keys.join(".")}`);
  return cur;
}

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function list(result: unknown, key: string, what: string): Record<string, unknown>[] {
  const items = record(result)?.[key];
  if (!Array.isArray(items)) throw new HerdrError("bad_output", `${what}: response missing ${key}`);
  return items.flatMap((i: unknown) => {
    const r = record(i);
    return r ? [r] : [];
  });
}

function parseTabs(result: unknown): { tabId: string; label: string }[] {
  return list(result, "tabs", "herdr tab list").flatMap((t) => (typeof t.tab_id === "string" ? [{ tabId: t.tab_id, label: typeof t.label === "string" ? t.label : "" }] : []));
}

const cells = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Reads the `result` of `herdr pane layout`, as Herdr's API schema gives it (docs/next/api/herdr-api.schema.json,
 * herdr 0.9.5): `{type: "pane_layout", layout: PaneLayoutSnapshot}`, where the snapshot has `workspace_id`, `tab_id`,
 * `zoomed`, `area`, `focused_pane_id`, `panes: [{pane_id, focused, rect: {x, y, width, height}}]` and `splits`.
 * Undefined when the shape is anything else: a layout agt cannot read is never guessed at.
 */
export function parsePaneLayout(result: unknown): PaneLayout | undefined {
  const layout = record(record(result)?.layout);
  if (!layout || typeof layout.tab_id !== "string" || !Array.isArray(layout.panes) || layout.panes.length === 0) return undefined;
  const panes: PaneLayout["panes"] = [];
  for (const p of layout.panes) {
    const rect = record(record(p)?.rect);
    const paneId = record(p)?.pane_id;
    if (typeof paneId !== "string" || !rect || !cells(rect.x) || !cells(rect.y) || !cells(rect.width) || !cells(rect.height)) return undefined;
    panes.push({ paneId, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  }
  return { tabId: layout.tab_id, zoomed: layout.zoomed === true, panes };
}

function parseAgents(result: unknown): AgentListing[] {
  const agents = typeof result === "object" && result !== null ? (result as { agents?: unknown }).agents : undefined;
  if (!Array.isArray(agents)) throw new HerdrError("bad_output", "herdr agent list: response missing agents");
  const known = ["idle", "working", "blocked", "done"];
  return agents.flatMap((a: unknown) => {
    const r = (typeof a === "object" && a !== null ? a : {}) as Record<string, unknown>;
    if (typeof r.pane_id !== "string") return [];
    const status = typeof r.agent_status === "string" && known.includes(r.agent_status) ? (r.agent_status as AgentStatus) : "unknown";
    return [{ pane: r.pane_id, status, kind: typeof r.agent === "string" ? r.agent : "unknown" }];
  });
}
