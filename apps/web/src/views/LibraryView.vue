<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
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
  if (!confirm(`删除分组「${g.name}」？（仅空分组可删）`)) return;
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
    !confirm(`删除「${a.path.split("/").pop()}」？此操作同时删除索引与文件。`)
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
    presentation: "演示",
    document: "文档",
    spreadsheet: "表格",
    image: "图片",
    video: "视频",
    audio: "音频",
    text: "文本",
    archive: "压缩包",
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
  { v: "presentation", label: "演示" },
  { v: "document", label: "文档" },
  { v: "spreadsheet", label: "表格" },
  { v: "image", label: "图片" },
  { v: "video", label: "视频" },
  { v: "audio", label: "音频" },
  { v: "text", label: "文本" },
  { v: "archive", label: "压缩包" },
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

onMounted(() => {
  void loadGroups();
  void loadAssets();
});
</script>

<template>
  <div class="flex h-full">
    <!-- Group tree -->
    <div class="w-56 shrink-0 overflow-y-auto border-r p-3">
      <button
        class="mb-0.5 w-full rounded px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent"
        :class="selectedGroup === null ? 'bg-accent font-medium' : ''"
        @click="selectedGroup = null"
      >
        全部文件
      </button>
      <button
        class="mb-0.5 w-full rounded px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent"
        :class="selectedGroup === 'ungrouped' ? 'bg-accent font-medium' : ''"
        @click="selectedGroup = 'ungrouped'"
      >
        未分组
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
              class="px-1 text-xs text-muted-foreground hover:text-foreground"
              title="重命名"
              @click.stop="startRename(g)"
            >
              ✎
            </button>
            <button
              class="px-1 text-xs text-muted-foreground hover:text-destructive"
              title="删除"
              @click.stop="removeGroup(g)"
            >
              ×
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
            ✓
          </Button>
        </div>
      </template>

      <div class="mt-3 flex gap-1 px-1">
        <Input
          v-model="newGroupName"
          class="h-8 text-xs"
          placeholder="新建分组…"
        />
        <Button
          size="sm"
          variant="outline"
          class="h-8 px-2 text-xs"
          @click="addGroup"
        >
          +
        </Button>
      </div>
    </div>

    <!-- File list -->
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div
        class="flex shrink-0 items-center gap-3 border-b bg-background px-4 py-2"
      >
        <Input v-model="search" class="max-w-xs" placeholder="按文件名过滤…" />
        <span class="ml-auto text-sm text-muted-foreground">
          {{ total }} 个文件
        </span>
      </div>

      <!-- Fixed header (outside the scroll area) with per-column menus -->
      <div
        class="relative grid shrink-0 grid-cols-[minmax(0,1fr)_64px_80px_96px_96px_72px_48px] gap-x-2 border-b bg-muted px-4 py-2 text-xs font-medium text-muted-foreground"
      >
        <div class="relative flex min-w-0 items-center">
          <button
            class="flex items-center gap-0.5 truncate hover:text-foreground"
            @click="openMenu = openMenu === 'name' ? null : 'name'"
          >
            文件名{{ sortIndicator("name") }}
            <svg
              v-if="kindFilter.length === 0 && statusFilter.length === 0"
              class="h-3 w-3 opacity-40"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path
                d="M4 6l4 4 4-4"
                stroke="currentColor"
                stroke-width="1.5"
                fill="none"
              />
            </svg>
          </button>
          <!-- Name column: sort only (no filter — use search box) -->
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
              按名称升序 ↑
            </button>
            <button
              class="w-full rounded px-2 py-1 text-left hover:bg-accent"
              @click="
                sortKey = 'name';
                sortDir = 'desc';
                openMenu = null;
              "
            >
              按名称降序 ↓
            </button>
          </div>
        </div>
        <div class="relative flex min-w-0 items-center justify-center">
          <button
            class="flex items-center gap-0.5 truncate hover:text-foreground"
            :class="kindFilter.length > 0 ? 'text-foreground' : ''"
            @click="openMenu = openMenu === 'kind' ? null : 'kind'"
          >
            类型{ kindFilter.length > 0 ? ` (${kindFilter.length})` : "" }
          </button>
          <!-- Column menus (absolute, below the header) -->
          <div
            v-if="openMenu === 'kind'"
            class="absolute left-0 top-full z-30 mt-1 w-40 rounded-md border bg-card p-1 text-xs shadow-lg"
          >
            <p
              class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              筛选类型
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
              清除筛选
            </button>
          </div>
        </div>
        <button
          class="flex items-center gap-0.5 truncate justify-center hover:text-foreground"
          @click="toggleSort('size')"
        >
          大小{{ sortIndicator("size") }}
        </button>
        <button
          class="flex items-center gap-0.5 truncate justify-center hover:text-foreground"
          @click="toggleSort('uploaded')"
        >
          添加时间{{ sortIndicator("uploaded") }}
        </button>
        <button
          class="flex items-center gap-0.5 truncate justify-center hover:text-foreground"
          @click="toggleSort('mtime')"
        >
          文件时间{{ sortIndicator("mtime") }}
        </button>
        <div class="relative flex min-w-0 items-center justify-center">
          <button
            class="flex items-center gap-0.5 truncate hover:text-foreground"
            :class="statusFilter.length > 0 ? 'text-foreground' : ''"
            @click="openMenu = openMenu === 'status' ? null : 'status'"
          >
            索引状态{ statusFilter.length > 0 ? ` (${statusFilter.length})` : ""
            }
          </button>
          <div
            v-if="openMenu === 'status'"
            class="absolute left-0 top-full z-30 mt-1 w-36 rounded-md border bg-card p-1 text-xs shadow-lg"
          >
            <p
              class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              筛选状态
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
              清除筛选
            </button>
          </div>
        </div>
      </div>

      <!-- Scrollable body only -->
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div v-if="assets.length > 0" class="divide-y">
          <div
            v-for="a in assets"
            :key="a.id"
            class="grid cursor-pointer grid-cols-[minmax(0,1fr)_64px_80px_96px_96px_72px_48px] items-center gap-x-2 px-4 py-2 text-sm transition-colors hover:bg-accent/30"
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
            <span class="text-center text-muted-foreground">{{
              fmtSize(a.sizeBytes)
            }}</span>
            <span class="text-center text-muted-foreground">{{
              fmtTime(a.uploadedAt)
            }}</span>
            <span class="text-center text-muted-foreground">{{
              fmtTime(a.mtimeMs)
            }}</span>
            <span class="text-center text-xs text-muted-foreground">{{
              a.extractionStatus
            }}</span>
            <span class="text-right">
              <button
                class="px-1 text-xs text-muted-foreground hover:text-destructive"
                title="删除"
                @click.stop="removeAsset(a)"
              >
                删除
              </button>
            </span>
          </div>
        </div>
        <p
          v-else-if="!busy"
          class="p-8 text-center text-sm text-muted-foreground"
        >
          没有文件。点左下「上传素材」添加。
        </p>
      </div>

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
          上一页
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
          下一页
        </Button>
      </div>
    </div>
  </div>
</template>
