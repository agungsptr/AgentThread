#!/usr/bin/env bash
# Creates a small two-repo demo workspace (api + web) configured for agt, for recording a demo.
#
#   demo/setup-workspace.sh [dir]          default dir: /tmp/agt-demo
#
# Environment (optional):
#   DEMO_MAIN_AGENT    agent for main and coordinator   (default claude-code)
#   DEMO_MAIN_MODEL    their model                      (default sonnet)
#   DEMO_WORKER_AGENT  agent for workers                (default claude-code)
#   DEMO_WORKER_MODEL  worker model                     (default sonnet; empty = the agent's default)
#   DEMO_FORCE=1       delete an existing demo dir first
set -euo pipefail

DIR="${1:-/tmp/agt-demo}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MAIN_AGENT="${DEMO_MAIN_AGENT:-claude-code}"
MAIN_MODEL="${DEMO_MAIN_MODEL:-sonnet}"
WORKER_AGENT="${DEMO_WORKER_AGENT:-claude-code}"
WORKER_MODEL="${DEMO_WORKER_MODEL-sonnet}"

for cmd in bun git agt; do
  command -v "$cmd" >/dev/null || { echo "missing: $cmd" >&2; exit 1; }
done

if [ -e "$DIR" ]; then
  if [ "${DEMO_FORCE:-}" = "1" ]; then
    (cd "$DIR" && agt daemon stop >/dev/null 2>&1 || true; agt stack stop >/dev/null 2>&1 || true)
    rm -rf "$DIR"
  else
    echo "$DIR already exists; rerun with DEMO_FORCE=1 to recreate it" >&2
    exit 1
  fi
fi

mkdir -p "$DIR"
for repo in api web; do
  cp -R "$HERE/workspace/$repo" "$DIR/$repo"
  for t in "$DIR/$repo"/tests/*.tmpl; do mv "$t" "${t%.tmpl}"; done
  (
    cd "$DIR/$repo"
    git init -q -b main
    git add -A
    git -c user.name=demo -c user.email=demo@example.com commit -qm "chore: initial $repo"
  )
done

worker_model_line=""
[ -n "$WORKER_MODEL" ] && worker_model_line="model: $WORKER_MODEL, "

cd "$DIR"
agt init --no-setup >/dev/null
cat > .agentthread/demo-config.yaml <<EOF
agents:
  roles:
    main:        { agent: $MAIN_AGENT, model: $MAIN_MODEL, effort: medium }
    coordinator: { agent: $MAIN_AGENT, model: $MAIN_MODEL, effort: medium }
    worker:      { agent: $WORKER_AGENT, ${worker_model_line}effort: medium }
workspace:
  repos:
    api:
      path: api
      source_branch: main
      prod_branch: main
      pr_order: 1
      unit: bun test
      typecheck: bun run typecheck
      install: ""
    web:
      path: web
      source_branch: main
      prod_branch: main
      pr_order: 2
      unit: bun test
      typecheck: bun run typecheck
      install: ""
  services:
    api:
      repo: api
      start: bun serve.ts
      port: 4101
      env: { PORT: "4101" }
      health: http://localhost:4101/
    web:
      repo: web
      start: bun serve.ts
      port: 4102
      env: { PORT: "4102" }
      health: http://localhost:4102/
      after: [api]
workflow:
  chat_language: English
  file_language: English
  browser:
    urls: [http://localhost:4102/]
EOF
agt config apply .agentthread/demo-config.yaml --no-restart

cat <<EOF

Demo workspace ready: $DIR
  repos:    api (port 4101), web (port 4102)
  agents:   main/coordinator $MAIN_AGENT ($MAIN_MODEL), worker $WORKER_AGENT${WORKER_MODEL:+ ($WORKER_MODEL)}

Next: open Claude Code once in $DIR and accept the trust prompt (if main is claude-code),
then follow demo/README.md to record.
EOF
