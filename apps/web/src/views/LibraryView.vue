<script setup lang="ts">
import { Pencil, Plus, Shield, Trash2 } from "lucide-vue-next";
import PermissionDialog from "@/components/PermissionDialog.vue";
import { useAuthStore } from "@/stores/auth";

const authStore = useAuthStore();
const permTarget = ref<{
  targetType: "group" | "asset";
  targetId: string;
  name: string;
} | null>(null);
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import Button from "@/components/ui/Button.vue";
import Input from "@/components/ui/Input.vue";
import {
  createGroup,
  deleteGroup,
  deleteAsset,
  fetchGroups,
  fetchLibrary,
  renameGroup,
  type GroupNode,
  type LibraryAsset,
} from "@/api/library";

const emit = defineEmits<{ "library-changed": [] }>();
const router = useRouter();

const groups = ref<GroupNode[]>([]);
const ungrouped = ref(0);
const selectedGroup = ref<string | null>(null); // null = all, "ungrouped" = no group
const assets = ref<LibraryAsset[]>([]);
const total = ref(0);
const page = ref(1);
const search = ref("");
const sortKey = ref<"uploaded" | "mtime" | "size" | "name">("uploaded");
const sortDir = ref<"asc" | "desc">("desc");
const kindFilter = ref<string[]>([]); // empty = all
const statusFilter = ref<string[]>([]);
const openMenu = ref<string | null>(null); // column key of open menu
const busy = ref(false);
const newGroupName = ref("");
const showInput = ref<string | null>(null); // group id being renamed
const renameValue = ref("");

// --- Resizable columns ---
// Column keys match the data row order: filename, type, size, added, fileTime, status, actions
interface ColDef {
  key: string;
  width: number;
  min: number;
  /** The last column (actions) has no resizer */
  resizable: boolean;
}

const cols = ref<ColDef[]>([
  { key: "name", width: 0, min: 120, resizable: true }, // 0 = flex (1fr)
  { key: "kind", width: 64, min: 48, resizable: true },
  { key: "size", width: 80, min: 56, resizable: true },
  { key: "uploaded", width: 96, min: 64, resizable: true },
  { key: "mtime", width: 96, min: 64, resizable: true },
  { key: "status", width: 72, min: 56, resizable: true },
  { key: "actions", width: 48, min: 48, resizable: false },
]);

const gridTemplate = computed(() =>
  cols.value
    .map((c) => (c.width === 0 ? "minmax(0,1fr)" : `${c.width}px`))
    .join(" "),
);

const gridStyle = computed(() => ({
  gridTemplateColumns: gridTemplate.value,
}));

let resizeCol: number | null = null;
let resizeStartX = 0;
let resizeStartW = 0;

function startResize(event: MouseEvent, index: number): void {
  event.preventDefault();
  event.stopPropagation();
  resizeCol = index;
  resizeStartX = event.clientX;
  resizeStartW = cols.value[index].width || 120;
  document.addEventListener("mousemove", onResize);
  document.addEventListener("mouseup", stopResize);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function onResize(event: MouseEvent): void {
  if (resizeCol === null) return;
  const delta = event.clientX - resizeStartX;
  const col = cols.value[resizeCol];
  const newW = Math.max(col.min, resizeStartW + delta);
  // If the flex column is being resized, switch it to fixed
  if (col.width === 0 && delta > 0) {
    col.width = resizeStartW + delta;
  } else {
    col.width = newW;
  }
}

function stopResize(): void {
  resizeCol = null;
  document.removeEventListener("mousemove", onResize);
  document.removeEventListener("mouseup", stopResize);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

async function loadGroups(): Promise<void> {
  const tree = await fetchGroups();
  groups.value = tree.groups;
  ungrouped.value = tree.ungrouped;
}

async function loadAssets(): Promise<void> {
  busy.value = true;
  try {
    const res = await fetchLibrary({
      groupId:
        selectedGroup.value === null
          ? undefined
          : (selectedGroup.value ?? "ungrouped"),
      q: search.value || undefined,
      kind: kindFilter.value.length === 1 ? kindFilter.value[0] : undefined,
      sort: sortKey.value,
      sortDir: sortDir.value,
      page: page.value,
      pageSize: 50,
    });
    let list = res.assets;
    if (statusFilter.value.length > 0) {
      list = list.filter((a) =>
        statusFilter.value.includes(a.extractionStatus),
      );
    }
    assets.value = list;
    total.value = statusFilter.value.length > 0 ? list.length : res.total;
  } finally {
    busy.value = false;
  }
}

watch(selectedGroup, () => {
  page.value = 1;
  void loadAssets();
});
watch(page, () => void loadAssets());
watch([sortKey, sortDir], () => void loadAssets());
watch(kindFilter, () => {
  page.value = 1;
  void loadAssets();
});
watch(statusFilter, () => void loadAssets());

let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page.value = 1;
    void loadAssets();
  }, 300);
});

