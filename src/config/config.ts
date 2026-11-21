import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { AGENT_KINDS, type SessionRole } from "../domain/types.ts";
import { EFFORTS } from "../agents/roles.ts";

type Env = Record<string, string | undefined>;

const DURATION = /^\d+(ms|[smhd])$/;
const duration = z.string().regex(DURATION, "duration must look like 500ms, 30s, 5m, 24h or 2d");
/** A duration of at least `min` (written the same way, e.g. "100ms"). */
const durationAtLeast = (min: string) => duration.refine((d) => !DURATION.test(d) || durationMs(d) >= durationMs(min), `must be at least ${min}`);
const agent = z.enum(AGENT_KINDS);
export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const;

const roleAgentSchema = z
  .object({ agent, model: z.string().trim().min(1).optional(), effort: z.string().trim().min(1).optional() })
  .strict();
const ROLE_NAMES = ["main", "coordinator", "worker"] as const satisfies readonly SessionRole[];

const agentsSchema = z
  .object({
    main_manager: agent.optional(),
    default_coordinator: agent.optional(),
    default_worker: agent.optional(),
    roles: z.object({ main: roleAgentSchema.optional(), coordinator: roleAgentSchema.optional(), worker: roleAgentSchema.optional() }).strict().default({}),
    complexity: z
      .object({
        timeout: durationAtLeast("1s").default("10s"),
        tiers: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/, "tier name must match /^[a-z][a-z0-9_-]*$/"), roleAgentSchema).default({}),
      })
      .strict()
      .default({}),
    autonomous: z.boolean().default(true),
    skill: z.boolean().default(true),
    claude: z
      .object({
        permission_mode: z.enum(PERMISSION_MODES).default("acceptEdits"),
        extra_allowed_tools: z.array(z.string().trim().min(1)).default([]),
        model: z.string().trim().min(1).optional(),
        config_dir: z.string().trim().min(1).optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((a, ctx) => {
    const check = (path: (string | number)[], v: { agent: keyof typeof EFFORTS; model?: string | undefined; effort?: string | undefined } | undefined) => {
      // OpenCode takes the effort as a variant of the model (<provider/model>#<effort>), so it needs one.
      if (v?.agent === "opencode" && v.effort !== undefined && v.model === undefined) {
        ctx.addIssue({ code: "custom", path: [...path, "effort"], message: "opencode effort needs a model" });
        return;
      }
      const list = v && EFFORTS[v.agent];
      if (!v || v.effort === undefined || !list || list.length === 0 || list.includes(v.effort)) return;
      ctx.addIssue({ code: "custom", path: [...path, "effort"], message: `${v.agent} accepts ${list.join(", ")}` });
    };
    for (const r of ROLE_NAMES) check(["roles", r], a.roles[r]);
    for (const [name, t] of Object.entries(a.complexity.tiers)) check(["complexity", "tiers", name], t);
  })
  .transform((a) => {
    const legacy = { main: a.main_manager, coordinator: a.default_coordinator, worker: a.default_worker };
    const roles = {} as Record<SessionRole, RoleAgent>;
    for (const r of ROLE_NAMES) {
      const set = a.roles[r];
      if (set) roles[r] = set;
      else {
        const ag = legacy[r] ?? "claude-code";
        roles[r] = { agent: ag, ...(ag === "claude-code" && a.claude.model ? { model: a.claude.model } : {}) };
      }
    }
    return {
      main_manager: roles.main.agent,
      default_coordinator: roles.coordinator.agent,
      default_worker: roles.worker.agent,
      roles,
      complexity: a.complexity,
      autonomous: a.autonomous,
      skill: a.skill,
      claude: a.claude,
    };
  });

export type RoleAgent = { agent: z.infer<typeof agent>; model?: string; effort?: string };

const SERVICE_NAME = /^[a-z][a-z0-9-]*$/;
const HEALTH = /^(https?:\/\/\S+|tcp:\d+)$/;

const serviceSchema = z
  .object({
    repo: z.string().min(1),
    dir: z.string().min(1).default("."),
    start: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    health: z.string().regex(HEALTH, "health must be http(s)://... or tcp:<port>").optional(),
    migrate: z.string().min(1).optional(),
    /** Run `migrate` on every start whose checkout state changed. Default false: migrations run only with `agt stack start|restart --migrate`. */
    migrate_on_start: z.boolean().default(false),
    /** Extra environment for start and migrate, merged over the inherited one. Values may be secrets: never printed. */
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env key must match /^[A-Za-z_][A-Za-z0-9_]*$/"), z.string()).optional(),
    after: z.array(z.string().min(1)).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

export type ServiceConfig = z.infer<typeof serviceSchema>;

/** Cross-field checks of `workspace.services`: repo exists, unique ports, known and acyclic `after`. */
function checkServices(
  w: { repos?: Record<string, unknown> | undefined; services?: Record<string, ServiceConfig> | undefined },
  ctx: z.RefinementCtx,
): void {
  const services = w.services ?? {};
  const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path: ["services", ...path], message });
  const ports = new Map<number, string>();
  for (const [name, s] of Object.entries(services)) {
    if (!(s.repo in (w.repos ?? {}))) bad([name, "repo"], `unknown repo "${s.repo}" (not in workspace.repos)`);
    s.after?.forEach((a, i) => {
      if (!(a in services)) bad([name, "after", i], `unknown service "${a}"`);
    });
    if (s.enabled && s.port !== undefined) {
      const other = ports.get(s.port);
      if (other !== undefined) bad([name, "port"], `port ${s.port} is already used by service "${other}"`);
      else ports.set(s.port, name);
    }
  }
  // depth-first cycle search over known `after` edges
  const state = new Map<string, 1 | 2>();
  const visit = (n: string, trail: string[]): boolean => {
    if (state.get(n) === 2) return false;
    if (state.get(n) === 1) {
      bad([n, "after"], `dependency cycle: ${[...trail.slice(trail.indexOf(n)), n].join(" -> ")}`);
      return true;
    }
    state.set(n, 1);
    for (const a of services[n]?.after ?? []) if (a in services && visit(a, [...trail, n])) return true;
    state.set(n, 2);
    return false;
  };
  for (const n of Object.keys(services)) if (visit(n, [])) break;
}

/** The stack commands in effect: explicit values win; with services configured they default to `agt stack ...`. */
export function effectiveStack(config: Config): { restart?: string; status?: string } {
  const st = config.workflow.stack;
  const has = Object.keys(config.workspace.services ?? {}).length > 0;
  const restart = st?.restart ?? (has ? "agt stack restart --task {task}" : undefined);
  const status = st?.status ?? (has ? "agt stack status" : undefined);
  return { ...(restart ? { restart } : {}), ...(status ? { status } : {}) };
}

export const ConfigSchema = z
  .object({
    language: z.enum(["en"]).default("en"),
    agents: agentsSchema.default({}),
    workers: z
      .object({ max_workers: z.number().int().min(1).max(16).default(3) })
      .strict()
      .default({}),
    session: z
      .object({
        rotation: z
          .object({
            on_precompact: z.boolean().default(true),
            context_threshold: z.number().gt(0).lt(1).default(0.7),
            idle_timeout: duration.default("24h"),
            context_window: z.number().int().min(1000).default(200_000),
            max_turns: z.number().int().min(1).default(150),
            max_age: duration.default("8h"),
          })
          .strict()
          .default({}),
        handoff: z
          .object({ timeout: duration.default("5m"), fallback_generate: z.boolean().default(true) })
          .strict()
          .default({}),
        /**
         * How long a spawned session may stay `starting` without a pane before the sweep fails it (its spawn report was
         * lost). At least 60s: well beyond the spawn job's report retry window (20 × 500ms), so the sweep never fails a
         * session whose job is still retrying its report.
         */
        spawn_timeout: durationAtLeast("60s").default("3m"),
        /** How long a worker may keep running after its ticket is done before the sweep closes it. At least 30s. */
        finished_worker_grace: durationAtLeast("30s").default("5m"),
      })
      .strict()
      .default({}),
    checkpoint: z
      .object({ reminder_turns: z.number().int().min(1).default(8), reminder_after: duration.default("30m") })
      .strict()
      .default({}),
    workspace: z
      .object({
        repos: z
          .record(
            z.string().min(1),
            z
              .object({
                path: z.string().min(1),
                source_branch: z.string().trim().min(1).optional(),
                prod_branch: z.string().trim().min(1).optional(),
                staging_branch: z.string().trim().min(1).optional(),
                pr_order: z.number().int().optional(),
                /** Run in the repo worktree. */
                unit: z.string().min(1).optional(),
                typecheck: z.string().min(1).optional(),
                /**
                 * Files and directories (recursive) copied from the main checkout into each new worktree; missing ones are skipped
                 * with a note. A git-tracked file is replaced by the local copy and marked skip-worktree there.
                 */
                copy: z.array(z.string().trim().min(1)).optional(),
                /**
                 * Directories symlinked from the main checkout into each new worktree instead of copied or installed. With
                 * node_modules listed, `install` is skipped for the repo unless its lockfile differs from the main checkout's.
                 */
                link: z.array(z.string().trim().min(1)).optional(),
                /** Run in a new worktree. Unset: detected from the lockfile; "" disables. */
                install: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
        services: z.record(z.string().regex(SERVICE_NAME, "service name must match /^[a-z][a-z0-9-]*$/"), serviceSchema).optional(),
        /**
         * Run by `agt worktree add` instead of git worktree add. It replaces the built-in copy + install step too: the
         * command must do any file copying and dependency install itself. The placeholders {root} {task} {repo} {src} {path} are
         * filled in already shell-quoted, so they must be used unquoted.
         */
        worktree_setup: z.string().min(1).optional(),
      })
      .strict()
      .superRefine(checkServices)
      .default({}),
    /** Project facts for the feature workflow; rendered into the generated skill by `projectConfigSection`. */
    workflow: z
      .object({
        chat_language: z.string().trim().min(1).default("English"),
        file_language: z.string().trim().min(1).default("English"),
        /** `restart` may use the `{task}` placeholder. */
        stack: z.object({ restart: z.string().min(1).optional(), status: z.string().min(1).optional() }).strict().optional(),
        e2e: z
          .object({
            stage2: z.string().min(1).optional(),
            stage3: z.string().min(1).optional(),
            stage4: z.string().min(1).optional(),
            baseline: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        migration: z
          .object({
            tool: z.string().min(1).optional(),
            table: z.string().min(1).optional(),
            prod_migrates_on_start: z.boolean().optional(),
          })
          .strict()
          .optional(),
        prod_read: z.string().min(1).optional(),
        browser: z.object({ urls: z.array(z.string().min(1)).optional(), login_note: z.string().min(1).optional() }).strict().optional(),
        banned_words: z.array(z.string().min(1)).optional(),
        never_commit: z.array(z.string().min(1)).optional(),
        read_first: z.array(z.string().min(1)).optional(),
        report_words: z
          .object({ done: z.string().trim().min(1).default("done"), blocked: z.string().trim().min(1).default("blocked") })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    herdr: z
      .object({
        main_tab_label: z.string().trim().min(1).default("main"),
        close_tab_on_done: z.boolean().default(true),
        close_worker_pane_on_end: z.boolean().default(true),
        poll_interval: durationAtLeast("100ms").default("2s"),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

export function configPaths(root: string, env: Env = process.env): { user: string; project: string } {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return { user: join(base, "agentthread", "config.yaml"), project: join(root, ".agentthread", "config.yaml") };
}

export function loadConfig(root: string, env: Env = process.env): Config {
  const p = configPaths(root, env);
  const parsed = ConfigSchema.safeParse(deepMerge(readYaml(p.user), readYaml(p.project)));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid config (${p.user}, ${p.project}): ${issues}`);
  }
  return parsed.data;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value;
  }
  return out;
}

export function readYaml(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let value: unknown;
  try {
    value = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (value === null || value === undefined) return {};
  if (!isPlainObject(value)) throw new Error(`${file} must contain a YAML mapping`);
  return value;
}

/** JSON with object keys sorted at every level, so equal configs always serialize the same way. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isPlainObject(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The sha256 of the parsed config's canonical JSON: `agt start` compares it with the running daemon's. */
export function configHash(config: Config): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

export function durationMs(d: string): number {
  const m = /^(\d+)(ms|[smhd])$/.exec(d);
  if (!m) throw new Error(`invalid duration ${d}`);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "ms" | "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}
