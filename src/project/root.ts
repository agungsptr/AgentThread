import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findRoot(start: string, env: Record<string, string | undefined> = process.env): string {
  if (env.AGT_ROOT) return resolve(env.AGT_ROOT);
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".agentthread", "state.db"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("not inside an AgentThread project (run `agt init`)");
    dir = parent;
  }
}
