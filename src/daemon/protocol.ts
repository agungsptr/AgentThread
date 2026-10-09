export type Request =
  | { op: "ping" }
  | { op: "shutdown" }
  | { op: "layout.get" }
  | { op: "events.since"; seq: number }
  | { op: "command"; command: unknown; actor: unknown };

export type Response = { ok: true; result: unknown } | { ok: false; error: string };
