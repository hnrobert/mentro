<script setup lang="ts">
import { computed, ref } from "vue";
import Button from "@/components/ui/Button.vue";
import { api, apiBlob } from "@/api/client";
import { useCartStore } from "@/stores/cart";

/**
 * Cart drawer: review selected pages grouped by file, then export in one
 * click. "Selected pages" crops each file natively (deck -> cropped pptx
 * with its theme, pdf -> cropped pdf) and zips across files; "Original
 * files" downloads the unmodified originals (zip when several).
 */

const emit = defineEmits<{ close: [] }>();
const cart = useCartStore();

const busy = ref<"" | "native" | "original">("");
const error = ref("");

const croppableKinds = new Set(["pdf", "presentation", "document"]);
const kindByAsset = ref(new Map<string, string>()); // assetId -> kind

// Fetch asset kinds once (validates croppability for the export call).
async function ensureKinds(): Promise<void> {
  for (const assetId of cart.byAsset.keys()) {
    if (kindByAsset.value.has(assetId)) continue;
    try {
      const res = await api<{ asset: { kind: string } }>(
        `/api/assets/${assetId}`,
      );
      kindByAsset.value.set(assetId, res.asset.kind);
    } catch {
      kindByAsset.value.set(assetId, "unknown");
    }
  }
}
void ensureKinds();

const hasCroppable = computed(() =>
  [...cart.byAsset.keys()].some((id) =>
    croppableKinds.has(kindByAsset.value.get(id) ?? "unknown"),
  ),
);

interface ExportStatus {
  id: string;
  status: string;
  artifactPath: string | null;
  artifacts?: string[];
  error?: string | null;
}

async function waitForJob(jobId: string): Promise<ExportStatus> {
  for (let i = 0; i < 600; i++) {
    const job = await api<ExportStatus>(`/api/export/${jobId}`);
    if (job.status === "done") return job;
    if (job.status === "failed") {
      throw new Error(job.error ?? "export failed");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("export timed out");
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function download(mode: "native" | "original"): Promise<void> {
  if (cart.items.length === 0) return;
  error.value = "";
  busy.value = mode;
  try {
    await ensureKinds();
    // "original" ignores ordinals; one ref per distinct asset.
    const units =
      mode === "native"
        ? cart.items.map((i) => ({
            assetId: i.assetId,
            ordinal: i.ordinal,
          }))
        : [...cart.byAsset.keys()].map((assetId) => {
            const item = cart.items.find((i) => i.assetId === assetId);
            return { assetId, ordinal: item?.ordinal ?? 1 };
          });
    const { jobId } = await api<{ jobId: string }>("/api/export", {
      method: "POST",
      body: JSON.stringify({ units, format: mode }),
    });
    const job = await waitForJob(jobId);
    if (!job.artifactPath) throw new Error("no artifact produced");
    const blob = await apiBlob(`/api/export/${jobId}/file`);
    saveBlob(blob, job.artifactPath.split("/").pop() ?? `mentro-${mode}`);
    cart.clear();
    emit("close");
  } catch (err) {
    error.value = String(err);
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex justify-end bg-black/40"
    @click.self="emit('close')"
  >
    <div
      class="flex h-full w-full max-w-md flex-col border-l bg-background shadow-xl"
    >
      <div
        class="flex shrink-0 items-center justify-between border-b px-4 py-3"
      >
        <h2 class="text-base font-semibold">
          Cart
          <span class="ml-1 text-sm font-normal text-muted-foreground">
            {{ cart.count }} page{{ cart.count === 1 ? "" : "s" }}
          </span>
        </h2>
        <button
          class="rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <p v-if="cart.items.length === 0" class="text-sm text-muted-foreground">
          No pages selected. Open a file and check the pages you want.
        </p>

        <div
          v-for="[assetId, list] of cart.byAsset"
          :key="assetId"
          class="mb-4 rounded-lg border p-3"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="min-w-0 truncate text-sm font-medium">
              {{ list[0].fileName }}
            </span>
            <button
              class="shrink-0 text-xs text-destructive hover:underline"
              @click="cart.removeAsset(assetId)"
            >
              remove all
            </button>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <span
              v-for="item in list"
              :key="item.unitId"
              class="group inline-flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs"
              :title="item.title ?? `${item.unitType} ${item.ordinal}`"
            >
              {{ item.unitType }} {{ item.ordinal }}
              <button
                class="text-muted-foreground hover:text-destructive"
                @click="cart.remove(item.unitId)"
              >
                ✕
              </button>
            </span>
          </div>
        </div>
      </div>

      <div class="shrink-0 space-y-2 border-t p-4">
        <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
        <Button
          class="w-full"
          :disabled="cart.items.length === 0 || busy !== '' || !hasCroppable"
          @click="download('native')"
        >
          {{ busy === "native" ? "Exporting…" : "Download selected pages" }}
        </Button>
        <p class="text-[11px] leading-snug text-muted-foreground">
          Selected pages: each file is cropped natively (PPT keeps its theme,
          PDF keeps its pages); several files arrive as one zip.
        </p>
        <Button
          class="w-full"
          variant="outline"
          :disabled="cart.items.length === 0 || busy !== ''"
          @click="download('original')"
        >
          {{ busy === "original" ? "Packing…" : "Download original files" }}
        </Button>
        <div class="flex justify-between pt-1">
          <button
            class="text-xs text-muted-foreground hover:underline"
            :disabled="cart.items.length === 0"
            @click="cart.clear()"
          >
            clear cart
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
