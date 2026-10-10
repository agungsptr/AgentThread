import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { AGENT_KINDS } from "../domain/types.ts";

type Env = Record<string, string | undefined>;

const duration = z.string().regex(/^\d+[smhd]$/, "duration must look like 30s, 5m, 24h or 2d");
const agent = z.enum(AGENT_KINDS);
export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const;

export const ConfigSchema = z
  .object({
    language: z.enum(["en"]).default("en"),
    agents: z
      .object({
        main_manager: agent.default("claude-code"),
        default_coordinator: agent.default("claude-code"),
        default_worker: agent.default("claude-code"),
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
      .default({}),
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
          })
          .strict()
          .default({}),
        handoff: z
          .object({ timeout: duration.default("5m"), fallback_generate: z.boolean().default(true) })
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

function readYaml(file: string): Record<string, unknown> {
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

export function durationMs(d: string): number {
  const m = /^(\d+)([smhd])$/.exec(d);
  if (!m) throw new Error(`invalid duration ${d}`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}
