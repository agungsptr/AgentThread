import { chmodSync, mkdirSync, statSync } from "node:fs";

/** Creates the per-user socket directory and makes sure nobody else can reach sockets inside it. */
export function ensureSocketDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`socket directory ${dir} is owned by another user`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}
