import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, realpath, stat, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const inside = (base: string, p: string): boolean => {
  const r = relative(base, p);
  return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
};

/** The real path of the nearest existing ancestor of p, with the missing tail appended. */
async function realWithTail(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return resolve(await realpath(cur), ...tail.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      tail.push(cur.slice(up.length + 1));
      cur = up;
    }
  }
}

async function gitAsync(dir: string, args: string[], stdin?: string): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", stdin: stdin === undefined ? "ignore" : new Blob([stdin]) });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { ok: code === 0, out, err };
}

/** The most files one directory copy will take; a bigger one (node_modules by mistake) is refused. */
export const MAX_COPY_FILES = 5000;

/** Every regular file under dir (relative, "/"-separated); symlinks inside are not followed and not returned. Stops past `limit`. */
async function walkFiles(dir: string, limit = MAX_COPY_FILES, rel = "", acc = { files: [] as string[], skipped: 0, over: false }): Promise<typeof acc> {
  for (const e of await readdir(resolve(dir, rel), { withFileTypes: true })) {
    if (acc.over) break;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walkFiles(dir, limit, r, acc);
    else if (e.isFile()) {
      acc.files.push(r);
      if (acc.files.length > limit) acc.over = true;
    } else acc.skipped++;
  }
  return acc;
}

/**
 * Copies the listed files and directories from the main checkout into a new worktree (async, daemon-safe). A source must
 * resolve inside the main checkout and its destination inside the worktree (a symlink leading out is refused; symlinks
 * inside a copied directory are skipped); the file mode is kept; an existing destination is never overwritten, except
 * a git-tracked file the worktree holds unmodified (the checkout's own version), which is replaced by the local copy and
 * then marked `git update-index --skip-worktree`, so it never shows in `git status` nor gets staged. A missing source is
 * skipped. Returns one note per entry and the files it copied (a directory expands to its files).
 */
export async function copyIntoWorktree(from: string, to: string, files: string[]): Promise<{ notes: string[]; copied: string[]; skipWorktree: string[] }> {
  const notes: string[] = [];
  const copied: string[] = [];
  const skipWorktree: string[] = [];
  const realFrom = await realpath(from);
  const realTo = await realpath(to);

  /** Per copy entry: what the worktree's git says about the paths under it (one `ls-files -v`, one `diff`). */
  type Info = { tracked: Set<string>; skip: Set<string>; modified: Set<string> };
  const inspect = async (entry: string): Promise<Info> => {
    const info: Info = { tracked: new Set(), skip: new Set(), modified: new Set() };
    const ls = await gitAsync(to, ["ls-files", "-z", "-v", "--", entry]);
    if (ls.ok) {
      for (const rec of ls.out.split("\0")) {
        if (rec.length < 3) continue;
        info.tracked.add(rec.slice(2));
        if (rec[0] === "S" || rec[0] === "s") info.skip.add(rec.slice(2));
      }
    }
    if (info.tracked.size) {
      const d = await gitAsync(to, ["diff", "--name-only", "-z", "HEAD", "--", entry]);
      if (d.ok) for (const x of d.out.split("\0")) if (x) info.modified.add(x);
    }
    return info;
  };

  /** Copies one file; returns "copied" or the reason it was not. */
  const copyOne = async (rel: string, realSrc: string, info: Info, mark: string[]): Promise<string> => {
    const dst = resolve(to, rel);
    if (!inside(to, dst) || !inside(realTo, await realWithTail(dst))) return "refused (destination resolves outside the worktree)";
    const st = await stat(realSrc);
    const exists = await lstat(dst).then(() => true, () => false);
    if (exists) {
      // Only the checkout's own, unmodified version of a tracked file may be replaced; never one already marked skip-worktree.
      if (!info.tracked.has(rel) || info.skip.has(rel) || info.modified.has(rel)) return "skipped (already exists)";
      if (Buffer.from(await Bun.file(dst).bytes()).equals(Buffer.from(await Bun.file(realSrc).bytes()))) return "skipped (already exists)";
    }
    try {
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(realSrc, dst, exists ? 0 : constants.COPYFILE_EXCL);
      await chmod(dst, st.mode & 0o7777);
    } catch (e) {
      return `failed (${e instanceof Error ? e.message : String(e)})`;
    }
    const out = relative(to, dst).split(sep).join("/");
    copied.push(out);
    if (info.tracked.has(out)) mark.push(out);
    return "copied";
  };

  const markAll = async (mark: string[]) => {
    if (!mark.length) return;
    const r = await gitAsync(to, ["update-index", "--skip-worktree", "-z", "--stdin"], mark.join("\0") + "\0");
    if (r.ok) skipWorktree.push(...mark);
    else notes.push(`copy ${mark[0]}: could not mark skip-worktree (${r.err.trim()})`);
  };

  for (const raw of files) {
    const f = raw.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    const src = resolve(from, f);
    const dst = resolve(to, f);
    if (!inside(from, src) || !inside(to, dst)) {
      notes.push(`copy ${f}: refused (outside the repo)`);
      continue;
    }
    let realSrc: string;
    try {
      realSrc = await realpath(src);
    } catch {
      notes.push(`copy ${f}: skipped (not in the main checkout)`);
      continue;
    }
    if (!inside(realFrom, realSrc)) {
      notes.push(`copy ${f}: refused (resolves outside the repo)`);
      continue;
    }
    const st = await stat(realSrc);
    if (st.isFile()) {
      const mark: string[] = [];
      notes.push(`copy ${f}: ${await copyOne(f, realSrc, await inspect(f), mark)}`);
      await markAll(mark);
    } else if (st.isDirectory()) {
      const { files: list, skipped, over } = await walkFiles(realSrc);
      if (over) {
        notes.push(`copy ${f}: refused (more than ${MAX_COPY_FILES} files; copy the files you need, or use link)`);
        continue;
      }
      const info = await inspect(f);
      const mark: string[] = [];
      const tally = new Map<string, number>();
      for (const sub of list) {
        const rel = `${f}/${sub}`;
        const real = await realpath(resolve(realSrc, sub));
        const r = inside(realFrom, real) ? await copyOne(rel, real, info, mark) : "refused (resolves outside the repo)";
        const k = r.split(" ")[0]!;
        tally.set(k, (tally.get(k) ?? 0) + 1);
      }
      await markAll(mark);
      notes.push(`copy ${f}: directory, ${[...tally].map(([k, n]) => `${n} ${k}`).join(", ") || "empty"}${skipped ? `, ${skipped} symlink/special entries skipped` : ""}`);
    } else notes.push(`copy ${f}: skipped (not a file or directory)`);
  }
  return { notes, copied, skipWorktree };
}

