import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, realpath, stat } from "node:fs/promises";
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

/**
 * Copies the listed files from the main checkout into a new worktree (async, daemon-safe). A source must resolve inside
 * the main checkout and its destination inside the worktree (a symlink leading out is refused); the file mode is kept;
 * an existing destination is never overwritten; a missing source is skipped. Returns one note per entry.
 */
export async function copyIntoWorktree(from: string, to: string, files: string[]): Promise<string[]> {
  const notes: string[] = [];
  const realFrom = await realpath(from);
  const realTo = await realpath(to);
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
    if (!st.isFile()) {
      notes.push(`copy ${f}: skipped (not a file)`);
      continue;
    }
    if (!inside(realTo, await realWithTail(dst))) {
      notes.push(`copy ${f}: refused (destination resolves outside the worktree)`);
      continue;
    }
    try {
      await lstat(dst);
      notes.push(`copy ${f}: skipped (already exists)`);
      continue;
    } catch {}
    try {
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(realSrc, dst, constants.COPYFILE_EXCL);
      await chmod(dst, st.mode & 0o7777);
      notes.push(`copy ${f}: copied`);
    } catch (e) {
      notes.push(`copy ${f}: failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return notes;
}
