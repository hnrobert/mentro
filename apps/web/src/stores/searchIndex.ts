/** Owns the local search engine: initial bundle load + WS delta merge. */

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

export const useSearchIndexStore = defineStore("searchIndex", () => {
  const engine = shallowRef<SearchEngine>(new MiniSearchEngine());
  const version = ref(0);
  const ready = ref(false);
  const loading = ref(false);
  const lastError = ref("");

  async function init(): Promise<void> {
    if (ready.value || loading.value) return;
    loading.value = true;
    try {
      const bundle = await api<FullBundle>("/api/index");
      engine.value.replaceAll(bundle.units);
      version.value = bundle.version;
      ready.value = true;
      connectWs();
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
      // Fall back to a full reload on any inconsistency.
      const bundle = await api<FullBundle>("/api/index");
      engine.value.replaceAll(bundle.units);
      version.value = bundle.version;
    }
  }

  function applyDelta(delta: DeltaBundle): void {
    engine.value.applyDelta(delta.upserted, delta.removed);
    version.value = delta.version;
  }

  let ws: WebSocket | null = null;
  let retryMs = 1000;

  function connectWs(): void {
    const auth = loadAuth();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/api/ws${
      auth?.accessToken ? `?token=${encodeURIComponent(auth.accessToken)}` : ""
    }`;
    ws = new WebSocket(url);
    ws.onopen = () => {
      retryMs = 1000;
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
      setTimeout(connectWs, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
  }

  return { engine, version, ready, loading, lastError, init, refresh };
});