const LOCKFILES = ["bun.lockb", "bun.lock", "yarn.lock", "pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json"];

/** The lockfile names whose content differs between two checkouts (a lockfile in only one of them differs). */
export async function lockfilesDiffer(a: string, b: string): Promise<string[]> {
  const read = async (dir: string, f: string) => {
    try {
      return Buffer.from(await Bun.file(resolve(dir, f)).bytes());
    } catch {
      return null;
    }
  };
  const out: string[] = [];
  for (const f of LOCKFILES) {
    const [x, y] = [await read(a, f), await read(b, f)];
    if ((x === null) !== (y === null) || (x !== null && y !== null && !x.equals(y))) out.push(f);
  }
  return out;
}

/**
 * Symlinks the listed directories of the main checkout into the worktree (instead of copying them). Same safety as copy:
 * the source must be a directory resolving inside the main checkout, the destination inside the worktree; an existing
 * destination is left alone. Returns one note per entry and the links made.
 */
export async function linkIntoWorktree(from: string, to: string, names: string[]): Promise<{ notes: string[]; linked: string[] }> {
  const notes: string[] = [];
  const linked: string[] = [];
  const realFrom = await realpath(from);
  const realTo = await realpath(to);
  for (const raw of names) {
    const f = raw.replace(/\/+$/, "");
    const src = resolve(from, f);
    const dst = resolve(to, f);
    if (!inside(from, src) || !inside(to, dst)) {
      notes.push(`link ${f}: refused (outside the repo)`);
      continue;
    }
    let realSrc: string;
    try {
      realSrc = await realpath(src);
    } catch {
      notes.push(`link ${f}: skipped (not in the main checkout)`);
      continue;
    }
    if (!inside(realFrom, realSrc)) {
      notes.push(`link ${f}: refused (resolves outside the repo)`);
      continue;
    }
    if (!(await stat(realSrc)).isDirectory()) {
      notes.push(`link ${f}: skipped (not a directory)`);
      continue;
    }
    try {
      await lstat(dst);
      notes.push(`link ${f}: skipped (already exists)`);
      continue;
    } catch {}
    if (!inside(realTo, await realWithTail(dst))) {
      notes.push(`link ${f}: refused (destination resolves outside the worktree)`);
      continue;
    }
    try {
      await mkdir(dirname(dst), { recursive: true });
      await symlink(realSrc, dst, "dir");
      notes.push(`link ${f}: linked`);
      linked.push(relative(to, dst).split(sep).join("/"));
    } catch (e) {
      notes.push(`link ${f}: failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { notes, linked };
}

/** An anchored gitignore pattern for a path relative to the worktree root. */
export const anchoredExclude = (rel: string): string => `/${rel.replace(/^[!#]|[\\*?[\] ]/g, (c) => `\\${c}`)}`;

/** Credential-looking text removed from a log excerpt. */
export const redactSecrets = (s: string): string =>
  s
    .replace(/(:\/\/)[^\s/@]*@/g, "$1***@")
    .replace(/(_authToken\s*=\s*)\S+/gi, "$1***")
    .replace(/\b(token|password|passwd|secret|api[_-]?key)(\s*[=:]\s*)[^\s&"']+/gi, "$1$2***");


/**
 * The one guard before any install into a worktree: when its node_modules is a symlink (a `link`), an install would write
 * into the main checkout's. Same lockfiles as the main checkout: skip the install. Different: remove the symlink so the
 * install fills a real directory. Returns whether to skip, and a note when it did something.
 */
export async function guardLinkedInstall(mainDir: string, worktreeDir: string): Promise<{ skip: boolean; note?: string }> {
  const nm = resolve(worktreeDir, "node_modules");
  const link = await lstat(nm).then((l) => l.isSymbolicLink(), () => false);
  if (!link) return { skip: false };
  const differs = await lockfilesDiffer(mainDir, worktreeDir);
  if (!differs.length) return { skip: true, note: "node_modules is linked to the main checkout and the lockfile matches: install skipped" };
  await unlink(nm);
  return { skip: false, note: `node_modules was linked but ${differs.join(", ")} differs from the main checkout: link removed, installing into a real node_modules` };
}
