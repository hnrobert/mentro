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

/** apiBlob with transfer progress (XHR onprogress; the server sets
 * content-length on artifact routes so totals are known). */
export function apiBlobProgress(
  path: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", path);
    xhr.responseType = "blob";
    const auth = loadAuth();
    if (auth?.accessToken) {
      xhr.setRequestHeader("authorization", `Bearer ${auth.accessToken}`);
    }
    xhr.onprogress = (e) => {
      if (e.lengthComputable || e.total > 0) {
        onProgress(e.loaded, e.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as Blob);
      } else if (xhr.status === 401) {
        tryRefresh()
          .then((ok) =>
            ok
              ? apiBlobProgress(path, onProgress).then(resolve, reject)
              : reject(new ApiError(401, "unauthorized")),
          )
          .catch(() => reject(new ApiError(401, "unauthorized")));
      } else {
        reject(new ApiError(xhr.status, `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network error"));
    xhr.send();
  });
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

// --- AI assistant (SSE) ----------------------------------------------------

export interface AssistantSource {
  i: number;
  unitId: string;
  assetId: string;
  ordinal: number;
  unitType: string;
  fileName: string;
  title: string | null;
}

export interface AssistantHandlers {
  onDelta: (text: string) => void;
  onSources?: (sources: AssistantSource[]) => void;
}

/**
 * POST /api/assistant and consume its SSE stream. Deltas and the
 * terminal sources event go to the handlers; resolves at [DONE].
 * Throws ApiError for non-2xx (e.g. 501 LLM not configured) or when the
 * stream carries an {"error"} event.
 */
export async function assistantStream(
  body: Record<string, unknown>,
  handlers: AssistantHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const doFetch = (): Promise<Response> => {
    const auth = loadAuth();
    return fetch("/api/assistant", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth?.accessToken
          ? { authorization: `Bearer ${auth.accessToken}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  };
  let res = await doFetch();
  // Same single refresh-on-401 retry as api()/apiBlob().
  if (res.status === 401) {
    if (await tryRefresh()) {
      res = await doFetch();
    } else {
      clearAuth();
      window.dispatchEvent(new CustomEvent("mentro:unauthorized"));
    }
  }
  if (!res.ok || !res.body) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string; hint?: string };
      if (data.error)
        message = data.hint ? `${data.error}（${data.hint}）` : data.error;
    } catch {
      /* keep status line */
    }
    throw new ApiError(res.status, message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const ev = JSON.parse(payload) as {
          delta?: string;
          sources?: AssistantSource[];
          error?: string;
        };
        if (ev.error) throw new ApiError(502, ev.error);
        if (ev.delta) handlers.onDelta(ev.delta);
        if (ev.sources && handlers.onSources) handlers.onSources(ev.sources);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        /* skip malformed line */
      }
    }
  }
}
