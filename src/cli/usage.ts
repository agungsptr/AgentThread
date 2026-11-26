export const USAGE = `usage: agt <command>

  init [--name <name>] [--no-setup]   create the project; --no-setup skips the wizard (no prompts, safe from an agent shell; a no-op when already initialised)
  setup                      choose agent, model and effort per role, and complexity tiers
  start [--no-manager]       set up the Herdr layout and run the main manager (inside a Herdr pane)
  stop                       shut agt down: thread and workers tabs, the logger, the workspace stack, the daemon and the main manager (thread state is kept; agt start resumes)
  daemon start|stop|status
  config                     print the effective config
  config show [--json]       the effective config and the files its layers came from
  config apply <file|-> [--dry-run] [--no-restart]   merge a partial YAML/JSON config into .agentthread/config.yaml (repos merge by name; null removes the project-file key only), validate it, print the diff, refresh skills; --dry-run only validates; a changed config restarts a running daemon unless --no-restart
  thread new <title...> --type feature|bug|chore|review|report [--goal <text>] [--criteria <text>]... [--depends <id>]... [--max-workers <n>] [--task <name>] [--browser-check]
             [--tier <name> --reason <why> [--now]]
  thread choose <id> --tier <name>
  thread cancel <id> [--reason <text>]   stop a thread: its agents end, its tab closes, it is done (its worktrees stay)
  thread status <id> <status> [--reason <text>]
  thread browser-check <id>   the user asked for a browser check: stage 8 is required again (undoes agt's "not requested" skip)
  thread report <id> <path> | <id> --check   a review or report thread: record its report (a .md under .docs/), or run the share check on it (no .docs, local paths, thread or ticket ids, banned words)
  thread waiting <id> "<what>"   say the coordinator waits for the user; main is told, and it ends when the user answers
  thread cleanup <id>   a merged (done) task thread: remove its worktrees and wip/<task> branches, in the background (stops on uncommitted changes)
  ticket add <thread> <title...> --scope <path> [--scope <path>]...            (a legacy thread)
  ticket add <thread> <title...> --repo <repo> --file <path> [--file <path>]... [--doc <path>]   (a task thread; --file takes files, not directories)
  ticket files <thread>/<ticket> [--add <path>]... [--remove <path>]...   print the repo-relative files the ticket may change; with --add/--remove the coordinator fixes the list (a task thread, ticket not done; repeat the flag per path); then run ticket reopen for a ticket the commit guard blocked
  ticket claim|reopen <thread>/<ticket>
  ticket done <thread>/<ticket> --summary <text>   (a task thread: the ticket goes to review)
  ticket accept <thread>/<ticket>                  the reviewed ticket is done; its worker ends
  ticket return <thread>/<ticket> <what to fix...>   back to its worker (or a fresh one) with the note
  ticket block <thread>/<ticket> --reason <text>
  stage <thread> <1-10> done|skipped|na|approve [--reason <why>] [--by user]   record a task thread's stage (skipped and na need a reason; approve is stage 7, --by user; a review or report thread has stages 1-4, no approve)
  stack start [--task <slug>|--main] [--only a,b] [--migrate]   start the workspace services (.local-run/); --task runs from .worktrees/<slug>/<repo> where it exists
  stack stop [--only a,b] [--force]     stop them (process group, then a workspace process still holding the port; --force also kills a foreign one)
  stack restart [--task <slug>|--main] [--only a,b] [--migrate]   in the background (agt stack wait blocks until it has finished); --migrate runs each service's migrate, otherwise only with migrate_on_start: true
  stack wait [--timeout <seconds>]      block until the latest restart has finished: exit 0 every service healthy, 1 failed, 2 still restarting at the timeout (default 540s; run it again)
  stack status [--json]                 service | state | port | pid | cwd | branch | target plus the stack lock; --json prints {services, lock}
  stack logs <service> [-f] [-n <lines>]
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
  worker spawn <thread> --ticket <T> [--agent claude-code|opencode|codex|omp|agy]
  worktree add <thread> <repo> [--from <branch>]   a task worktree .worktrees/<task>/<repo> on wip/<task>
  tell <thread|main> <message...>
  tell <thread>/<ticket> <message...>   a task thread's coordinator: the ticket's live worker hears it
  event started|active|idle|compacting|ended   (used by Claude Code hooks)
  event rate-limited --profile <name>   (used by the Claude Code StopFailure hook: the profile hit its usage limit)
  statusline --profile <name> --root <root>   (Claude Code's statusLine command: records the profile's usage, prints one line)
  usage [--json]   several Claude accounts: each profile's 5h and 7d use, resets, last seen and limited mark, and which one new launches use
  guide [main|coordinator|worker|all]   how to use agt in a role (default: $AGT_ROLE, else all)
  logs [-f] [--all]   print the event log as readable lines (HH:MM:SS thread role event summary), hiding heartbeat events; -f follows and survives daemon restarts; --all shows every event
  help [<command>]   this text, or only the lines of one command (also agt <command> --help; -h/--help anywhere before a -- prints help)`;

/** The USAGE line (with its continuation lines) of the command that starts with `prefix`. */
export function usageLines(prefix: string): string[] {
  const all = USAGE.split("\n");
  const i = all.findIndex((l) => l.trim().startsWith(prefix));
  if (i < 0) throw new Error(`no USAGE line for '${prefix}'`);
  const out = [all[i]!.trim()];
  for (let j = i + 1; j < all.length && /^\s{5,}\S/.test(all[j]!); j++) out.push(all[j]!.trim());
  return out;
}

/** The USAGE lines (with continuations) of the command spelled by `words`: `thread new`, `ticket claim`, `stack`. Empty when none match. */
export function helpLines(words: string[]): string[] {
  const all = USAGE.split("\n");
  const [w1, w2] = words;
  if (!w1) return [];
  const matches = (line: string, second: string | undefined) => {
    const t = line.trim().split(/\s+/);
    return t[0] === w1 && (second === undefined || (t[1] ?? "").split("|").includes(second));
  };
  for (const second of w2 ? [w2, undefined] : [undefined]) {
    const out: string[] = [];
    for (let i = 1; i < all.length; i++) {
      if (/^\s{2}\S/.test(all[i]!) && matches(all[i]!, second)) {
        out.push(all[i]!.trim());
        for (let j = i + 1; j < all.length && /^\s{5,}\S/.test(all[j]!); j++) out.push(all[j]!.trim());
      }
    }
    if (out.length) return out;
  }
  return [];
}

/**
 * The text to print for `agt`, `agt --help|-h|help` (all usage) and `agt help <cmd>` / `agt <cmd> --help|-h` (that
 * command's lines, or all usage when none match); undefined when argv is a normal command.
 */
export function helpRequest(argv: string[]): string[] | undefined {
  const full = USAGE.split("\n");
  if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help"))) return full;
  // `--` ends the options: what follows it never asks for help.
  const dd = argv.indexOf("--");
  const opts = dd < 0 ? argv : argv.slice(0, dd);
  const words = (xs: string[]) => xs.filter((a) => !a.startsWith("-")).slice(0, 2);
  let target: string[] | undefined;
  if (argv[0] === "help") target = words(argv.slice(1));
  else if (argv[0] !== "__spawn" && opts.some((a) => a === "--help" || a === "-h")) target = words(opts);
  if (!target) return undefined;
  const lines = helpLines(target);
  return lines.length ? lines : full;
}
