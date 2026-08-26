/** Knowledge-base library: group tree CRUD + flat file list + move. */

import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { ulid } from "ulid";
import { AppDataSource } from "../db/data-source";
import { Asset, ContentUnit, Group, Job } from "../db/entities";
import { ftsDeleteAsset } from "../search/fts";
import { logRemoved, unitIdsOfAsset } from "../indexbundle";
import { serializedTx } from "../db/tx";
import { publish } from "../bus";

interface GroupNode {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  fileCount: number;
  children: GroupNode[];
}

export function registerLibraryRoutes(app: FastifyInstance) {
  app.get("/api/groups", async () => {
    const repo = AppDataSource.getRepository(Group);
    const [groups, counts] = await Promise.all([
      repo.find({ order: { sortOrder: "ASC", name: "ASC" } }),
      AppDataSource.getRepository(Asset)
        .createQueryBuilder("a")
        .select("a.group_id", "gid")
        .addSelect("COUNT(*)", "n")
        .groupBy("a.group_id")
        .getRawMany(),
    ]);
    const countByGid = new Map(
      counts.map((r: { gid: string | null; n: number }) => [
        r.gid,
        Number(r.n),
      ]),
    );
    const nodes = new Map<string, GroupNode>();
    for (const g of groups) {
      nodes.set(g.id, {
        id: g.id,
        name: g.name,
        parentId: g.parentId,
        sortOrder: g.sortOrder,
        fileCount: countByGid.get(g.id) ?? 0,
        children: [],
      });
    }
    const roots: GroupNode[] = [];
    for (const node of nodes.values()) {
      if (node.parentId && nodes.has(node.parentId)) {
        nodes.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return { groups: roots, ungrouped: countByGid.get(null) ?? 0 };
  });

  app.post<{ Body: { name: string; parentId?: string | null } }>(
    "/api/groups",
    async (request, reply) => {
      const { name, parentId } = request.body ?? {};
      if (!name?.trim()) {
        return reply.code(400).send({ error: "name required" });
      }
      if (parentId) {
        const parent = await AppDataSource.getRepository(Group).findOneBy({
          id: parentId,
        });
        if (!parent) return reply.code(404).send({ error: "parent not found" });
      }
      const group = await AppDataSource.getRepository(Group).save({
        id: ulid(),
        name: name.trim(),
        parentId: parentId ?? null,
      });
      return reply.code(201).send({ group });
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { name?: string; parentId?: string | null; sortOrder?: number };
  }>("/api/groups/:id", async (request, reply) => {
    const repo = AppDataSource.getRepository(Group);
    const group = await repo.findOneBy({ id: request.params.id });
    if (!group) return reply.code(404).send({ error: "not found" });
    const { name, parentId, sortOrder } = request.body ?? {};
    if (name !== undefined) group.name = name.trim();
    if (sortOrder !== undefined) group.sortOrder = sortOrder;
    if (parentId !== undefined) {
      if (parentId === request.params.id) {
        return reply.code(400).send({ error: "cannot be its own parent" });
      }
      group.parentId = parentId;
    }
    await repo.save(group);
    return { group };
  });

  app.delete<{ Params: { id: string } }>(
    "/api/groups/:id",
    async (request, reply) => {
      const repo = AppDataSource.getRepository(Group);
      const group = await repo.findOneBy({ id: request.params.id });
      if (!group) return reply.code(404).send({ error: "not found" });
      const files = await AppDataSource.getRepository(Asset).countBy({
        groupId: group.id,
      });
      const children = await repo.countBy({ parentId: group.id });
      if (files > 0 || children > 0) {
        return reply.code(409).send({ error: "group not empty" });
      }
      await repo.delete({ id: group.id });
      return { ok: true };
    },
  );

  // Flat file list with filters.
  app.get<{
    Querystring: {
      groupId?: string;
      kind?: string;
      q?: string;
      sort?: string;
      sortDir?: string;
      page?: string;
      pageSize?: string;
    };
  }>("/api/library", async (request) => {
    const { groupId, kind, q } = request.query;
    const page = Math.max(1, Number(request.query.page ?? 1) || 1);
    const pageSize = Math.min(
      200,
      Math.max(1, Number(request.query.pageSize ?? 50) || 50),
    );
    const repo = AppDataSource.getRepository(Asset);
    const qb = repo.createQueryBuilder("a");
    if (groupId === "ungrouped") qb.andWhere("a.group_id IS NULL");
    else if (groupId) qb.andWhere("a.group_id = :gid", { gid: groupId });
    if (kind) qb.andWhere("a.kind = :kind", { kind });
    const sortCol =
      request.query.sort === "mtime"
        ? "a.mtime_ms"
        : request.query.sort === "size"
          ? "a.size_bytes"
          : request.query.sort === "name"
            ? "a.path"
            : "a.uploaded_at";
    const dir = request.query.sortDir === "asc" ? "ASC" : "DESC";
    qb.orderBy(sortCol, dir)
      .skip((page - 1) * pageSize)
      .take(pageSize);
    if (q?.trim()) {
      qb.andWhere("(a.path LIKE :q OR a.kind LIKE :q)", {
        q: `%${q.trim()}%`,
      });
    }
    const [items, total] = await qb.getManyAndCount();
    return { total, page, pageSize, assets: items };
  });

  // Move asset to a group.
  app.patch<{ Params: { id: string }; Body: { groupId: string | null } }>(
    "/api/assets/:id/group",
    async (request, reply) => {
      const repo = AppDataSource.getRepository(Asset);
      const asset = await repo.findOneBy({ id: request.params.id });
      if (!asset) return reply.code(404).send({ error: "not found" });
      const { groupId } = request.body ?? {};
      if (groupId) {
        const group = await AppDataSource.getRepository(Group).findOneBy({
          id: groupId,
        });
        if (!group) return reply.code(404).send({ error: "group not found" });
      }
      await repo.update({ id: asset.id }, { groupId: groupId ?? null });
      return { ok: true };
    },
  );

  // Delete asset: index + disk file, uniformly (uploaded or mounted).
  // Own uploads only (uploaded_by check) unless super_admin.
  app.delete<{ Params: { id: string } }>(
    "/api/assets/:id",
    async (request, reply) => {
      const repo = AppDataSource.getRepository(Asset);
      const asset = await repo.findOneBy({ id: request.params.id });
      if (!asset) return reply.code(404).send({ error: "not found" });
      const isOwner = asset.uploadedBy === request.user?.id;
      const isAdmin = request.user?.role === "super_admin";
      if (!isOwner && !isAdmin) {
        return reply.code(403).send({ error: "not your file" });
      }
      await serializedTx(async (m) => {
        await ftsDeleteAsset(asset.id, m);
        await logRemoved(await unitIdsOfAsset(asset.id, m), m);
        await m.getRepository(ContentUnit).delete({ assetId: asset.id });
        await m.getRepository(Job).delete({ assetId: asset.id });
        await m.getRepository(Asset).delete({ id: asset.id });
      });
      // Remove the disk file.
      try {
        if (
          asset.path.startsWith(
            path.join(process.env.MENTRO_DATA ?? "./data", "pool"),
          )
        ) {
          await fs.unlink(asset.path);
        }
      } catch {
        /* file may already be gone */
      }
      publish({ event: "index.changed" });
      return { ok: true };
    },
  );
}
