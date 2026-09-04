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
import { Asset, Job, Source } from "./db/entities";
import { authGuard } from "./auth/guards";
import { registerAuthRoutes } from "./auth/routes";
import { registerAdminRoutes } from "./admin/routes";
import { registerSourceRoutes } from "./routes/sources";
import { onFsEvent } from "./fs-events";
import { registerAssetRoutes } from "./routes/assets";
import { registerLibraryRoutes } from "./routes/library";
import { registerSearchRoutes } from "./routes/search";
import { registerJobRoutes } from "./routes/jobs";
import { registerIndexRoutes } from "./routes/index";
import { registerExportRoutes } from "./routes/export";
import { registerAgentRoutes } from "./routes/agent";
import { registerMcp } from "./mcp";
import { registerWs } from "./ws";
import { registerWebStatic } from "./web-static";
import { ensurePoolSource, mountEnvSources } from "./pool";
import { registerUploadRoutes } from "./routes/upload";
import { initSegmenter } from "./search/segment";
import { WorkerPool, defaultPoolSize } from "./worker/pool";
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

  // Worker pool: N single-threaded worker processes (see serve.rs) — the
  // pool is what parallelizes extraction/transcription/embedding across
  // cores. Watches + fs events are pinned to the primary (worker 0).
  const poolSize = Math.max(
    1,
    Number(process.env.MENTRO_WORKER_POOL_SIZE ?? defaultPoolSize()),
  );
  const pool = await WorkerPool.start(
    config.workerBin,
    {
      onLog: (level, message) => {
        if (level >= 3) console.warn(`[worker] ${message}`);
      },
      onFs: (event) => {
        console.log(`[worker] fs ${event.kind} ${event.path}`);
        onFsEvent(
          { sourceId: event.sourceId, path: event.path, kind: event.kind },
          pool.primary(),
        );
      },
    },
    poolSize,
  );
  const worker = pool.primary();
  const ready = pool.ready;
  if (!ready) throw new Error("primary worker failed to start");
  console.log(
    `[worker] pool of ${pool.size} ready · protocol ${ready.protocol} · capabilities ${ready.capabilities.join(",")}`,
  );

  // Watch all existing sources on boot.
  if (ready.capabilities.includes(2)) {
    const sources = await AppDataSource.getRepository(Source).find();
    for (const source of sources) {
      worker
        .watch(source.id, source.rootPath)
        .then(() => console.log(`[watch] watching ${source.rootPath}`))
        .catch((err) =>
          console.warn(`[watch] failed ${source.rootPath}:`, err),
        );
    }
  }

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
  registerSearchRoutes(app, worker);
  registerJobRoutes(app);
  registerIndexRoutes(app);
  registerExportRoutes(app);
  registerAgentRoutes(app, worker);
  registerMcp(app, { jwtSecret, worker });
  registerWs(app, { jwtSecret });
  registerWebStatic(app);

  const dispatcher = new Dispatcher(pool, {
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
    await pool.stop();
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
