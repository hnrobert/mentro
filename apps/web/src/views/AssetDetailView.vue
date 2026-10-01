<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "@/components/ui/Button.vue";
import { api, apiBlob } from "@/api/client";
import { moveAsset, fetchGroups, type GroupNode } from "@/api/library";
import PdfPreview from "@/components/PdfPreview.vue";
import {
  ChevronRight,
  PanelRightClose,
  PanelRightOpen,
  Shield,
} from "lucide-vue-next";
import PermissionDialog from "@/components/PermissionDialog.vue";
import { useAuthStore } from "@/stores/auth";
import { useCartStore } from "@/stores/cart";

const route = useRoute();
const router = useRouter();
const cart = useCartStore();
const authStore = useAuthStore();
const permOpen = ref(false);

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
  hidden?: boolean;
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
    // Deep link (?page=N from search): open at that page and scroll it
    // into view; otherwise show the first page. No history push — the
    // deep link itself IS the first entry.
    const page = Number(route.query.page);
    const target =
      Number.isInteger(page) && page >= 1
        ? units.value.find((u) => u.ordinal === page)
        : undefined;
    setActive(target ?? units.value[0], { updateRoute: false });
    if (target) await revealUnit(target);
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

/** One history entry per viewed page: Back returns to the previously
 *  found page instead of leaving the file. */
function setActive(u: DetailUnit, opts: { updateRoute?: boolean } = {}): void {
  active.value = u;
  void loadPreview(u);
  const wantsRoute = opts.updateRoute ?? true;
  const current = route.query.page;
  const next = String(u.ordinal);
  if (wantsRoute && current !== next) {
    void router.push({
      query: { ...route.query, page: next },
    });
  }
}

/** Any click inside a unit row targets it — except cart checkbox
 *  (stop-propagated) and drag-selection of the expanded text. A plain
 *  click in the text body still activates the page preview; selecting
 *  text (non-empty selection) must not switch pages under the cursor. */
function rowClick(u: DetailUnit, ev: MouseEvent): void {
  const target = ev.target as HTMLElement;
  if (target.closest('input[type="checkbox"]')) return;
  if (window.getSelection()?.toString()) return;
  setActive(u);
}

/** Open + scroll a unit into view (deep link / back navigation) and
 *  flash it so the landing spot is obvious. Double-RAF waits for the
 *  list to lay out before scrolling. */
async function revealUnit(u: DetailUnit): Promise<void> {
  await nextTick();
  await new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)),
  );
  const el = document.getElementById(`unit-${u.id}`);
  if (el) {
    el.setAttribute("open", "");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("unit-landed");
    setTimeout(() => el.classList.remove("unit-landed"), 2000);
  }
}

// Back/forward between page routes re-targets the view.
watch(
  () => route.query.page,
  (page) => {
    const n = Number(page);
    const target =
      Number.isInteger(n) && n >= 1
        ? units.value.find((u) => u.ordinal === n)
        : undefined;
    if (target && target.id !== active.value?.id) {
      setActive(target, { updateRoute: false });
      void revealUnit(target);
    }
  },
);

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

// --- preview pane geometry: resizable + collapsible (xl+), stacked
//     below the content on smaller screens ---

const XL_QUERY = "(min-width: 1280px)"; // tailwind xl breakpoint
const isXl = ref(
  typeof window !== "undefined" && window.matchMedia(XL_QUERY).matches,
);
let xlMq: MediaQueryList | null = null;
const onXlChange = (): void => {
  isXl.value = xlMq?.matches ?? false;
};

const PREVIEW_MIN = 320;
const previewWidth = ref(
  ((): number => {
    const stored = Number(localStorage.getItem("mentro:preview-w"));
    const max = Math.max(PREVIEW_MIN, window.innerWidth - 560);
    // Default split: preview half the window, the page list the other
    // half (clamped so the list keeps a usable minimum).
    const fallback = Math.round(window.innerWidth * 0.5);
    return Number.isFinite(stored)
      ? Math.min(max, Math.max(PREVIEW_MIN, stored))
      : Math.min(max, Math.max(PREVIEW_MIN, fallback));
  })(),
);
const previewCollapsed = ref(
  localStorage.getItem("mentro:preview-collapsed") === "1",
);
const resizingPreview = ref(false);

