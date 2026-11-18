/** Asset domain: detail with units, raw file, render-on-miss page
 *  thumbnails, per-unit translations, and the rendered-PDF cache path.
 *  HTTP stream concerns stay in the route; this service resolves WHAT
 *  to serve (paths, bytes source) and enforces ACL. */

import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { ContentUnit } from "../db/entities";
import { findAssetById } from "../repositories/asset.repository";
import { poolAbs } from "./dir-meta";
import {
  findUnitById,
  findUnitsOfAsset,
  updateUnit,
} from "../repositories/content-unit.repository";
import { findTranslationsOfUnit } from "../repositories/translation.repository";
import { canRead } from "./acl.service";
import type { AuthUser } from "../auth/tokens";
import { ServiceError } from "./errors";
import type { WorkerPool } from "../worker/pool";

/** Kinds whose pages can be lazily rendered to preview images. */
export const RENDERABLE = new Set(["pdf", "presentation", "document"]);

function dataDir(): string {
  return process.env.MENTRO_DATA ?? "./data";
}

export async function assetDetail(
  user: AuthUser,
  assetId: string,
): Promise<{
  asset: Awaited<ReturnType<typeof findAssetById>>;
  units: ContentUnit[];
}> {
  const asset = await findAssetById(assetId);
  if (!asset) throw new ServiceError(404, "not found");
  if (!(await canRead(user, asset.id))) {
    throw new ServiceError(403, "forbidden");
  }
  return { asset, units: await findUnitsOfAsset(asset.id) };
}

/** Resolve the raw file stream + serving headers. */
export async function assetFileStream(
  user: AuthUser,
  assetId: string,
): Promise<{
  stream: Readable;
  mime: string | null;
  fileName: string;
}> {
  const asset = await findAssetById(assetId);
  if (!asset || !fs.existsSync(poolAbs(asset.path))) {
    throw new ServiceError(404, "not found");
  }
  if (!(await canRead(user, asset.id))) {
    throw new ServiceError(403, "forbidden");
  }
  return {
    stream: fs.createReadStream(poolAbs(asset.path)),
    mime: asset.mime,
    fileName: asset.path.split("/").pop() ?? "file",
  };
}

export interface ThumbResolution {
  file: string; // absolute path to the PNG
}

/** Thumbnail for a content unit; lazily renders the page on first
 *  request (render-on-miss). Renders run through the worker POOL (an
 *  idle worker), never a pinned one — a busy primary must not stall UI
 *  previews behind extraction jobs. */
export async function resolveThumb(
  user: AuthUser,
  unitId: string,
  full: boolean,
  pool?: WorkerPool,
): Promise<ThumbResolution> {
  const unit = await findUnitById(unitId);
  if (!unit) throw new ServiceError(404, "unit not found");
  if (!(await canRead(user, unit.assetId))) {
    throw new ServiceError(403, "forbidden");
  }

  let thumbPath = unit.thumbPath;
  if (!thumbPath && pool) {
    const asset = await findAssetById(unit.assetId);
    if (
      asset &&
      RENDERABLE.has(asset.kind) &&
      fs.existsSync(poolAbs(asset.path))
    ) {
      const resp = await pool.run((worker) =>
        worker.renderPage(
          {
            assetId: asset.id,
            path: poolAbs(asset.path),
            ordinal: unit.ordinal,
            contentHash: asset.contentHash ?? "",
            full,
          },
          5 * 60 * 1000,
        ),
      );
      if (resp.ok && resp.result?.case === "renderResult") {
        thumbPath = resp.result.value.thumbPath;
        await updateUnit(unit.id, { thumbPath });
      }
    }
  }

  if (!thumbPath) throw new ServiceError(404, "no thumbnail");
  const file = path.join(dataDir(), thumbPath);
  if (!fs.existsSync(file)) throw new ServiceError(404, "not rendered");
  return { file };
}

/** Translations of one unit (detail view's Original/translation toggle). */
export async function unitTranslations(
  user: AuthUser,
  unitId: string,
): Promise<Array<{ lang: string; title: string | null; text: string | null }>> {
  const unit = await findUnitById(unitId);
  if (!unit) throw new ServiceError(404, "unit not found");
  if (!(await canRead(user, unit.assetId))) {
    throw new ServiceError(403, "forbidden");
  }
  const rows = await findTranslationsOfUnit(unit.id);
  return rows.map((r) => ({ lang: r.lang, title: r.title, text: r.text }));
}

/** Office -> PDF render cache for in-browser preview. Keep the name in
 *  sync with the worker's render cache version (RENDER_V). */
export async function renderedPdf(
  user: AuthUser,
  assetId: string,
): Promise<{ file: string }> {
  const asset = await findAssetById(assetId);
  if (!asset) throw new ServiceError(404, "not found");
  if (!(await canRead(user, asset.id))) {
    throw new ServiceError(403, "forbidden");
  }
  const pdf = path.join(dataDir(), "render", `${asset.id}.r2.pdf`);
  if (!fs.existsSync(pdf)) throw new ServiceError(404, "not rendered");
  return { file: pdf };
}
