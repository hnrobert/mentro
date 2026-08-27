<script setup lang="ts">
/** PDF preview overlay: fetches the file with auth, renders the target
 * page to a canvas, prev/next navigation. */

import { onBeforeUnmount, ref, watch } from "vue";
import Button from "@/components/ui/Button.vue";
import { loadAuth } from "@/api/client";

// pdfjs-dist worker must come from the same version; ship it via Vite.
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const props = defineProps<{
  assetId: string;
  fileName: string;
  initialPage: number;
}>();

const emit = defineEmits<{ close: [] }>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const page = ref(Math.max(1, props.initialPage));
const pageCount = ref(0);
const status = ref("Loading…");

let doc: pdfjs.PDFDocumentProxy | null = null;
let renderTask: { cancel(): void } | null = null;

async function load(): Promise<void> {
  status.value = "Loading…";
  const auth = loadAuth();
  const res = await fetch(`/api/assets/${props.assetId}/file`, {
    headers: auth?.accessToken
      ? { authorization: `Bearer ${auth.accessToken}` }
      : undefined,
  });
  if (!res.ok) {
    status.value = `Failed to load (HTTP ${res.status})`;
    return;
  }
  const data = new Uint8Array(await res.arrayBuffer());
  doc = await pdfjs.getDocument({ data }).promise;
  pageCount.value = doc.numPages;
  await render();
}

async function render(): Promise<void> {
  if (!doc || !canvasRef.value) return;
  renderTask?.cancel();
  const p = await doc.getPage(Math.min(page.value, doc.numPages));
  const scale = Math.min(2, 900 / p.getViewport({ scale: 1 }).width);
  const viewport = p.getViewport({ scale });
  const canvas = canvasRef.value;
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const task = p.render({
    canvas,
    canvasContext: canvas.getContext("2d")!,
    viewport,
  });
  renderTask = task as unknown as { cancel(): void };
  await task.promise.catch(() => undefined);
  status.value = "";
}

watch(page, () => void render());
watch(
  () => props.assetId,
  () => {
    page.value = Math.max(1, props.initialPage);
    void load();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  renderTask?.cancel();
  void doc?.cleanup();
});

function go(delta: number): void {
  const next = page.value + delta;
  if (next >= 1 && next <= pageCount.value) page.value = next;
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div class="flex items-center justify-between gap-3 p-3 text-sm text-white">
      <span class="truncate font-medium">{{ fileName }}</span>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          :disabled="page <= 1"
          @click="go(-1)"
        >
          Prev
        </Button>
        <span>{{ page }} / {{ pageCount || "…" }}</span>
        <Button
          variant="outline"
          size="sm"
          :disabled="page >= pageCount"
          @click="go(1)"
        >
          Next
        </Button>
        <Button variant="ghost" size="sm" @click="emit('close')">Close</Button>
      </div>
    </div>
    <div class="flex flex-1 items-center justify-center overflow-auto p-4">
      <p v-if="status" class="text-sm text-white/70">{{ status }}</p>
      <canvas ref="canvasRef" class="max-h-full rounded shadow-2xl"></canvas>
    </div>
  </div>
</template>
