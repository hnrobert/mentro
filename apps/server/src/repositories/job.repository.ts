import { AppDataSource } from "../db/data-source";
import { Job } from "../db/entities";
import type { EntityManager } from "typeorm";

/** Data access for the job queue. */

type Q = EntityManager;

function em(m?: Q): Q {
  return m ?? AppDataSource.manager;
}

export function jobRepo(m?: Q) {
  return em(m).getRepository(Job);
}

export async function findJobById(id: string, m?: Q): Promise<Job | null> {
  return jobRepo(m).findOneBy({ id });
}

export async function saveJob(job: Job, m?: Q): Promise<Job> {
  return jobRepo(m).save(job);
}

export async function recentJobs(limit: number, m?: Q): Promise<Job[]> {
  return jobRepo(m).find({ order: { updatedAt: "DESC" }, take: limit });
}

/** Oldest pending jobs (dispatcher scan window). */
export async function pendingJobs(limit: number, m?: Q): Promise<Job[]> {
  return jobRepo(m).find({
    where: { status: "pending" },
    order: { createdAt: "ASC" },
    take: limit,
  });
}

export async function findOnePending(m?: Q): Promise<Job | null> {
  return jobRepo(m).findOne({
    where: { status: "pending" },
    order: { createdAt: "ASC" },
  });
}

export async function updateJob(
  id: string,
  patch: Partial<Job>,
  m?: Q,
): Promise<void> {
  await jobRepo(m).update({ id }, patch);
}

export async function findActiveJob(
  kind: string,
  assetId: string | null,
  payloadPattern: string,
  m?: Q,
): Promise<Job | null> {
  return jobRepo(m)
    .createQueryBuilder("j")
    .where("j.kind = :kind", { kind })
    .andWhere("j.status IN (:...st)", { st: ["pending", "running"] })
    .andWhere("j.asset_id IS :asset", { asset: assetId })
    .andWhere("j.payload LIKE :p", { p: payloadPattern })
    .getOne();
}

export async function findJobByKindAndAsset(
  kind: string,
  assetId: string,
  status: string,
  m?: Q,
): Promise<Job | null> {
  return jobRepo(m).findOne({ where: { kind, assetId, status } });
}

export async function insertJob(job: Job, m?: Q): Promise<void> {
  await jobRepo(m).insert(job);
}

export async function deleteJobsOfAsset(assetId: string, m?: Q): Promise<void> {
  await jobRepo(m).delete({ assetId });
}

/** Boot reconciliation: rows stuck in "running" after a restart. */
export async function resetOrphanedRunning(m?: Q): Promise<number> {
  const result = await jobRepo(m)
    .createQueryBuilder()
    .update(Job)
    .set({ status: "pending", updatedAt: new Date() })
    .where("status = :st", { st: "running" })
    .execute();
  return result.affected ?? 0;
}