async function addGroup(): Promise<void> {
  const name = newGroupName.value.trim();
  if (!name) return;
  await createGroup(name, selectedGroup.value);
  newGroupName.value = "";
  await loadGroups();
}

function startRename(g: GroupNode): void {
  showInput.value = g.id;
  renameValue.value = g.name;
}

async function commitRename(): Promise<void> {
  if (showInput.value && renameValue.value.trim()) {
    await renameGroup(showInput.value, renameValue.value.trim());
  }
  showInput.value = null;
  await loadGroups();
}

async function removeGroup(g: GroupNode): Promise<void> {
  if (!confirm(`Delete group "${g.name}"? (must be empty)`)) return;
  try {
    await deleteGroup(g.id);
    if (selectedGroup.value === g.id) selectedGroup.value = null;
    await loadGroups();
  } catch (err) {
    alert(String(err));
  }
}

async function removeAsset(a: LibraryAsset): Promise<void> {
  if (
    !confirm(
      `Delete "${a.path.split("/").pop()}"? This removes both the index and the file.`,
    )
  )
    return;
  try {
    await deleteAsset(a.id);
    await Promise.all([loadAssets(), loadGroups()]);
    emit("library-changed");
  } catch (err) {
    alert(String(err));
  }
}

function openDetail(a: LibraryAsset): void {
  router.push({ name: "asset-detail", params: { id: a.id } });
}

