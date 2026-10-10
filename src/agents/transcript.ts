import { closeSync, openSync, readSync, statSync } from "node:fs";

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Context size of the last assistant turn in a Claude Code transcript; undefined when it cannot be read quickly. */
export function contextTokensFromTranscript(path: string, maxBytes = 262_144): number | undefined {
  let text: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) return undefined;
    const size = st.size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    text = buf.toString("utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    let entry: { type?: string; isSidechain?: boolean; message?: { usage?: Usage } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line of the window may be cut in half
    }
    const u = entry.message?.usage;
    if (entry.type !== "assistant" || entry.isSidechain === true || !u) continue;
    const input = u.input_tokens;
    const read = u.cache_read_input_tokens;
    const created = u.cache_creation_input_tokens;
    if (!isCount(input) || !(read === undefined || isCount(read)) || !(created === undefined || isCount(created))) continue;
    const total = input + (read ?? 0) + (created ?? 0);
    if (Number.isSafeInteger(total) && total > 0) return total;
  }
  return undefined;
}
