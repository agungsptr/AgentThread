// The release row ws-stack-runner starts this as the repo's service: a tiny HTTP server on $PORT.
Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("ok") });
