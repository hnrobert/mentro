import "reflect-metadata";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import compress from "@fastify/compress";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { loadConfig, loadJwtSecret, lockDataDir } from "./config";
import {
  AppDataSource,
  closeDataSource,
  initDataSource,
} from "./db/data-source";
import { Asset, Job } from "./db/entities";
import { authGuard } from "./auth/guards";
import { registerAuthRoutes } from "./auth/routes";
import { registerAdminRoutes } from "./admin/routes";
import { registerSourceRoutes } from "./routes/sources";
import { registerAssetRoutes } from "./routes/assets";
import { registerLibraryRoutes } from "./routes/library";
import { registerSearchRoutes } from "./routes/search";
import { registerJobRoutes } from "./routes/jobs";
import { registerIndexRoutes } from "./routes/index";
import { registerWs } from "./ws";
import { ensurePoolSource, mountEnvSources } from "./pool";
import { registerUploadRoutes } from "./routes/upload";
import { initSegmenter } from "./search/segment";
import { WorkerClient } from "./worker/client";
import { Dispatcher } from "./queue/dispatcher";
import { clientCount, publish } from "./bus";

let snapshotRevision = 0;

async function publishSnapshot(): Promise<void> {
  const assetRepo = AppDataSource.getRepository(Asset);
  const jobRepo = AppDataSource.getRepository(Job);
  const [assetsTotal, assetsDone, jobsActive] = await Promise.all([
    assetRepo.count(),
    assetRepo.countBy({ extractionStatus: "done" }),
    jobRepo.countBy({ status: "running" }),
  ]);
  publish({
    event: "pipeline.snapshot",
    revision: ++snapshotRevision,
    phase: "extract",
    assetsDone,
    assetsTotal,
    jobsActive,
    wsClients: clientCount(),
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const releaseLock = lockDataDir(config.dataDir);
  const jwtSecret = loadJwtSecret(config.dataDir);

  await initDataSource();
  await initSegmenter();

  const worker = new WorkerClient(config.workerBin, {
    onLog: (_level, message) => console.log(`[worker] ${message}`),
  });
  const ready = await worker.start();
  console.log(
    `[worker] ready · protocol ${ready.protocol} · capabilities ${ready.capabilities.join(",")}`,
  );

  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
  await app.register(rateLimit, { global: false });
  await app.register(websocket);
  await app.register(multipart, { attachFieldsToBody: false });
  await app.register(compress, { global: true });

  // Global auth: everything under /api/* except /api/auth/* and /api/ws.
  const guard = authGuard({ jwtSecret });
  app.addHook(
    "preHandler",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const url = request.url.split("?")[0];
      if (!url.startsWith("/api/")) return;
      if (url.startsWith("/api/auth/") || url === "/api/ws") return;
      await guard(request, reply);
    },
  );

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/api/status", async () => ({
    name: "mentro",
    status: "ok",
    worker: { protocol: ready.protocol, tools: ready.tools },
    uptimeSec: Math.round(process.uptime()),
  }));

  registerAuthRoutes(app, { config, jwtSecret });

  // Asset pool: self-owned source under <data>/pool + MENTRO_SOURCES mounts.
  const poolSourcePromise = ensurePoolSource(config.dataDir);
  await poolSourcePromise;
  await mountEnvSources(worker);
  registerUploadRoutes(app, {
    config,
    worker,
    poolSource: () => poolSourcePromise,
  });
  registerAdminRoutes(app, { jwtSecret });
  registerSourceRoutes(app, { worker });
  registerAssetRoutes(app);
  registerLibraryRoutes(app);
  registerSearchRoutes(app);
  registerJobRoutes(app);
  registerIndexRoutes(app);
  registerWs(app, { jwtSecret });

  const dispatcher = new Dispatcher(worker, {
    onJobUpdate: (job) => {
      publish({
        event: "job.updated",
        jobId: job.id,
        assetId: job.assetId,
        status: job.status,
      });
      void publishSnapshot();
    },
  });
  dispatcher.start();

  const shutdown = async () => {
    console.log("[mentro] shutting down");
    dispatcher.stop();
    await app.close();
    await worker.stop();
    await closeDataSource();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port: config.port, host: config.bind });
  console.log(`[mentro] listening on http://${config.bind}:${config.port}`);
}

main().catch((err) => {
  console.error("[mentro] fatal:", err);
  process.exit(1);
});
