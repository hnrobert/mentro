import { AppDataSource } from "../db/data-source";
import { UnitTranslation, UnitTranslationEmbedding } from "../db/entities";
import type { EntityManager } from "typeorm";

/** Data access for translations and their embedding vectors. */

type Q = EntityManager;

function em(m?: Q): Q {
  return m ?? AppDataSource.manager;
}

export function translationRepo(m?: Q) {
  return em(m).getRepository(UnitTranslation);
}

export function translationEmbeddingRepo(m?: Q) {
  return em(m).getRepository(UnitTranslationEmbedding);
}

export async function findTranslationsOfUnit(
  unitId: string,
  m?: Q,
): Promise<UnitTranslation[]> {
  return translationRepo(m).find({ where: { unitId, status: "ok" } });
}

export async function upsertTranslations(
  rows: UnitTranslation[],
  m?: Q,
): Promise<void> {
  await translationRepo(m).upsert(rows, ["unitId", "lang"]);
}

export async function deleteTranslationsOfAsset(
  assetId: string,
  m?: Q,
): Promise<void> {
  await translationRepo(m).delete({ assetId });
}

export async function deleteTranslationEmbeddingsOfAsset(
  assetId: string,
  m?: Q,
): Promise<void> {
  await translationEmbeddingRepo(m).delete({ assetId });
}
