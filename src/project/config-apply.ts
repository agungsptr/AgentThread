import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMap, isScalar, parse, parseDocument, stringify } from "yaml";
import { ConfigSchema, configHash, configPaths, deepMerge, loadConfig, readYaml, type Config } from "../config/config.ts";
import { refreshRootSkill } from "../agents/skill.ts";
import { writeStackMakefiles } from "../stack/makefile.ts";
import { writeBannedWords } from "../render/write.ts";

type Env = Record<string, string | undefined>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Service env values may be secrets: shown as *** in `config show` and in the apply diff (keys stay). */
export function redactEnv(v: unknown): unknown {
  if (!isObj(v)) return v;
  const ws = v.workspace;
  if (!isObj(ws) || !isObj(ws.services)) return v;
  const services = ws.services;
  const redacted = Object.fromEntries(Object.entries(services).map(([n, svc]) => [n, isObj(svc) && isObj(svc.env) ? { ...svc, env: Object.fromEntries(Object.keys(svc.env).map((k) => [k, "***"])) } : svc]));
  return { ...v, workspace: { ...ws, services: redacted } };
}

/** `agt config show`: the effective config and the files its layers came from. */
export function showConfig(root: string, env: Env, json: boolean): string {
  const p = configPaths(root, env);
  const config = loadConfig(root, env);
  const sources = { user: { path: p.user, exists: existsSync(p.user) }, project: { path: p.project, exists: existsSync(p.project) } };
  if (json) return JSON.stringify({ config: redactEnv(config), sources }, null, 2);
  const note = (n: string, s: { path: string; exists: boolean }) => `# ${n}: ${s.path}${s.exists ? "" : " (not present)"}`;
  return `${note("user config", sources.user)}\n${note("project config", sources.project)}\n${stringify(redactEnv(config)).trimEnd()}`;
}

/**
 * Warnings about a workspace config: a configured copy entry tracked by git in the main checkout (agt marks the
 * worktree's copy skip-worktree), and browser URLs on localhost whose port no service listens on.
 */
export function workspaceWarnings(root: string, config: Config): string[] {
  const out: string[] = [];
  for (const [name, repo] of Object.entries(config.workspace.repos ?? {})) {
    const dir = resolve(root, repo.path);
    for (const entry of repo.copy ?? []) {
      const r = Bun.spawnSync(["git", "-C", dir, "ls-files", "--", entry], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode === 0 && r.stdout.toString().trim() !== "") out.push(`copy ${name}/${entry} is tracked by git: agt marks it skip-worktree in each worktree`);
    }
  }
  const ports = new Set(Object.values(config.workspace.services ?? {}).flatMap((s) => (s.enabled && s.port !== undefined ? [s.port] : [])));
  if (ports.size) {
    for (const url of config.workflow.browser?.urls ?? []) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        continue;
      }
      if (!["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(u.hostname)) continue;
      const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
      if (!ports.has(port)) out.push(`workflow.browser.urls ${url}: port ${port} matches no service port (${[...ports].join(", ")})`);
    }
  }
  return out;
}

/** Leaf paths of a plain-object tree (arrays and scalars are leaves). */
function flatten(v: unknown, prefix = "", out: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (isObj(v) && Object.keys(v).length > 0) for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  else if (prefix) out.set(prefix, v);
  return out;
}

const show = (v: unknown): string => JSON.stringify(v);

/** Lines of the diff between two project-file contents: `+ path: new`, `- path: old`, `~ path: old -> new`. */
export function diffConfig(before: unknown, after: unknown): string[] {
  const a = flatten(before);
  const b = flatten(after);
  const lines: string[] = [];
  for (const [k, v] of b) {
    if (!a.has(k)) lines.push(`+ ${k}: ${show(v)}`);
    else if (show(a.get(k)) !== show(v)) lines.push(`~ ${k}: ${show(a.get(k))} -> ${show(v)}`);
  }
  for (const [k, v] of a) if (!b.has(k)) lines.push(`- ${k}: ${show(v)}`);
  // A service env value may be a secret: the line keeps the key and the kind of change, never the value.
  const masked = lines.map((l) => (/^[+~-] workspace\.services\.[^.]+\.env\./.test(l) ? `${l.slice(0, l.indexOf(": "))}: ***` : l));
  return masked.sort((x, y) => x.slice(2).localeCompare(y.slice(2)));
}

