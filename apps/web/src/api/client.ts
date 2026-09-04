/** Minimal API client: bearer auth, single refresh-on-401 retry. */

const STORE_KEY = "mentro.auth";

export interface StoredAuth {
  accessToken: string;
  refreshToken: string;
}

export function loadAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as StoredAuth) : null;
  } catch {
    return null;
  }
}

export function saveAuth(auth: StoredAuth): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(auth));
}

export function clearAuth(): void {
  localStorage.removeItem(STORE_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function tryRefresh(): Promise<boolean> {
  const auth = loadAuth();
  if (!auth?.refreshToken) return false;
  const res = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: auth.refreshToken }),
  });
  if (!res.ok) return false;
  const next = (await res.json()) as StoredAuth;
  saveAuth(next);
  return true;
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const auth = loadAuth();
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(auth?.accessToken
        ? { authorization: `Bearer ${auth.accessToken}` }
        : {}),
      ...options.headers,
    },
  });
  if (res.status === 401 && retry && !path.startsWith("/api/auth/")) {
    if (await tryRefresh()) return api<T>(path, options, false);
    clearAuth();
    window.dispatchEvent(new CustomEvent("mentro:unauthorized"));
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep status message */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

/** Authed binary fetch (thumbnails/previews); <img> cannot send the
 * bearer header, so callers turn the blob into an object URL. */
export async function apiBlob(path: string, retry = true): Promise<Blob> {
  const auth = loadAuth();
  const res = await fetch(path, {
    headers: auth?.accessToken
      ? { authorization: `Bearer ${auth.accessToken}` }
      : undefined,
  });
  if (res.status === 401 && retry && !path.startsWith("/api/auth/")) {
    if (await tryRefresh()) return apiBlob(path, false);
    clearAuth();
    window.dispatchEvent(new CustomEvent("mentro:unauthorized"));
  }
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return res.blob();
}

export interface AuthResponse extends StoredAuth {
  user: { id: string; username: string; role: string; enabled: boolean };
}

export async function login(
  username: string,
  password: string,
): Promise<AuthResponse> {
  const body = await api<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  saveAuth({ accessToken: body.accessToken, refreshToken: body.refreshToken });
  return body;
}

export async function register(
  username: string,
  password: string,
): Promise<AuthResponse> {
  const body = await api<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  saveAuth({ accessToken: body.accessToken, refreshToken: body.refreshToken });
  return body;
}

export async function logout(): Promise<void> {
  const auth = loadAuth();
  if (auth?.refreshToken) {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    }).catch(() => undefined);
  }
  clearAuth();
}

export interface UploadOutcome {
  name: string;
  storedPath: string;
  unpackedFiles: number;
  unpackedBytes: number;
  unpackError?: string;
}

/** Upload files into the asset pool (multipart); archives auto-unpack. */
export async function uploadFiles(files: File[]): Promise<UploadOutcome[]> {
  const auth = loadAuth();
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch("/api/upload", {
    method: "POST",
    headers: auth?.accessToken
      ? { authorization: `Bearer ${auth.accessToken}` }
      : undefined,
    body: form,
  });
  if (!res.ok)
    throw new ApiError(res.status, `upload failed (HTTP ${res.status})`);
  const body = (await res.json()) as { uploaded: UploadOutcome[] };
  return body.uploaded;
}
