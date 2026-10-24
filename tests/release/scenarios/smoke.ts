import type { EventOf } from "../harness.ts";
import type { Scenario } from "./common.ts";

/** No model calls: `agt start --no-manager` against real Herdr sets up the main tab and the logger pane. */
export function smokeScenarios(): Scenario[] {
  return [
    {
      id: "smoke-layout",
      agents: { main: "claude-code", coordinator: "claude-code", worker: "claude-code" },
      manager: false,
      async run(h) {
        const all = await h.events();
        const layout = all.find((e): e is EventOf<"layout.registered"> => e.type === "layout.registered")!.payload;
        h.check("layout names the isolated socket", layout.herdrSocket === h.server.socket, layout.herdrSocket);
        h.check("layout's manager pane is agt start's pane", layout.managerPane === h.mainPane, layout.managerPane);
        const panes = await h.herdr.panes();
        h.check("logger pane exists", panes.includes(layout.loggerPane), layout.loggerPane);
        const tab = await h.herdr.ok(["tab", "get", layout.mainTab]);
        h.check("main tab renamed", tab.tab.label === "main", tab.tab.label);
        // The logger runs `agt logs -f` (started with herdr pane run) and prints the event log.
        let text = "";
        for (let i = 0; i < 20 && !/layout\.registered/.test(text); i++) {
          await Bun.sleep(500);
          text = await h.herdr.read(layout.loggerPane);
        }
        h.check("logger pane shows the event log", /layout\.registered/.test(text));
        // A second agt start finds the layout and reconciles.
        await h.startAgt(["--no-manager"]);
        let again = "";
        for (let i = 0; i < 30 && !/subthread tabs reconciled/.test(again); i++) {
          await Bun.sleep(500);
          again = await h.herdr.read(h.mainPane, 40);
        }
        h.check("a second agt start reuses the layout", /layout already set up/.test(again) && /subthread tabs reconciled \(0 open threads\)/.test(again));
      },
    },
  ];
}
