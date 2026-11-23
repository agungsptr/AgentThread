# Recording a demo

This folder holds a small demo workspace and scripts for recording AgentThread in action. The workspace has two repos,
`api` and `web`, each with one function, unit tests and a tiny HTTP service.

| File | What it is |
|---|---|
| `setup-workspace.sh` | Creates the workspace (default `/tmp/agt-demo`) and configures agt for it |
| `cli.tape` | A [VHS](https://github.com/charmbracelet/vhs) script for a short CLI clip (no agents) |
| `make-gif.sh` | Turns a recording into a README-ready GIF and MP4 in `demo/out/` |

## 1. Install the tools

```sh
brew install asciinema agg vhs ffmpeg
```

## 2. Create the workspace

```sh
demo/setup-workspace.sh                       # or: DEMO_WORKER_AGENT=opencode demo/setup-workspace.sh
```

By default, main and coordinator run Claude Code with `sonnet`, and so do the workers. Fast models keep the run short;
see the variables at the top of the script. With Claude Code as main, open `claude` once in `/tmp/agt-demo` and accept
the trust prompt, so the recording does not start with it.

If you use several Claude accounts, set `agents.env.CLAUDE_CONFIG_DIR` in `/tmp/agt-demo/.agentthread/config.yaml` (or
export `CLAUDE_CONFIG_DIR` before opening Herdr). The setup script writes it for you when the variable is set in the
shell that runs it. Otherwise the agents start on the default `~/.claude` account and ask to log in.

Rehearse once without recording, then reset with `DEMO_FORCE=1 demo/setup-workspace.sh`.

## 3. Record the CLI clip (optional, scripted)

```sh
vhs demo/cli.tape                             # → demo/out/cli.gif
```

## 4. Record the main demo

Prepare the terminal:
- Make the window about 160×45 with a large font and a dark theme.
- Set a short prompt with `export PS1='$ '`.
- Turn on Do Not Disturb.
- Show nothing private: no `.env` files, internal model names or company repos.

Record with asciinema, which keeps the text sharp and makes a small file. Idle gaps are cut to 2 seconds:

```sh
cd /tmp/agt-demo
asciinema rec ~/agt-demo.cast --idle-time-limit 2
herdr                                         # inside the recording
```

Then follow this storyline. A whole run takes about 5 to 10 minutes; the GIF ends up 1 to 2 minutes long.

1. **Start.** In the Herdr pane, run `agt start`. The main manager opens, with the logger pane beside it.
2. **Ask.** Paste this to the main manager:

   > Add a `slugify(s)` function to api (`src/slugify.ts`, with unit tests) and use it in web to show a slug of the page
   > title (`src/title.ts`, with unit tests). Source branch `main`. Keep it small and don't ask me questions.

   Confirm the thread when main proposes it. Later, answer the coordinator in its tab when it asks you something
   (for example, to approve stage 7).
3. **Watch.** A thread tab opens with the coordinator. Tickets appear in the logger, worker panes split in and work,
   and tickets go to review and get accepted. Switch between the main tab and the thread tab once or twice.
4. **Stack.** If the coordinator restarts the stack on the task, run `agt stack status` in a spare pane. It shows the
   services running from `.worktrees/<task>/…`.
5. **Finish.** The coordinator squashes onto `feat/<task>` and waits for you to push. Run
   `git -C .worktrees/*/api log --oneline -2` to show the result, then exit Herdr and asciinema (`exit`).

Make the GIF:

```sh
demo/make-gif.sh cast ~/agt-demo.cast 4       # → demo/out/agt-demo.gif; raise the speed if it's over ~10 MB
```

### Alternative: screen recording (MP4)

Press Cmd+Shift+5, choose "Record Selected Portion" over the terminal, and follow the same storyline. Then run:

```sh
demo/make-gif.sh mov ~/Desktop/Screen\ Recording*.mov 6   # → demo/out/*.mp4 and *.gif
```

## 5. Put it in the README

- **GIF:** copy it to `docs/assets/demo.gif`, then add `![AgentThread demo](docs/assets/demo.gif)` under the README title.
- **MP4:** in GitHub's web editor for README.md, drag the file in. GitHub hosts it and plays it inline.

## Clean up

```sh
cd /tmp/agt-demo && agt daemon stop; agt stack stop; rm -rf /tmp/agt-demo
```

The demo runs real agents, so it uses tokens.
