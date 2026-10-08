import type { ThreadStatus, TicketStatus } from "./types.ts";

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "thread";
}

export function normalizePath(p: string): string {
  const s = p.trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return s === "" ? "." : s;
}

export function pathsOverlap(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  if (x === "." || y === ".") return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => pathsOverlap(x, y)));
}

const THREAD_TRANSITIONS: Record<ThreadStatus, ThreadStatus[]> = {
  open: ["in_progress", "blocked"],
  in_progress: ["blocked", "review"],
  blocked: ["open", "in_progress"],
  review: ["done", "in_progress"],
  done: [],
};

const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ["in_progress"],
  in_progress: ["done", "blocked"],
  blocked: ["open"],
  done: [],
};

export function canTransitionThread(from: ThreadStatus, to: ThreadStatus): boolean {
  return THREAD_TRANSITIONS[from].includes(to);
}

export function canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

export const HANDOFF_SECTIONS = ["Goal status", "Work done", "Decisions", "Next steps", "Risks"] as const;

export function validateHandoff(markdown: string): { ok: true } | { ok: false; missing: string[] } {
  const sections = new Map<string, string>();
  let current: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1]!.toLowerCase();
      sections.set(current, "");
      continue;
    }
    if (current !== null) sections.set(current, `${sections.get(current)}${line}\n`);
  }
  const missing = HANDOFF_SECTIONS.filter((name) => !(sections.get(name.toLowerCase()) ?? "").trim());
  return missing.length ? { ok: false, missing } : { ok: true };
}
