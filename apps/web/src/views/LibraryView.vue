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
const sort = ref<"uploaded" | "mtime">("uploaded");
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
      sort: sort.value,
      page: page.value,
      pageSize: 50,
    });
    assets.value = res.assets;
    total.value = res.total;
  } finally {
    busy.value = false;
  }
}

watch(selectedGroup, () => {
  page.value = 1;
  void loadAssets();
});
watch(page, () => void loadAssets());
watch(sort, () => void loadAssets());

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
    <div class="min-w-0 flex-1 overflow-hidden">
      <div class="flex items-center gap-3 border-b px-4 py-2">
        <Input v-model="search" class="max-w-xs" placeholder="按文件名过滤…" />
        <select
          v-model="sort"
          class="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="uploaded">按添加时间</option>
          <option value="mtime">按文件时间</option>
        </select>
        <span class="ml-auto text-sm text-muted-foreground">
          {{ total }} 个文件
        </span>
      </div>

      <div class="overflow-y-auto" style="max-height: calc(100vh - 105px)">
        <table class="w-full text-sm" v-if="assets.length > 0">
          <thead
            class="sticky top-0 border-b bg-muted/50 text-left text-xs text-muted-foreground"
          >
            <tr>
              <th class="px-4 py-2 font-medium">文件名</th>
              <th class="px-2 py-2 font-medium">类型</th>
              <th class="px-2 py-2 font-medium">大小</th>
              <th class="px-2 py-2 font-medium">添加时间</th>
              <th class="px-2 py-2 font-medium">文件时间</th>
              <th class="px-2 py-2 font-medium">状态</th>
              <th class="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="a in assets"
              :key="a.id"
              class="cursor-pointer border-b transition-colors hover:bg-accent/30"
              @click="openDetail(a)"
            >
              <td class="max-w-xs truncate px-4 py-2 font-medium">
                {{ a.path.split("/").pop() }}
              </td>
              <td class="px-2 py-2">
                <span class="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {{ kindLabel(a.kind) }}
                </span>
              </td>
              <td class="px-2 py-2 text-muted-foreground">
                {{ fmtSize(a.sizeBytes) }}
              </td>
              <td class="px-2 py-2 text-muted-foreground">
                {{ fmtTime(a.uploadedAt) }}
              </td>
              <td class="px-2 py-2 text-muted-foreground">
                {{ fmtTime(a.mtimeMs) }}
              </td>
              <td class="px-2 py-2 text-xs text-muted-foreground">
                {{ a.extractionStatus }}
              </td>
              <td class="px-2 py-2 text-right">
                <button
                  class="px-1 text-xs text-muted-foreground hover:text-destructive"
                  title="删除"
                  @click.stop="removeAsset(a)"
                >
                  删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
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
