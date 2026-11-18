/** Library API: group tree, file list, upload with group targeting. */

import { api, loadAuth, ApiError } from "./client";

export interface GroupNode {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  fileCount: number;
  visibility: "internal" | "public";
  children: GroupNode[];
}

export interface GroupTree {
  groups: GroupNode[];
  ungrouped: number;
}

export interface LibraryAsset {
  id: string;
  path: string;
  kind: string;
  sizeBytes: number;
  mtimeMs: number;
  mime: string | null;
  groupId: string | null;
  uploadedAt: string | null;
  uploadedBy: string | null;
  extractionStatus: string;
}

export function fetchGroups(): Promise<GroupTree> {
  return api<GroupTree>("/api/groups");
}

export function createGroup(
  name: string,
  parentId: string,
): Promise<{ group: GroupNode }> {
  return api("/api/groups", {
    method: "POST",
    body: JSON.stringify({ name, parentId: parentId || null }),
  });
}

export function renameGroup(
  id: string,
  name: string,
): Promise<{ group: GroupNode }> {
  return api(`/api/groups/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function deleteGroup(id: string): Promise<{ ok: boolean }> {
  return api(`/api/groups/${id}`, { method: "DELETE" });
}

export function fetchLibrary(params: {
  groupId?: string;
  kind?: string;
  q?: string;
  sort?: string;
  sortDir?: string;
  page?: number;
  pageSize?: number;
}): Promise<{
  total: number;
  page: number;
  pageSize: number;
  assets: LibraryAsset[];
}> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  return api(`/api/library?${search.toString()}`);
}

export function moveAsset(
  id: string,
  dir: string | null,
): Promise<{ ok: boolean }> {
  return api(`/api/assets/:id/group`.replace(":id", id), {
    method: "PATCH",
    body: JSON.stringify({ groupId: dir }),
  });
}

export function deleteAsset(id: string): Promise<{ ok: boolean }> {
  return api(`/api/assets/${id}`, { method: "DELETE" });
}

export interface UploadResult {
  uploaded: Array<{
    name: string;
    storedPath: string;
    unpackedFiles: number;
    unpackedBytes: number;
    unpackError?: string;
  }>;
  /** Present on 409 when a same-name file exists in the target group. */
  duplicate?: { fileName: string; existingId: string };
}

/** Upload preflight: name+md5 per file against a target dir. */
export async function checkUpload(
  files: File[],
  dir: string,
  md5s: string[],
): Promise<
  Array<{
    status: "ok" | "same-name" | "same-hash" | "error";
    existingPath?: string;
  }>
> {
  const items = files.map((f, i) => ({ name: f.name, md5: md5s[i] ?? "" }));
  const res = await api<{
    results: Array<never> | Array<{ status: string; existingPath?: string }>;
  }>("/api/upload/check", {
    method: "POST",
    body: JSON.stringify({ dir, items }),
  });
  return (
    (res.results as Array<{
      status: "ok" | "same-name" | "same-hash";
      existingPath?: string;
    }>) ?? []
  );
}

export async function uploadToGroup(
  files: File[],
  dir: string,
  overwrite = false,
): Promise<UploadResult> {
  const auth = loadAuth();
  const form = new FormData();
  // Pair by append order; the server restores each file's own
  // modification time from this metadata (browsers do not expose
  // creation time over multipart).
  const meta = files.map((f) => ({
    name: f.name,
    lastModified: f.lastModified,
  }));
  // Fields FIRST: multipart only exposes fields received before a part
  // on that part (attachFieldsToBody is off server-side).
  form.append("dir", dir ?? "");
  if (overwrite) form.append("overwrite", "true");
  form.append("meta", JSON.stringify(meta));
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: auth?.accessToken
      ? { authorization: `Bearer ${auth.accessToken}` }
      : undefined,
    body: form,
  });
  const body = await res.json();
  if (!res.ok) {
    if (res.status === 409 && body?.error === "duplicate") {
      return { uploaded: [], duplicate: body };
    }
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  return body as UploadResult;
}
