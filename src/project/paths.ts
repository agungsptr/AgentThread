import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

function canonical(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

export function paths(root: string) {
  const dir = join(root, ".agentthread");
  const threadsDir = join(dir, "threads");
  return {
    root,
    dir,
    db: join(dir, "state.db"),
    // macOS limits Unix socket paths to ~104 bytes, so the socket lives in /tmp (not $TMPDIR, which differs per caller) keyed by root.
    socketDir: `/tmp/agt-${process.getuid?.() ?? 0}`,
    socket: `/tmp/agt-${process.getuid?.() ?? 0}/${Bun.hash(canonical(root)).toString(16)}.sock`,
    daemonLog: join(dir, "daemon.log"),
    mainThread: join(dir, "main.thread.md"),
    threadsDir,
    threadDir: (t: { id: string; slug: string }) => join(threadsDir, `${t.id}-${t.slug}`),
  };
}
