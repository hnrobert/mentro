<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import Button from "@/components/ui/Button.vue";
import { api } from "@/api/client";
import { moveAsset, fetchGroups, type GroupNode } from "@/api/library";
import PdfPreview from "@/components/PdfPreview.vue";

const route = useRoute();

interface DetailAsset {
  id: string;
  path: string;
  kind: string;
  sizeBytes: number;
  mime: string | null;
  groupId: string | null;
  uploadedAt: string | null;
  extractionStatus: string;
}

interface DetailUnit {
  id: string;
  ordinal: number;
  unitType: string;
  title: string | null;
  text: string | null;
  thumbPath: string | null;
}

const asset = ref<DetailAsset | null>(null);
const units = ref<DetailUnit[]>([]);
const groups = ref<GroupNode[]>([]);
const loading = ref(true);
const error = ref("");
const showPdf = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await api<{ asset: DetailAsset; units: DetailUnit[] }>(
      `/api/assets/${route.params.id}`,
    );
    asset.value = res.asset;
    units.value = res.units;
  } catch (err) {
    error.value = String(err);
  } finally {
    loading.value = false;
  }
}

async function loadGroups(): Promise<void> {
  try {
    const tree = await fetchGroups();
    groups.value = tree.groups;
  } catch {
    groups.value = [];
  }
}

async function changeGroup(event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement;
  const gid = select.value || null;
  if (!asset.value) return;
  await moveAsset(asset.value.id, gid);
  asset.value.groupId = gid;
}

function fmtSize(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

function flatten(nodes: GroupNode[]): GroupNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

function previewUrl(): string {
  return `/api/assets/${route.params.id}/file`;
}

onMounted(() => {
  void load();
  void loadGroups();
});
</script>

<template>
  <div class="mx-auto max-w-4xl p-6">
    <p v-if="loading" class="text-sm text-muted-foreground">Loading…</p>
    <p v-else-if="error" class="text-sm text-destructive">{{ error }}</p>
    <template v-else-if="asset">
      <!-- Header -->
      <div class="mb-4 flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h1 class="truncate text-xl font-semibold tracking-tight">
            {{ asset.path.split("/").pop() }}
          </h1>
          <p class="mt-1 text-xs text-muted-foreground">
            {{ asset.path }}
          </p>
        </div>
        <div class="flex shrink-0 gap-2">
          <Button
            v-if="
              asset.kind === 'pdf' ||
              asset.kind === 'presentation' ||
              asset.kind === 'document'
            "
            size="sm"
            @click="showPdf = true"
          >
            Preview
          </Button>
          <a :href="previewUrl()" target="_blank">
            <Button size="sm" variant="outline">Download</Button>
          </a>
        </div>
      </div>

      <!-- Metadata -->
      <div class="mb-6 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <div class="rounded-lg border p-3">
          <p class="text-xs text-muted-foreground">Type</p>
          <p class="mt-1 font-medium">{{ asset.kind }}</p>
        </div>
        <div class="rounded-lg border p-3">
          <p class="text-xs text-muted-foreground">Size</p>
          <p class="mt-1 font-medium">{{ fmtSize(asset.sizeBytes) }}</p>
        </div>
        <div class="rounded-lg border p-3">
          <p class="text-xs text-muted-foreground">Index Status</p>
          <p class="mt-1 font-medium">{{ asset.extractionStatus }}</p>
        </div>
        <div class="rounded-lg border p-3 sm:col-span-2">
          <p class="text-xs text-muted-foreground">Group</p>
          <select
            class="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm"
            :value="asset.groupId ?? ''"
            @change="changeGroup"
          >
            <option value="">Ungrouped</option>
            <option v-for="g in flatten(groups)" :key="g.id" :value="g.id">
              {{ g.name }}
            </option>
          </select>
        </div>
        <div class="rounded-lg border p-3">
          <p class="text-xs text-muted-foreground">Added</p>
          <p class="mt-1 font-medium">
            {{
              asset.uploadedAt
                ? new Date(asset.uploadedAt).toLocaleString("zh-CN")
                : "—"
            }}
          </p>
        </div>
      </div>

      <!-- Content units -->
      <h2 class="mb-2 text-sm font-semibold text-muted-foreground">
        Content Units（{{ units.length }}）
      </h2>
      <div class="space-y-2">
        <details
          v-for="u in units"
          :key="u.id"
          class="rounded-lg border p-3 text-sm"
        >
          <summary class="cursor-pointer select-none font-medium">
            {{ u.unitType }} {{ u.ordinal }}
            <span v-if="u.title" class="ml-2 text-muted-foreground">
              {{ u.title.slice(0, 60) }}
            </span>
          </summary>
          <pre
            class="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground"
            >{{ u.text || "(no text)" }}</pre>
        </details>
      </div>
    </template>

    <PdfPreview
      v-if="showPdf && asset"
      :asset-id="route.params.id as string"
      :file-name="asset.path.split('/').pop() ?? 'file'"
      :initial-page="1"
      @close="showPdf = false"
    />
  </div>
</template>
