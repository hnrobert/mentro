/** Jobs routes: thin adapter over the job repository (recent jobs for
 *  polling UIs — no domain logic to isolate). */

import type { FastifyInstance } from "fastify";
import { recentJobs } from "../repositories/job.repository";

export function registerJobRoutes(app: FastifyInstance) {
  app.get("/api/jobs", async () => ({ jobs: await recentJobs(100) }));
}
