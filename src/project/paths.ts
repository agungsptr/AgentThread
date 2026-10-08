import { tmpdir } from "node:os";
import { join } from "node:path";

export function paths(root: string) {
  const dir = join(root, ".agentthread");
  const threadsDir = join(dir, "threads");
  return {
    root,
    dir,
    db: join(dir, "state.db"),
    // macOS limits Unix socket paths to ~104 bytes, so the socket lives in the temp dir keyed by root.
    socket: join(tmpdir(), `agt-${Bun.hash(root).toString(16)}.sock`),
    daemonLog: join(dir, "daemon.log"),
    mainThread: join(dir, "main.thread.md"),
    threadsDir,
    threadDir: (t: { id: string; slug: string }) => join(threadsDir, `${t.id}-${t.slug}`),
  };
}