function fmtSize(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n > 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtTime(v: string | number | null): string {
  if (!v) return "—";
  const d = typeof v === "number" ? new Date(v) : new Date(v);
  return d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function kindLabel(k: string): string {
  const map: Record<string, string> = {
    pdf: "PDF",
    presentation: "Slides",
    document: "Docs",
    spreadsheet: "Sheets",
    image: "Images",
    video: "Videos",
    audio: "Audio",
    text: "Text",
    archive: "Archives",
  };
  return map[k] ?? k;
}

function toggleSort(col: "uploaded" | "mtime" | "size" | "name"): void {
  if (sortKey.value === col) {
    if (sortDir.value === "desc") sortDir.value = "asc";
    else {
      // third click resets to default
      sortKey.value = "uploaded";
      sortDir.value = "desc";
    }
  } else {
    sortKey.value = col;
    sortDir.value = "desc";
  }
  openMenu.value = null;
}

function toggleKindFilter(k: string): void {
  const i = kindFilter.value.indexOf(k);
  if (i >= 0) kindFilter.value.splice(i, 1);
  else kindFilter.value.push(k);
}

function toggleStatusFilter(st: string): void {
  const i = statusFilter.value.indexOf(st);
  if (i >= 0) statusFilter.value.splice(i, 1);
  else statusFilter.value.push(st);
}

function clearMenu(): void {
  openMenu.value = null;
}

const KIND_OPTIONS = [
  { v: "pdf", label: "PDF" },
  { v: "presentation", label: "Slides" },
  { v: "document", label: "Docs" },
  { v: "spreadsheet", label: "Sheets" },
  { v: "image", label: "Images" },
  { v: "video", label: "Videos" },
  { v: "audio", label: "Audio" },
  { v: "text", label: "Text" },
  { v: "archive", label: "Archives" },
];

const STATUS_OPTIONS = ["done", "pending", "running", "failed", "skipped"];

function sortIndicator(col: string): string {
  if (sortKey.value !== col) return "";
  return sortDir.value === "desc" ? " ↓" : " ↑";
}

function flatten(
  nodes: GroupNode[],
  depth = 0,
): Array<{ g: GroupNode; depth: number }> {
  const out: Array<{ g: GroupNode; depth: number }> = [];
  for (const n of nodes) {
    out.push({ g: n, depth });
    out.push(...flatten(n.children, depth + 1));
  }
  return out;
}

onUnmounted(() => stopResize());

onMounted(() => {
  void loadGroups();
  void loadAssets();
});
</script>

<template>
  <div class="flex h-full">
    <!-- Group tree sidebar -->
    <div class="w-56 shrink-0 overflow-y-auto border-r p-3">
      <button
        class="mb-0.5 w-full rounded px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent"
        :class="selectedGroup === null ? 'bg-accent font-medium' : ''"
        @click="selectedGroup = null"
      >
        All Files
      </button>
      <button
        class="mb-0.5 w-full rounded px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent"
        :class="selectedGroup === 'ungrouped' ? 'bg-accent font-medium' : ''"
        @click="selectedGroup = 'ungrouped'"
      >
        Ungrouped
        <span class="ml-1 text-xs text-muted-foreground">{{ ungrouped }}</span>
      </button>
      <template v-for="{ g, depth } in flatten(groups)" :key="g.id">
        <div
          class="group flex items-center rounded px-3 py-1.5 text-sm transition-colors hover:bg-accent"
          :class="selectedGroup === g.id ? 'bg-accent font-medium' : ''"
          :style="{ paddingLeft: `${12 + depth * 16}px` }"
        >
          <button
            class="min-w-0 flex-1 truncate text-left"
            @click="selectedGroup = g.id"
          >
            {{ g.name }}
            <span class="ml-1 text-xs text-muted-foreground">{{
              g.fileCount
            }}</span>
          </button>
          <span class="ml-1 hidden shrink-0 gap-0.5 group-hover:flex">
            <button
              v-if="authStore.user?.role === 'super_admin'"
              class="px-1 text-xs text-muted-foreground hover:text-foreground"
              title="Permissions"
              @click.stop="
                permTarget = {
                  targetType: 'group',
                  targetId: g.id,
                  name: g.name,
                }
              "
            >
              <Shield class="h-3.5 w-3.5" />
            </button>
            <button
              class="px-1 text-xs text-muted-foreground hover:text-foreground"
              title="Rename"
              @click.stop="startRename(g)"
            >
              <Pencil class="h-3.5 w-3.5" />
            </button>
            <button
              class="px-1 text-xs text-muted-foreground hover:text-destructive"
              title="Delete"
              @click.stop="removeGroup(g)"
            >
              <Trash2 class="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
        <div v-if="showInput === g.id" class="mb-1 flex gap-1 px-2">
          <Input
            v-model="renameValue"
            class="h-7 text-xs"
            @keyup.enter="commitRename"
            @keyup.esc="showInput = null"
          />
          <Button size="sm" class="h-7 px-2 text-xs" @click="commitRename">
            OK
          </Button>
        </div>
      </template>

      <div class="mt-3 flex gap-1 px-1">
        <Input
          v-model="newGroupName"
          class="h-8 text-xs"
          placeholder="New group..."
        />
        <Button
          size="sm"
          variant="outline"
          class="h-8 px-2 text-xs"
          title="Add group"
          @click="addGroup"
        >
          <Plus class="h-4 w-4" />
        </Button>
      </div>
    </div>

    <!-- Right panel: filter bar + scrollable table (header + rows) -->
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <!-- Filter bar (fixed, above scroll area) -->
      <div
        class="flex shrink-0 items-center gap-3 border-b bg-background px-4 py-2"
      >
        <Input
          v-model="search"
          class="max-w-xs"
          placeholder="Filter by filename..."
        />
        <span class="ml-auto text-sm text-muted-foreground">
          {{ total }} files
        </span>
      </div>

      <!-- Scrollable area: header and rows scroll together (X and Y) -->
      <div class="min-h-0 flex-1 overflow-auto">
        <!-- Sticky header (stays visible during vertical scroll) -->
        <div
          class="sticky top-0 z-10 grid min-w-fit gap-x-2 border-b bg-muted px-4 py-2 text-xs font-medium text-muted-foreground shadow-sm"
          :style="gridStyle"
        >
          <!-- Col 1: Filename (left-aligned, menu) -->
          <div class="relative flex min-w-0 items-center">
            <button
              class="flex items-center gap-0.5 truncate hover:text-foreground"
              @click="openMenu = openMenu === 'name' ? null : 'name'"
            >
              Filename{{ sortIndicator("name") }}
            </button>
            <div
              v-if="openMenu === 'name'"
              class="absolute left-0 top-full z-30 mt-1 w-36 rounded-md border bg-card p-1 text-xs shadow-lg"
            >
              <button
                class="w-full rounded px-2 py-1 text-left hover:bg-accent"
                @click="
                  sortKey = 'name';
                  sortDir = 'asc';
                  openMenu = null;
                "
              >
                Sort A-Z
              </button>
              <button
                class="w-full rounded px-2 py-1 text-left hover:bg-accent"
                @click="
                  sortKey = 'name';
                  sortDir = 'desc';
                  openMenu = null;
                "
              >
                Sort Z-A
              </button>
            </div>
            <div
              class="absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize select-none hover:bg-foreground/20 active:bg-foreground/30"
              @mousedown="startResize($event, 0)"
            />
          </div>

          <!-- Col 2: Type (centered, filter menu) -->
          <div class="relative flex min-w-0 items-center justify-center">
            <button
              class="flex items-center gap-0.5 truncate hover:text-foreground"
              :class="kindFilter.length > 0 ? 'text-foreground' : ''"
              @click="openMenu = openMenu === 'kind' ? null : 'kind'"
            >
              Type{{ kindFilter.length > 0 ? ` (${kindFilter.length})` : "" }}
            </button>
            <div
              v-if="openMenu === 'kind'"
              class="absolute left-0 top-full z-30 mt-1 w-40 rounded-md border bg-card p-1 text-xs shadow-lg"
            >
              <p
                class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Filter by type
              </p>
              <label
                v-for="opt in KIND_OPTIONS"
                :key="opt.v"
                class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-accent"
              >
                <input
                  type="checkbox"
                  :checked="kindFilter.includes(opt.v)"
                  class="h-3 w-3"
                  @change="toggleKindFilter(opt.v)"
                />
                {{ opt.label }}
              </label>
              <button
                v-if="kindFilter.length > 0"
                class="mt-1 w-full rounded px-2 py-1 text-left text-muted-foreground hover:bg-accent"
                @click="kindFilter = []"
              >
                Clear filter
              </button>
            </div>
            <div
              class="absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize select-none hover:bg-foreground/20 active:bg-foreground/30"
              @mousedown="startResize($event, 1)"
            />
          </div>

          <!-- Col 3: Size (centered, sort) -->
          <div class="relative flex min-w-0 items-center justify-center">
            <button
              class="flex items-center gap-0.5 truncate hover:text-foreground"
              @click="toggleSort('size')"
            >
              Size{{ sortIndicator("size") }}
            </button>
            <div
              class="absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize select-none hover:bg-foreground/20 active:bg-foreground/30"
              @mousedown="startResize($event, 2)"
            />
          </div>

          <!-- Col 4: Added (centered, sort) -->
          <div class="relative flex min-w-0 items-center justify-center">
            <button
              class="flex items-center gap-0.5 truncate hover:text-foreground"
              @click="toggleSort('uploaded')"
            >
              Added{{ sortIndicator("uploaded") }}
            </button>
            <div
              class="absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize select-none hover:bg-foreground/20 active:bg-foreground/30"
              @mousedown="startResize($event, 3)"
            />
          </div>

          <!-- Col 5: File Time (centered, sort) -->
          <div class="relative flex min-w-0 items-center justify-center">
            <button
              class="flex items-center gap-0.5 truncate hover:text-foreground"
              @click="toggleSort('mtime')"
            >
              File Time{{ sortIndicator("mtime") }}
            </button>
            <div
              class="absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize select-none hover:bg-foreground/20 active:bg-foreground/30"
              @mousedown="startResize($event, 4)"
            />
          </div>

          <!-- Col 6: Index Status (centered, filter menu) -->
          <div class="relative flex min-w-0 items-center justify-center">
            <button
              class="flex items-center gap-0.5 truncate hover:text-foreground"
              :class="statusFilter.length > 0 ? 'text-foreground' : ''"
              @click="openMenu = openMenu === 'status' ? null : 'status'"
            >
              Index Status{{
                statusFilter.length > 0 ? ` (${statusFilter.length})` : ""
              }}
            </button>
            <div
              v-if="openMenu === 'status'"
              class="absolute left-0 top-full z-30 mt-1 w-36 rounded-md border bg-card p-1 text-xs shadow-lg"
            >
              <p
                class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Filter by status
              </p>
              <label
                v-for="st in STATUS_OPTIONS"
                :key="st"
                class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-accent"
              >
                <input
                  type="checkbox"
                  :checked="statusFilter.includes(st)"
                  class="h-3 w-3"
                  @change="toggleStatusFilter(st)"
                />
                {{ st }}
              </label>
              <button
                v-if="statusFilter.length > 0"
                class="mt-1 w-full rounded px-2 py-1 text-left text-muted-foreground hover:bg-accent"
                @click="statusFilter = []"
              >
                Clear filter
              </button>
            </div>
            <div
              class="absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize select-none hover:bg-foreground/20 active:bg-foreground/30"
              @mousedown="startResize($event, 5)"
            />
          </div>

          <!-- Col 7: Actions (no resizer) -->
          <span />
        </div>

        <!-- Data rows -->
        <div v-if="assets.length > 0" class="min-w-fit divide-y">
          <div
            v-for="a in assets"
            :key="a.id"
            class="grid cursor-pointer items-center gap-x-2 px-4 py-2 text-sm transition-colors hover:bg-accent/30"
            :style="gridStyle"
            @click="openDetail(a)"
          >
            <span class="truncate font-medium">{{
              a.path.split("/").pop()
            }}</span>
            <span class="flex justify-center">
              <span class="rounded bg-muted px-1.5 py-0.5 text-xs">
                {{ kindLabel(a.kind) }}
              </span>
            </span>
            <span class="flex justify-center text-muted-foreground">{{
              fmtSize(a.sizeBytes)
            }}</span>
            <span class="flex justify-center text-muted-foreground">{{
              fmtTime(a.uploadedAt)
            }}</span>
            <span class="flex justify-center text-muted-foreground">{{
              fmtTime(a.mtimeMs)
            }}</span>
            <span class="flex justify-center text-xs text-muted-foreground">{{
              a.extractionStatus
            }}</span>
            <span class="text-right">
              <button
                class="px-1 text-xs text-muted-foreground hover:text-destructive"
                title="Delete"
                @click.stop="removeAsset(a)"
              >
                Delete
              </button>
            </span>
          </div>
        </div>
        <p
          v-else-if="!busy"
          class="p-8 text-center text-sm text-muted-foreground"
        >
          No files. Click Upload below to add some.
        </p>
      </div>

      <!-- Pagination (fixed, below scroll area) -->
      <div
        v-if="total > 50"
        class="flex items-center justify-center gap-3 border-t py-2 text-sm"
      >
        <Button
          variant="outline"
          size="sm"
          :disabled="page <= 1"
          @click="page--"
        >
          Prev
        </Button>
        <span class="text-muted-foreground"
          >{{ page }} / {{ Math.ceil(total / 50) }}</span
        >
        <Button
          variant="outline"
          size="sm"
          :disabled="page >= Math.ceil(total / 50)"
          @click="page++"
        >
          Next
        </Button>
      </div>
    </div>

    <PermissionDialog
      v-if="permTarget"
      :target-type="permTarget.targetType"
      :target-id="permTarget.targetId"
      :name="permTarget.name"
      @close="permTarget = null"
    />
  </div>
</template>
