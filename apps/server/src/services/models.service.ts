/** LLM model registry: admin-managed endpoints, per-user preference,
 *  and resolution for the AI assistant. The registry is authoritative;
 *  the MENTRO_LLM_* env vars act as a seed (and fallback when the
 *  registry is empty) so existing deployments keep working. */

import { ulid } from "ulid";
import { AppDataSource } from "../db/data-source";
import { AiFeedback, LlmEndpoint, Setting, User } from "../db/entities";
import type { LlmConfig } from "../lib/llm";
import { llmConfig } from "../lib/llm";
import { ServiceError } from "../lib/errors";

/** Default-endpoint marker lives in the settings table (JSON-safe). */
export interface EndpointView {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  /** Never expose; presence only. */
  hasKey: boolean;
}

function viewOf(e: LlmEndpoint, defaultId: string | null): EndpointView {
  return {
    id: e.id,
    name: e.name,
    baseUrl: e.baseUrl,
    model: e.model,
    enabled: e.enabled,
    isDefault: e.id === defaultId,
    hasKey: Boolean(e.apiKey),
  };
}

async function defaultId(): Promise<string | null> {
  const row = await AppDataSource.getRepository(Setting).findOneBy({
    key: "defaultLlmEndpointId",
  });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as string;
  } catch {
    return null;
  }
}

async function setSetting(key: string, value: string): Promise<void> {
  await AppDataSource.getRepository(Setting).upsert({ key, value }, ["key"]);
}

async function allEndpoints(): Promise<LlmEndpoint[]> {
  return AppDataSource.getRepository(LlmEndpoint).find({
    order: { createdAt: "ASC" },
  });
}

/** Seed once from env so the registry starts usable: a fast default
 *  (turbo-class) plus the env's own model as a second option. */
export async function seedEndpointsIfEmpty(): Promise<void> {
  const repo = AppDataSource.getRepository(LlmEndpoint);
  if ((await repo.count()) > 0) return;
  const env = llmConfig();
  if (!env) return;
  const turbo = await repo.save({
    id: ulid(),
    name: "Turbo (fast)",
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
    model: "glm-5-turbo",
    enabled: true,
  } as LlmEndpoint);
  await repo.save({
    id: ulid(),
    name: "Flash (smart)",
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
    model: env.model,
    enabled: true,
  } as LlmEndpoint);
  await setSetting("defaultLlmEndpointId", JSON.stringify(turbo.id));
  console.log("[models] seeded registry from env (turbo default)");
}

export async function listEndpoints(): Promise<EndpointView[]> {
  await seedEndpointsIfEmpty();
  const def = await defaultId();
  return (await allEndpoints()).map((e) => viewOf(e, def));
}

export async function createEndpoint(body: {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  makeDefault?: boolean;
}): Promise<EndpointView> {
  if (!body.name?.trim() || !body.baseUrl?.trim() || !body.model?.trim()) {
    throw new ServiceError(400, "name, baseUrl and model are required");
  }
  const repo = AppDataSource.getRepository(LlmEndpoint);
  const e = await repo.save({
    id: ulid(),
    name: body.name.trim(),
    baseUrl: body.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: body.apiKey?.trim() ?? "",
    model: body.model.trim(),
    enabled: true,
  } as LlmEndpoint);
  if (body.makeDefault) await setDefaultEndpoint(e.id);
  return viewOf(e, await defaultId());
}

export async function updateEndpoint(
  id: string,
  patch: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    enabled?: boolean;
    makeDefault?: boolean;
  },
): Promise<EndpointView> {
  const repo = AppDataSource.getRepository(LlmEndpoint);
  const e = await repo.findOneBy({ id });
  if (!e) throw new ServiceError(404, "endpoint not found");
  if (patch.name !== undefined) e.name = patch.name.trim();
  if (patch.baseUrl !== undefined)
    e.baseUrl = patch.baseUrl.trim().replace(/\/+$/, "");
  if (patch.apiKey !== undefined && patch.apiKey !== "__set__")
    e.apiKey = patch.apiKey.trim();
  if (patch.model !== undefined) e.model = patch.model.trim();
  if (patch.enabled !== undefined) e.enabled = patch.enabled;
  await repo.save(e);
  if (patch.makeDefault) await setDefaultEndpoint(e.id);
  return viewOf(e, await defaultId());
}

export async function deleteEndpoint(id: string): Promise<void> {
  const repo = AppDataSource.getRepository(LlmEndpoint);
  const e = await repo.findOneBy({ id });
  if (!e) throw new ServiceError(404, "endpoint not found");
  if ((await repo.count()) <= 1) {
    throw new ServiceError(400, "cannot delete the last endpoint");
  }
  if ((await defaultId()) === id) {
    throw new ServiceError(400, "cannot delete the default endpoint");
  }
  await repo.delete({ id });
  // Users pointing at it fall back to the default.
  await AppDataSource.createQueryBuilder()
    .update(User)
    .set({ llmEndpointId: null })
    .where("llm_endpoint_id = :id", { id })
    .execute();
}

export async function setDefaultEndpoint(id: string): Promise<void> {
  const repo = AppDataSource.getRepository(LlmEndpoint);
  const e = await repo.findOneBy({ id });
  if (!e) throw new ServiceError(404, "endpoint not found");
  if (!e.enabled) throw new ServiceError(400, "default must be enabled");
  await setSetting("defaultLlmEndpointId", JSON.stringify(id));
}

/** Resolve the endpoint a request should use: the user's preference if
 *  set and still available, else the site default, else the single
 *  enabled one, else env fallback. */
export async function resolveLlmForUser(
  userId: string | undefined,
): Promise<LlmConfig | null> {
  await seedEndpointsIfEmpty();
  const list = (await allEndpoints()).filter((e) => e.enabled);
  if (list.length === 0) return llmConfig(); // env fallback
  const def = await defaultId();
  if (userId) {
    const user = await AppDataSource.getRepository(User).findOneBy({
      id: userId,
    });
    const pick = list.find((e) => e.id === user?.llmEndpointId);
    if (pick) {
      return {
        baseUrl: pick.baseUrl,
        apiKey: pick.apiKey || "",
        model: pick.model,
      };
    }
  }
  const chosen = list.find((e) => e.id === def) ?? list[0]!;
  return {
    baseUrl: chosen.baseUrl,
    apiKey: chosen.apiKey || "",
    model: chosen.model,
  };
}

export async function setUserEndpoint(
  userId: string,
  endpointId: string | null,
): Promise<void> {
  if (endpointId) {
    const e = await AppDataSource.getRepository(LlmEndpoint).findOneBy({
      id: endpointId,
    });
    if (!e || !e.enabled) throw new ServiceError(400, "endpoint unavailable");
  }
  await AppDataSource.getRepository(User).update(
    { id: userId },
    { llmEndpointId: endpointId },
  );
}

export async function recordFeedback(body: {
  userId: string;
  query: string;
  answer?: string | null;
  rating: string;
}): Promise<void> {
  if (body.rating !== "up" && body.rating !== "down") {
    throw new ServiceError(400, "rating must be up|down");
  }
  await AppDataSource.getRepository(AiFeedback).insert({
    id: ulid(),
    userId: body.userId,
    query: body.query.slice(0, 500),
    answer: (body.answer ?? "").slice(0, 4000) || null,
    rating: body.rating,
  } as AiFeedback);
}
