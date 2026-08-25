import type { FastifyInstance } from "fastify";
import { AppDataSource } from "../db/data-source";
import { Job } from "../db/entities";

export function registerJobRoutes(app: FastifyInstance) {
  app.get("/api/jobs", async () => {
    const jobs = await AppDataSource.getRepository(Job).find({
      order: { updatedAt: "DESC" },
      take: 100,
    });
    return { jobs };
  });
}
