export const USAGE = `usage: agt <command>

  init [--name <name>]
  setup                      choose agent, model and effort per role, and complexity tiers
  start [--no-manager]       set up the Herdr layout and run the main manager (inside a Herdr pane)
  daemon start|stop|status
  config
  thread new <title...> --type feature|bug|chore [--goal <text>] [--criteria <text>]... [--depends <id>]... [--max-workers <n>] [--task <name>]
             [--tier <name> --reason <why> [--now]]
  thread choose <id> --tier <name>
  thread cancel <id>
  thread status <id> <status> [--reason <text>]
  ticket add <thread> <title...> --scope <path> [--scope <path>]...            (a legacy thread)
  ticket add <thread> <title...> --repo <repo> --file <path> [--file <path>]... [--doc <path>]   (a task thread; --file takes files, not directories)
  ticket files <thread>/<ticket>   the repo-relative files the ticket may change
  ticket claim|reopen <thread>/<ticket>
  ticket done <thread>/<ticket> --summary <text>   (a task thread: the ticket goes to review)
  ticket accept <thread>/<ticket>                  the reviewed ticket is done; its worker ends
  ticket return <thread>/<ticket> <what to fix...>   back to its worker (or a fresh one) with the note
  ticket block <thread>/<ticket> --reason <text>
  stage <thread> <1-10> done|skipped|na|approve [--reason <why>] [--by user]   record a task thread's stage (skipped and na need a reason; approve is stage 7, --by user)
  stack acquire <thread> [--for e2e4]   take the workspace stack lock, or queue for it (e2e4 needs the user's stage-7 approval)
  stack release <thread>                give the lock back (or leave its queue); the next in the queue gets it
  stack status                          who holds the lock and who waits
  log <thread> <message...>
  decide <thread> <message...>
  note <thread> <message...>
  progress <thread> <message...>
  question <thread> <message...>
  answer <thread> <Q> <text...>
  handoff <thread> (--file <path> | --stdin)
  worker spawn <thread> --ticket <T> [--agent claude-code|opencode|codex|omp]
  worktree add <thread> <repo> [--from <branch>]   a task worktree .worktrees/<task>/<repo> on wip/<task>
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
