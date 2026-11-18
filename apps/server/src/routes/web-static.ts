import fs from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Serves the built web SPA (apps/web/dist) when present — the compose
 * deployment's only frontend. In dev the directory doesn't exist and
 * Vite owns the browser side, so this registers nothing.
 */
export function registerWebStatic(app: FastifyInstance): void {
  // apps/web/dist sits two levels above this module — true for src/ (dev)
  // and dist/ (bundle) alike, matching config.ts's REPO_ROOT convention.
  const webDist = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../web/dist",
  );
  if (!fs.existsSync(path.join(webDist, "index.html"))) {
    return;
  }
  void app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
    wildcard: false,
    // index.html must always revalidate — its asset hashes change every
    // build, and a cached copy pins the OLD bundle forever. Hashed
    // /assets/* files are content-addressed, so they cache immutably.
    setHeaders: (reply, filePath) => {
      if (filePath.endsWith("index.html")) {
        reply.header("cache-control", "no-cache");
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        reply.header("cache-control", "public, max-age=31536000, immutable");
      }
    },
  });
  // SPA fallback: unknown non-API routes get index.html (history mode).
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/mcp")) {
      return reply.code(404).send({ error: "not found" });
    }
    reply.header("cache-control", "no-cache");
    return reply.sendFile("index.html");
  });
}