/** Drops null keys from objects (not arrays), recursively. */
function prune(v: unknown): unknown {
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, prune(x)]));
}

/** Merges the patch into the YAML document in place, keeping its comments. A null value removes the key. */
function mergeInto(doc: ReturnType<typeof parseDocument>, path: string[], patch: Obj): void {
  for (const [k, v] of Object.entries(patch)) {
    const at = [...path, k];
    if (v === null) doc.deleteIn(at);
    else if (isObj(v) && isMap(doc.getIn(at))) mergeInto(doc, at, v);
    else if (isObj(v) && !isMap(doc.getIn(at))) {
      const kept = prune(v) as Obj;
      if (Object.keys(kept).length > 0) doc.setIn(at, doc.createNode(kept));
    } else {
      // A scalar edited in place keeps its trailing comment.
      const cur = doc.getIn(at, true);
      if (isScalar(cur) && (v === null || typeof v !== "object")) cur.value = v;
      else doc.setIn(at, doc.createNode(v));
    }
  }
}

export type ApplyResult = { ok: false; errors: string[] } | { ok: true; diff: string[]; written: boolean; hashChanged: boolean; warnings: string[]; refreshError?: string };

/**
 * `agt config apply`: merges a partial project config into .agentthread/config.yaml, validates the merged result with
 * the schema, and (unless dryRun) writes it and runs `refresh` (banned-words, root skills).
 */
export function applyConfig(o: {
  root: string;
  env: Env;
  text: string;
  dryRun?: boolean;
  refresh?: (root: string, config: Config, env: Env) => void;
}): ApplyResult {
  const fail = (...errors: string[]): ApplyResult => ({ ok: false, errors });
  let patch: unknown;
  try {
    patch = parse(o.text);
  } catch (e) {
    return fail(`input: cannot parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObj(patch)) return fail("input: must be a YAML or JSON mapping (a partial project config)");

  const p = configPaths(o.root, o.env);
  const existing = existsSync(p.project) ? readFileSync(p.project, "utf8") : "";
  const doc = parseDocument(existing);
  if (doc.errors.length) return fail(`${p.project}: cannot parse: ${doc.errors[0]!.message}`);
  if (doc.contents == null) (doc as { contents: unknown }).contents = doc.createNode({});
  if (!isMap(doc.contents)) return fail(`${p.project}: must contain a YAML mapping`);
  const beforeJson = doc.toJSON() as Obj;

  let user: Obj;
  let oldHash: string | undefined;
  try {
    user = readYaml(p.user);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  try {
    oldHash = configHash(loadConfig(o.root, o.env));
  } catch {
    oldHash = undefined;
  }

  mergeInto(doc, [], patch);
  const afterJson = doc.toJSON() as Obj;
  const parsed = ConfigSchema.safeParse(deepMerge(user, afterJson));
  if (!parsed.success) return fail(...parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));

  const diff = diffConfig(beforeJson, afterJson);
  const hashChanged = oldHash !== configHash(parsed.data);
  const warnings = workspaceWarnings(o.root, parsed.data);
  if (o.dryRun) return { ok: true, diff, written: false, hashChanged, warnings };
  mkdirSync(dirname(p.project), { recursive: true });
  const tmp = `${p.project}.tmp`;
  writeFileSync(tmp, doc.toString());
  renameSync(tmp, p.project);
  try {
    (o.refresh ?? defaultRefresh)(o.root, parsed.data, o.env);
  } catch (e) {
    return { ok: true, diff, written: true, hashChanged, warnings, refreshError: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, diff, written: true, hashChanged, warnings };
}

/** The same refresh `agt setup` and `agt init` run after writing the config. */
function defaultRefresh(root: string, config: Config, env: Env): void {
  writeBannedWords(root, config);
  writeStackMakefiles(root, config);
  refreshRootSkill(root, env);
}
