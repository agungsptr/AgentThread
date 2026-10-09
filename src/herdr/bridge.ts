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

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HerdrBridge {
  createTab(o: { workspace: string; cwd: string; label: string; env: Record<string, string> }): { tabId: string; rootPaneId: string };
  renameTab(tabId: string, label: string): void;
  closeTab(tabId: string): void;
  tabExists(tabId: string): boolean;
  splitPane(o: { pane: string; direction: "right" | "down"; cwd: string; env: Record<string, string> }): string;
  renamePane(paneId: string, label: string): void;
  runInPane(paneId: string, command: string): void;
}

const envArgs = (env: Record<string, string>) => Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Drives Herdr through its CLI. Every call parses the JSON `result`, and herdr's JSON errors become HerdrError. */
export class HerdrCli implements HerdrBridge {
  constructor(private readonly opts: { bin: string; env?: Env; runner?: Runner; timeoutMs?: number }) {}

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

  splitPane(o: { pane: string; direction: "right" | "down"; cwd: string; env: Record<string, string> }): string {
    const args = ["pane", "split", o.pane, "--direction", o.direction, "--cwd", o.cwd, "--no-focus", ...envArgs(o.env)];
    return field(args, this.call(args), "pane", "pane_id");
  }

  renamePane(paneId: string, label: string): void {
    this.call(["pane", "rename", paneId, label]);
  }

  runInPane(paneId: string, command: string): void {
    this.call(["pane", "run", paneId, command]);
  }

  private call(args: string[]): unknown {
    const what = `herdr ${args.slice(0, 2).join(" ")}`;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const r = (this.opts.runner ?? spawnRunner)(this.opts.bin, args, this.opts.env ?? process.env, timeoutMs);
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
    try {
      return (JSON.parse(r.stdout) as { result?: unknown }).result;
    } catch {
      throw new HerdrError("bad_output", `${what}: unparseable output`);
    }
  }
}

function field(args: string[], value: unknown, ...keys: string[]): string {
  let cur: unknown = value;
  for (const k of keys) cur = typeof cur === "object" && cur !== null ? (cur as Record<string, unknown>)[k] : undefined;
  if (typeof cur !== "string") throw new HerdrError("bad_output", `herdr ${args.slice(0, 2).join(" ")}: response missing ${keys.join(".")}`);
  return cur;
}
