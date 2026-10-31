export const USAGE = `usage: agt <command>

  init [--name <name>]
  setup                      choose agent, model and effort per role, and complexity tiers
  start [--no-manager]       set up the Herdr layout and run the main manager (inside a Herdr pane)
  daemon start|stop|status
  config
  thread new <title...> --type feature|bug|chore [--goal <text>] [--criteria <text>]... [--depends <id>]... [--max-workers <n>]
             [--tier <name> --reason <why> [--now]]
  thread choose <id> --tier <name>
  thread cancel <id>
  thread status <id> <status> [--reason <text>]
  ticket add <thread> <title...> --scope <path> [--scope <path>]...
  ticket claim|reopen <thread>/<ticket>
  ticket done <thread>/<ticket> --summary <text>
  ticket block <thread>/<ticket> --reason <text>
  log <thread> <message...>
  decide <thread> <message...>
  note <thread> <message...>
  progress <thread> <message...>
  question <thread> <message...>
  answer <thread> <Q> <text...>
  handoff <thread> (--file <path> | --stdin)
  worker spawn <thread> --ticket <T> [--agent claude-code|opencode|codex|omp]
  tell <thread|main> <message...>
  event started|active|idle|compacting|ended   (used by Claude Code hooks)
  guide [main|coordinator|worker|all]   how to use agt in a role (default: $AGT_ROLE, else all)
  logs [-f]`;

/** The USAGE line (with its continuation lines) of the command that starts with `prefix`. */
export function usageLines(prefix: string): string[] {
  const all = USAGE.split("\n");
  const i = all.findIndex((l) => l.trim().startsWith(prefix));
  if (i < 0) throw new Error(`no USAGE line for '${prefix}'`);
  const out = [all[i]!.trim()];
  for (let j = i + 1; j < all.length && /^\s{5,}\S/.test(all[j]!); j++) out.push(all[j]!.trim());
  return out;
}
