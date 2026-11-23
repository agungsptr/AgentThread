// The demo web: a tiny HTML page on $PORT.
import { shout } from "./src/index.ts";

const title = "AgentThread demo";
Bun.serve({
  port: Number(process.env.PORT),
  fetch: () =>
    new Response(`<!doctype html><title>${title}</title><h1>${shout(title)}</h1>`, {
      headers: { "content-type": "text/html" },
    }),
});
