import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findRoot(start: string, env: Record<string, string | undefined> = process.env): string {
  if (env.AGT_ROOT) {
    const r = resolve(env.AGT_ROOT);
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  }
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".agentthread", "state.db"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("not inside an AgentThread project (run `agt init`)");
    dir = parent;
  }
}
