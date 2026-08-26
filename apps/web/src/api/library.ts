/** Library API: group tree, file list, upload with group targeting. */

import { api, loadAuth, ApiError } from "./client";

export interface GroupNode {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  fileCount: number;
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
  parentId: string | null,
): Promise<{ group: GroupNode }> {
  return api("/api/groups", {
    method: "POST",
    body: JSON.stringify({ name, parentId }),
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
  groupId: string | null,
): Promise<{ ok: boolean }> {
  return api(`/api/assets/${id}/group`, {
    method: "PATCH",
    body: JSON.stringify({ groupId }),
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

export async function uploadToGroup(
  files: File[],
  groupId: string | null,
  overwrite = false,
): Promise<UploadResult> {
  const auth = loadAuth();
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  form.append("groupId", groupId ?? "");
  if (overwrite) form.append("overwrite", "true");
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
