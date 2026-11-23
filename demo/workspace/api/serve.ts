// The demo api: a tiny JSON service on $PORT.
import * as lib from "./src/index.ts";

Bun.serve({
  port: Number(process.env.PORT),
  fetch: () => Response.json({ service: "api", functions: Object.keys(lib) }),
});
