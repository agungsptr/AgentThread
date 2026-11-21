import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, realpath, stat, symlink } from "node:fs/promises";
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

const gitRun = (dir: string, args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
const isTracked = (dir: string, rel: string): boolean => gitRun(dir, ["ls-files", "--error-unmatch", "--", rel]).exitCode === 0;

/** Every regular file under dir (relative, "/"-separated); symlinks inside are not followed and not returned. */
async function walkFiles(dir: string, rel = ""): Promise<{ files: string[]; skipped: number }> {
  const files: string[] = [];
  let skipped = 0;
  for (const e of await readdir(resolve(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const sub = await walkFiles(dir, r);
      files.push(...sub.files);
      skipped += sub.skipped;
    } else if (e.isFile()) files.push(r);
    else skipped++;
  }
  return { files, skipped };
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

  /** Copies one file; returns "copied" or the reason it was not. */
  const copyOne = async (rel: string, realSrc: string): Promise<string> => {
    const dst = resolve(to, rel);
    if (!inside(to, dst) || !inside(realTo, await realWithTail(dst))) return "refused (destination resolves outside the worktree)";
    const st = await stat(realSrc);
    const exists = await lstat(dst).then(() => true, () => false);
    if (exists) {
      // Only the checkout's own, unmodified version of a tracked file may be replaced.
      if (!isTracked(to, rel) || gitRun(to, ["diff", "--quiet", "HEAD", "--", rel]).exitCode !== 0) return "skipped (already exists)";
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
    if (isTracked(to, out)) {
      const r = gitRun(to, ["update-index", "--skip-worktree", "--", out]);
      if (r.exitCode === 0) skipWorktree.push(out);
      else notes.push(`copy ${rel}: could not mark skip-worktree (${r.stderr.toString().trim()})`);
    }
    return "copied";
  };

  for (const f of files) {
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
      notes.push(`copy ${f}: ${await copyOne(f.replace(/\/+$/, ""), realSrc)}`);
    } else if (st.isDirectory()) {
      const { files: list, skipped } = await walkFiles(realSrc);
      const tally = new Map<string, number>();
      for (const sub of list) {
        const rel = `${f.replace(/\/+$/, "")}/${sub}`;
        const real = await realpath(resolve(realSrc, sub));
        const r = inside(realFrom, real) ? await copyOne(rel, real) : "refused (resolves outside the repo)";
        const k = r.split(" ")[0]!;
        tally.set(k, (tally.get(k) ?? 0) + 1);
      }
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
