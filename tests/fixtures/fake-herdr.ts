#!/usr/bin/env bun
// Test double for the herdr CLI. State lives in the JSON file named by $FAKE_HERDR_STATE.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface FakeState {
  next: number;
  tabs: string[];
  panes: string[];
  calls: string[][];
}

const file = process.env.FAKE_HERDR_STATE;
if (!file) {
  console.error(JSON.stringify({ error: { code: "fake_misconfigured", message: "FAKE_HERDR_STATE not set" } }));
  process.exit(1);
}
const state: FakeState = existsSync(file)
  ? { next: 0, tabs: [], panes: [], calls: [], ...JSON.parse(readFileSync(file, "utf8")) }
  : { next: 0, tabs: [], panes: [], calls: [] };
const args = process.argv.slice(2);
state.calls.push(args);

function ok(result: unknown): never {
  writeFileSync(file!, JSON.stringify(state));
  console.log(JSON.stringify({ id: "fake", result }));
  process.exit(0);
}

function fail(code: string, message: string): never {
  writeFileSync(file!, JSON.stringify(state));
  console.error(JSON.stringify({ error: { code, message } }));
  process.exit(1);
}

const [group, sub, target] = args;

if (group === "tab" && sub === "create") {
  const n = ++state.next;
  const tab = `w1:t${n}`;
  const pane = `w1:p${n}`;
  state.tabs.push(tab);
  state.panes.push(pane);
  ok({ type: "tab_created", tab: { tab_id: tab }, root_pane: { pane_id: pane } });
}
if (group === "tab" && sub === "get") {
  if (!state.tabs.includes(target ?? "")) fail("tab_not_found", `tab ${target} not found`);
  ok({ type: "tab_info", tab: { tab_id: target } });
}
if (group === "tab" && sub === "close") {
  if (!state.tabs.includes(target ?? "")) fail("tab_not_found", `tab ${target} not found`);
  state.tabs = state.tabs.filter((t) => t !== target);
  ok({ type: "ok" });
}
if (group === "pane" && sub === "split") {
  const n = ++state.next;
  const pane = `w1:p${n}`;
  state.panes.push(pane);
  ok({ type: "pane_split", pane: { pane_id: pane } });
}
ok({ type: "ok" });
