import Fastify from "fastify";

const port = Number(process.env.MENTRO_PORT ?? 37797);
const host = process.env.MENTRO_BIND ?? "127.0.0.1";

const app = Fastify({ logger: false });

app.get("/api/status", async () => ({
  name: "mentro",
  status: "ok",
  uptimeSec: Math.round(process.uptime()),
}));

app
  .listen({ port, host })
  .then(() => {
    console.log(`[mentro] listening on http://${host}:${port}`);
  })
  .catch((err) => {
    console.error("[mentro] failed to start:", err);
    process.exit(1);
  });
