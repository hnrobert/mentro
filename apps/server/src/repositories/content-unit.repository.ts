import { AppDataSource } from "../db/data-source";
import { ContentUnit } from "../db/entities";
import type { EntityManager } from "typeorm";

/** Data access for content units. */

type Q = EntityManager;

function em(m?: Q): Q {
  return m ?? AppDataSource.manager;
}

export function unitRepo(m?: Q) {
  return em(m).getRepository(ContentUnit);
}

export async function findUnitById(
  id: string,
  m?: Q,
): Promise<ContentUnit | null> {
  return unitRepo(m).findOneBy({ id });
}

export async function findUnitsOfAsset(
  assetId: string,
  m?: Q,
): Promise<ContentUnit[]> {
  return unitRepo(m).find({ where: { assetId }, order: { ordinal: "ASC" } });
}

/** The target unit plus its immediate neighbours (deep-read context). */
export async function findUnitWithNeighbours(
  unit: ContentUnit,
  before: number,
  after: number,
  m?: Q,
): Promise<ContentUnit[]> {
  return unitRepo(m)
    .createQueryBuilder("cu")
    .where("cu.asset_id = :assetId", { assetId: unit.assetId })
    .andWhere("cu.ordinal BETWEEN :lo AND :hi", {
      lo: Math.max(1, unit.ordinal - before),
      hi: unit.ordinal + after,
    })
    .orderBy("cu.ordinal", "ASC")
    .getMany();
}

export async function deleteUnitsOfAsset(
  assetId: string,
  m?: Q,
): Promise<void> {
  await unitRepo(m).delete({ assetId });
}

export async function countUnits(m?: Q): Promise<number> {
  return unitRepo(m).count();
}

export async function updateUnit(
  id: string,
  patch: Partial<ContentUnit>,
  m?: Q,
): Promise<void> {
  await unitRepo(m).update({ id }, patch);
}

export async function rowidOfUnits(
  ids: string[],
  m?: Q,
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = (await em(m).query(
    `SELECT id, rowid AS rid FROM content_units WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  )) as Array<{ id: string; rid: number }>;
  return new Map(rows.map((r) => [r.id, r.rid]));
}