function startPreviewResize(ev: MouseEvent): void {
  ev.preventDefault();
  resizingPreview.value = true;
  const move = (e: MouseEvent): void => {
    // The pane hugs the right edge (root padding ~24px): width follows
    // the pointer from the right.
    const max = Math.max(PREVIEW_MIN, window.innerWidth - 560);
    previewWidth.value = Math.min(
      max,
      Math.max(PREVIEW_MIN, window.innerWidth - e.clientX - 24),
    );
  };
  const up = (): void => {
    resizingPreview.value = false;
    localStorage.setItem("mentro:preview-w", String(previewWidth.value));
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function togglePreview(): void {
  previewCollapsed.value = !previewCollapsed.value;
  localStorage.setItem(
    "mentro:preview-collapsed",
    previewCollapsed.value ? "1" : "0",
  );
}

// --- cart: multi-select croppable pages (page/slide units) ---

const selectable = (u: DetailUnit) =>
  u.unitType === "page" || u.unitType === "slide";
const selectableUnits = computed(() => units.value.filter(selectable));
const allSelected = computed(
  () =>
    selectableUnits.value.length > 0 &&
    selectableUnits.value.every((u) => cart.has(u.id)),
);

function toggleCart(u: DetailUnit): void {
  cart.toggle({
    unitId: u.id,
    assetId: String(route.params.id),
    ordinal: u.ordinal,
    unitType: u.unitType,
    title: u.title,
    fileName: asset.value?.path.split("/").pop() ?? "file",
  });
}

function toggleAll(): void {
  const target = selectableUnits.value;
  if (allSelected.value) {
    for (const u of target) {
      if (cart.has(u.id)) cart.remove(u.id);
    }
  } else {
    cart.addMany(
      target.map((u) => ({
        unitId: u.id,
        assetId: String(route.params.id),
        ordinal: u.ordinal,
        unitType: u.unitType,
        title: u.title,
        fileName: asset.value?.path.split("/").pop() ?? "file",
      })),
    );
  }
}

onUnmounted(() => {
  for (const url of previews.value.values()) URL.revokeObjectURL(url);
  xlMq?.removeEventListener("change", onXlChange);
});

onMounted(() => {
  xlMq = window.matchMedia(XL_QUERY);
  isXl.value = xlMq.matches;
  xlMq.addEventListener("change", onXlChange);
  void load();
  void loadGroups();
});
</script>

<template>
  <!-- Column below xl (preview stacks under the list), row at xl+. -->
  <div
    class="flex flex-col items-start gap-6 p-6 xl:flex-row"
    :class="{ 'select-none': resizingPreview }"
  >
    <!-- Left: metadata + unit list. With a preview (xl+) it fills the
         left half; without one it stays a centered reading column. -->
    <div
      class="mx-auto min-w-0 flex-1 max-lg:mx-auto lg:mx-0 lg:max-w-2xl"
      :class="renderable ? 'xl:max-w-none' : ''"
    >
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
            <Button
              v-if="authStore.user?.role === 'super_admin'"
              size="sm"
              variant="outline"
              title="Permissions"
              @click="permOpen = true"
            >
              <Shield class="h-4 w-4" />
            </Button>
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
        <div class="mb-2 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-muted-foreground">
            Content Units（{{ units.length }}）
          </h2>
          <button
            v-if="selectableUnits.length > 0"
            class="text-xs text-muted-foreground hover:underline"
            @click="toggleAll"
          >
            {{ allSelected ? "deselect all" : "select all pages" }}
            ({{ cart.items.filter((i) => i.assetId === asset?.id).length }} in
            cart)
          </button>
        </div>
        <div class="space-y-2">
          <details
            v-for="u in units"
            :id="`unit-${u.id}`"
            :key="u.id"
            class="rounded-lg border p-3 text-sm transition-colors"
            :class="[
              active?.id === u.id ? 'border-primary/60' : '',
              cart.has(u.id) ? 'bg-accent/30' : '',
            ]"
            @toggle="($event.target as HTMLDetailsElement).open && setActive(u)"
            @click="rowClick(u, $event)"
          >
            <summary
              class="flex cursor-pointer select-none list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden"
            >
              <ChevronRight
                class="unit-chevron h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200"
              />
              <input
                v-if="selectable(u)"
                type="checkbox"
                class="h-4 w-4 shrink-0 accent-current"
                :checked="cart.has(u.id)"
                @click.stop="toggleCart(u)"
              />
              <span class="shrink-0">{{ u.unitType }} {{ u.ordinal }}</span>
              <span
                v-if="u.hidden"
                title="Hidden slide in the source deck (show=0)"
                class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                hidden
              </span>
              <span
                v-if="u.title"
                class="min-w-0 truncate font-normal text-muted-foreground"
              >
                {{ u.title.slice(0, 60) }}
              </span>
            </summary>
            <pre
              class="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground"
              >{{ u.text || "(no text)" }}</pre>
          </details>
        </div>
      </template>

      <style scoped>
        details[open] > summary .unit-chevron {
          transform: rotate(90deg);
        }
        .unit-landed {
          outline: 2px solid hsl(var(--primary, 0 0% 9%) / 0.6);
          outline-offset: 2px;
          transition: outline-color 1.5s ease;
        }
      </style>
    </div>

    <!-- Page preview. Below xl it stacks UNDER the list (phones); at xl+
         it is the right pane: width draggable via its left edge,
         collapsible to a slim strip. Fixed height either way — loading
         an image never changes the page height. -->
    <aside
      v-if="renderable"
      class="order-last sticky bottom-0 flex h-[42vh] w-full flex-col overflow-hidden rounded-lg border bg-background shadow-lg xl:sticky xl:bottom-auto xl:top-0 xl:h-[calc(100vh-3rem)] xl:shrink-0 xl:shadow-none"
      :class="{ 'xl:hidden': previewCollapsed }"
      :style="isXl ? { width: `${previewWidth}px` } : undefined"
    >
      <!-- Width drag handle (xl+): straddles the pane's left border -->
      <div
        class="absolute -left-1 top-0 z-30 hidden h-full w-2 cursor-col-resize select-none hover:bg-foreground/20 active:bg-foreground/30 xl:block"
        title="Drag to resize"
        @mousedown="startPreviewResize"
      />
      <div
        class="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2"
      >
        <span class="truncate text-sm font-medium">
          {{ active ? `${active.unitType} ${active.ordinal}` : "Preview" }}
          <span v-if="active?.title" class="ml-2 text-xs text-muted-foreground">
            {{ active.title.slice(0, 48) }}
          </span>
        </span>
        <span class="flex shrink-0 items-center gap-1">
          <span class="max-w-[16rem] truncate text-xs text-muted-foreground">
            {{ asset?.path.split("/").pop() }}
          </span>
          <button
            class="hidden rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground xl:block"
            title="Hide preview"
            @click="togglePreview"
          >
            <PanelRightClose class="h-4 w-4" />
          </button>
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

    <!-- Collapsed (xl+): slim strip at the far right to bring it back -->
    <aside
      v-if="renderable && previewCollapsed"
      class="sticky top-0 hidden h-[calc(100vh-3rem)] w-10 shrink-0 flex-col items-center gap-3 rounded-lg border bg-muted/30 py-3 xl:flex"
    >
      <button
        class="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="Show preview"
        @click="togglePreview"
      >
        <PanelRightOpen class="h-4 w-4" />
      </button>
      <span
        class="select-none text-[10px] font-medium uppercase tracking-widest text-muted-foreground"
        style="writing-mode: vertical-rl"
      >
        Preview
      </span>
    </aside>

    <PermissionDialog
      v-if="permOpen && asset"
      target-type="asset"
      :target-id="String(route.params.id)"
      :name="asset.path.split('/').pop() ?? 'file'"
      @close="permOpen = false"
    />

    <PdfPreview
      v-if="showPdf && asset"
      :asset-id="route.params.id as string"
      :file-name="asset.path.split('/').pop() ?? 'file'"
      :initial-page="active?.ordinal ?? 1"
      @close="showPdf = false"
    />
  </div>
</template>

<style scoped>
details[open] > summary .unit-chevron {
  transform: rotate(90deg);
}
.unit-landed {
  outline: 2px solid hsl(var(--primary, 0 0% 9%) / 0.6);
  outline-offset: 2px;
  transition: outline-color 1.5s ease;
}
</style>
