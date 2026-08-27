/**
 * Owns the local search engine: initial bundle load + incremental updates.
 *
 * Sync strategy: prefer WebSocket push; if WS fails to connect within
 * the timeout, fall back to interval polling. The search experience is
 * never blocked by either — the bundle loads first, sync starts after.
 */

import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import { api, loadAuth } from "@/api/client";
import { MiniSearchEngine } from "@/search/minisearch";
import type { SearchEngine, SearchUnit } from "@/search/engine";

interface FullBundle {
  version: number;
  generatedAt: number;
  units: SearchUnit[];
}

interface DeltaBundle {
  version: number;
  upserted: SearchUnit[];
  removed: string[];
}

const WS_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 15000;

export const useSearchIndexStore = defineStore("searchIndex", () => {
  const engine = shallowRef<SearchEngine>(new MiniSearchEngine());
  const version = ref(0);
  const ready = ref(false);
  const loading = ref(false);
  const lastError = ref("");
  const syncMode = ref<"ws" | "poll" | "off">("off");

  async function init(): Promise<void> {
    if (ready.value || loading.value) return;
    loading.value = true;
    try {
      const bundle = await api<FullBundle>("/api/index");
      engine.value.replaceAll(bundle.units);
      version.value = bundle.version;
      ready.value = true;
      startSync();
    } catch (err) {
      lastError.value = String(err);
    } finally {
      loading.value = false;
    }
  }

  async function refresh(): Promise<void> {
    if (!ready.value) return init();
    try {
      const delta = await api<DeltaBundle>(`/api/index?since=${version.value}`);
      applyDelta(delta);
    } catch {
      try {
        const bundle = await api<FullBundle>("/api/index");
        engine.value.replaceAll(bundle.units);
        version.value = bundle.version;
      } catch {
        /* server unreachable, keep current index */
      }
    }
  }

  function applyDelta(delta: DeltaBundle): void {
    engine.value.applyDelta(delta.upserted, delta.removed);
    version.value = delta.version;
  }

  // --- Sync: WS-first with polling fallback ---

  let ws: WebSocket | null = null;
  let wsTimeout: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let retryMs = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  function startSync(): void {
    if (destroyed) return;
    tryWs();
  }

  function tryWs(): void {
    if (destroyed) return;
    cleanupWs();

    const auth = loadAuth();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/api/ws${
      auth?.accessToken ? `?token=${encodeURIComponent(auth.accessToken)}` : ""
    }`;

    try {
      ws = new WebSocket(url);
    } catch {
      startPolling();
      return;
    }

    // Timeout: if WS doesn't open quickly, switch to polling.
    wsTimeout = setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        cleanupWs();
        startPolling();
      }
    }, WS_TIMEOUT_MS);

    ws.onopen = () => {
      if (wsTimeout) clearTimeout(wsTimeout);
      wsTimeout = null;
      retryMs = 1000;
      syncMode.value = "ws";
      stopPolling(); // WS works, no need to poll
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { event?: string };
        if (msg.event === "index.changed") void refresh();
      } catch {
        /* ignore malformed frames */
      }
    };

    ws.onclose = () => {
      if (destroyed) return;
      cleanupWs();
      // Immediately start polling so updates aren't lost during retry.
      startPolling();
      // Schedule WS retry with backoff.
      retryTimer = setTimeout(() => {
        if (!destroyed) tryWs();
      }, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };

    ws.onerror = () => {
      // onclose will fire after onerror; no action needed here.
    };
  }

  function startPolling(): void {
    if (pollTimer || destroyed) return;
    syncMode.value = "poll";
    pollTimer = setInterval(() => {
      if (!destroyed) void refresh();
    }, POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function cleanupWs(): void {
    if (wsTimeout) {
      clearTimeout(wsTimeout);
      wsTimeout = null;
    }
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
      ws = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function destroy(): void {
    destroyed = true;
    cleanupWs();
    stopPolling();
    syncMode.value = "off";
  }

  return {
    engine,
    version,
    ready,
    loading,
    lastError,
    syncMode,
    init,
    refresh,
    destroy,
  };
});
