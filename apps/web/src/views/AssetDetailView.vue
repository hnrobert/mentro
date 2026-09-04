<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import Button from "@/components/ui/Button.vue";
import { api, apiBlob } from "@/api/client";
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
    // Show the first page in the preview pane immediately.
    if (units.value.length > 0) setActive(units.value[0]);
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

// --- right-pane page preview (render-on-miss via /api/thumbs) ---

const RENDERABLE = new Set(["pdf", "presentation", "document"]);
const renderable = computed(() => RENDERABLE.has(asset.value?.kind ?? ""));

const active = ref<DetailUnit | null>(null);
const previews = ref(new Map<string, string>()); // unitId -> object URL
const loadingIds = ref(new Set<string>());
const failedIds = ref(new Set<string>());

function setActive(u: DetailUnit): void {
  active.value = u;
  void loadPreview(u);
}

async function loadPreview(u: DetailUnit): Promise<void> {
  if (!renderable.value) return;
  if (
    previews.value.has(u.id) ||
    loadingIds.value.has(u.id) ||
    failedIds.value.has(u.id)
  ) {
    return;
  }
  loadingIds.value.add(u.id);
  try {
    const blob = await apiBlob(`/api/thumbs/${u.id}?full=1`);
    previews.value.set(u.id, URL.createObjectURL(blob));
  } catch {
    failedIds.value.add(u.id); // pane shows a retry affordance
  } finally {
    loadingIds.value.delete(u.id);
  }
}

function retryPreview(): void {
  const u = active.value;
  if (!u) return;
  failedIds.value.delete(u.id);
  void loadPreview(u);
}

onUnmounted(() => {
  for (const url of previews.value.values()) URL.revokeObjectURL(url);
});

onMounted(() => {
  void load();
  void loadGroups();
});
</script>

<template>
  <div class="flex items-start gap-6 p-6">
    <!-- Left: metadata + unit list -->
    <div class="mx-auto min-w-0 flex-1 max-lg:mx-auto lg:mx-0 lg:max-w-2xl">
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
            class="rounded-lg border p-3 text-sm transition-colors"
            :class="active?.id === u.id ? 'border-primary/60' : ''"
            @toggle="($event.target as HTMLDetailsElement).open && setActive(u)"
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
    </div>

    <!-- Right: sticky page preview pane (fixed height — loading an image
         never changes the page height). Hidden below lg. -->
    <aside
      v-if="renderable"
      class="sticky top-0 hidden h-[calc(100vh-3rem)] w-[46%] shrink-0 flex-col overflow-hidden rounded-lg border bg-muted/20 xl:flex"
    >
      <div
        class="flex shrink-0 items-baseline justify-between border-b px-3 py-2"
      >
        <span class="truncate text-sm font-medium">
          {{ active ? `${active.unitType} ${active.ordinal}` : "Preview" }}
          <span v-if="active?.title" class="ml-2 text-xs text-muted-foreground">
            {{ active.title.slice(0, 48) }}
          </span>
        </span>
        <span class="shrink-0 text-xs text-muted-foreground">
          {{ asset?.path.split("/").pop() }}
        </span>
      </div>
      <div
        class="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3"
      >
        <img
          v-if="active && previews.has(active.id)"
          :src="previews.get(active.id)"
          :alt="`page ${active?.ordinal} preview`"
          class="max-h-full max-w-full rounded-md object-contain shadow-sm"
        />
        <p
          v-else-if="active && loadingIds.has(active.id)"
          class="animate-pulse text-sm text-muted-foreground"
        >
          Rendering page preview… (first view of a large deck converts the whole
          document)
        </p>
        <div
          v-else-if="active && failedIds.has(active.id)"
          class="flex flex-col items-center gap-2"
        >
          <p class="text-sm text-muted-foreground">Preview unavailable</p>
          <Button size="sm" variant="outline" @click="retryPreview">
            Retry
          </Button>
        </div>
        <p v-else class="text-sm text-muted-foreground">
          Expand a page to preview it
        </p>
      </div>
    </aside>

    <PdfPreview
      v-if="showPdf && asset"
      :asset-id="route.params.id as string"
      :file-name="asset.path.split('/').pop() ?? 'file'"
      :initial-page="active?.ordinal ?? 1"
      @close="showPdf = false"
    />
  </div>
</template>
