import { AppDataSource } from "../db/data-source";
import { Asset } from "../db/entities";
import type { EntityManager } from "typeorm";

/** Data access for assets. Query-builder heavy listing lives here so
 *  services stay SQL-free; every method accepts an optional entity
 *  manager so services can compose them inside one transaction. */

type Q = EntityManager;

function em(m?: Q): Q {
  return m ?? AppDataSource.manager;
}

export function assetRepo(m?: Q) {
  return em(m).getRepository(Asset);
}

export interface ListAssetsFilter {
  readableIds?: string[]; // undefined = no ACL restriction
  groupId?: string; // "" = all, "ungrouped" = pool root files, else dir path
  kind?: string;
  q?: string;
  sort?: "uploaded" | "mtime" | "size" | "name";
  sortDir?: "asc" | "desc";
  page: number;
  pageSize: number;
}

export async function listAssets(
  filter: ListAssetsFilter,
  m?: Q,
): Promise<{ items: Asset[]; total: number }> {
  const qb = assetRepo(m).createQueryBuilder("a");
  if (filter.readableIds) {
    // Named list parameter: mixing positional `?` with later :named
    // params breaks better-sqlite3 binding order.
    qb.andWhere("a.id IN (:...readableIds)", {
      readableIds: filter.readableIds,
    });
  }
  if (filter.groupId === "ungrouped") {
    qb.andWhere("a.path NOT LIKE :dirPat", { dirPat: "%/%" });
  } else if (filter.groupId) {
    qb.andWhere("a.path LIKE :dirPat", { dirPat: `${filter.groupId}/%` });
  }
  if (filter.kind) qb.andWhere("a.kind = :kind", { kind: filter.kind });
  const sortCol =
    filter.sort === "mtime"
      ? "a.mtime_ms"
      : filter.sort === "size"
        ? "a.size_bytes"
        : filter.sort === "name"
          ? "a.path"
          : "a.uploaded_at";
  qb.orderBy(sortCol, filter.sortDir === "asc" ? "ASC" : "DESC")
    .skip((filter.page - 1) * filter.pageSize)
    .take(filter.pageSize);
  if (filter.q?.trim()) {
    qb.andWhere("(a.path LIKE :q OR a.kind LIKE :q)", {
      q: `%${filter.q.trim()}%`,
    });
  }
  const [items, total] = await qb.getManyAndCount();
  return { items, total };
}

export async function listAssetsPaged(
  where: Record<string, string>,
  page: number,
  pageSize: number,
  m?: Q,
): Promise<{ items: Asset[]; total: number }> {
  const [items, total] = await assetRepo(m).findAndCount({
    where,
    order: { path: "ASC" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return { items, total };
}

export async function findAssetById(id: string, m?: Q): Promise<Asset | null> {
  return assetRepo(m).findOneBy({ id });
}

/** Duplicate-name check within a target directory (null/"" = pool root).
 *  Paths are plain originals now (no ULID__ prefix). */
export async function findAssetByFileNameInGroup(
  fileName: string,
  groupId: string | null,
  m?: Q,
): Promise<Asset | null> {
  const rel = groupId ? `${groupId}/${fileName}` : fileName;
  return assetRepo(m)
    .createQueryBuilder("a")
    .where("a.path = :p", { p: rel })
    .getOne();
}

/** Same-content check: md5 digest of the file body (upload preflight). */
export async function findAssetByMd5(
  md5: string,
  m?: Q,
): Promise<Asset | null> {
  if (!md5) return null;
  return assetRepo(m)
    .createQueryBuilder("a")
    .where("a.md5 = :m", { m: md5 })
    .getOne();
}

export async function findAssetsBySource(
  sourceId: string,
  m?: Q,
): Promise<Asset[]> {
  return assetRepo(m).findBy({ sourceId });
}

export async function countAssetsBySource(
  sourceId: string,
  m?: Q,
): Promise<number> {
  return assetRepo(m).countBy({ sourceId });
}

export async function countDoneAssetsBySource(
  sourceId: string,
  m?: Q,
): Promise<number> {
  return assetRepo(m).countBy({ sourceId, extractionStatus: "done" });
}

export async function saveAssets(items: Asset[], m?: Q): Promise<void> {
  await assetRepo(m).save(items);
}

export async function updateAsset(
  id: string,
  patch: Partial<Asset>,
  m?: Q,
): Promise<void> {
  await assetRepo(m).update({ id }, patch);
}

export async function deleteAsset(id: string, m?: Q): Promise<void> {
  await assetRepo(m).delete({ id });
}
