<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import Button from "@/components/ui/Button.vue";
import Card from "@/components/ui/Card.vue";
import Input from "@/components/ui/Input.vue";
import { api, logout, uploadFiles } from "@/api/client";
import { useAuthStore } from "@/stores/auth";
import { useSearchIndexStore } from "@/stores/searchIndex";
import type { SearchHit } from "@/search/engine";
import PdfPreview from "@/components/PdfPreview.vue";

const preview = ref<{ assetId: string; fileName: string; page: number } | null>(
  null,
);

function openPreview(hit: DisplayHit): void {
  // PDF → in-browser viewer; Office/other → open the file inline (browser
  // handles download; office thumbs land in the UI with the thumbs route).
  preview.value = {
    assetId: hit.assetId,
    fileName: hit.fileName,
    page: hit.ordinal,
  };
}

/** Synthesize a snippet around the first term occurrence in the text. */
function buildSnippet(text: string, terms: string[]): SnippetPart[] {
  if (!text) return [];
  const norm = text.toLowerCase();
  let idx = -1;
  let len = 0;
  for (const t of terms) {
    const i = norm.indexOf(t.toLowerCase());
    if (i >= 0 && (idx < 0 || i < idx)) {
      idx = i;
      len = t.length;
    }
  }
  if (idx < 0) {
    return [{ text: text.slice(0, 120), hit: false }];
  }
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len + 80);
  const parts: SnippetPart[] = [];
  if (start > 0) parts.push({ text: "…", hit: false });
  parts.push({ text: text.slice(start, idx), hit: false });
  parts.push({ text: text.slice(idx, idx + len), hit: true });
  parts.push({ text: text.slice(idx + len, end), hit: false });
  if (end < text.length) parts.push({ text: "…", hit: false });
  return parts;
}

/** Render shape: engine hit + synthesized snippet parts. */
interface DisplayHit {
  unitId: string;
  assetId: string;
  ordinal: number;
  unitType: string;
  title: string | null;
  fileName: string;
  assetPath: string;
  kind: string;
  parts: SnippetPart[];
}

interface SourceRow {
  id: string;
  rootPath: string;
  assetCount: number;
  doneCount: number;
}

interface SnippetPart {
  text: string;
  hit: boolean;
}

/** Split "[foo] bar [baz]" snippets into highlightable parts. */
function parseSnippet(snippet: string | null): SnippetPart[] {
  if (!snippet) return [];
  const parts: SnippetPart[] = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet))) {
    if (m.index > last)
      parts.push({ text: snippet.slice(last, m.index), hit: false });
    parts.push({ text: m[1], hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length)
    parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}

const router = useRouter();
const auth = useAuthStore();

const query = ref("");
const hits = ref<DisplayHit[]>([]);
const searched = ref(false);
const busy = ref(false);
const error = ref("");
const sources = ref<SourceRow[]>([]);
const newSourcePath = ref("");
const sourceMsg = ref("");

const searchIndex = useSearchIndexStore();

interface ServerHit {
  unitId: string;
  assetId: string;
  ordinal: number;
  unitType: string;
  title: string | null;
  snippet: string | null;
  fileName: string;
  assetPath: string;
  kind: string;
}

function doLocalSearch(q: string): DisplayHit[] {
  const results = searchIndex.engine.search(q);
  return results.map((hit) => {
    const u = hit.unit;
    return {
      unitId: u.id,
      assetId: u.assetId,
      ordinal: u.ordinal,
      unitType: u.unitType,
      title: u.title,
      fileName: u.fileName,
      assetPath: u.sourcePath,
      kind: u.kind,
      parts: buildSnippet(u.text ?? "", hit.terms),
    };
  });
}

function doServerSearchSync(hits: ServerHit[]): DisplayHit[] {
  return hits.map((h) => ({
    ...h,
    parts: parseSnippet(h.snippet),
  }));
}

async function search() {
  const q = query.value.trim();
  if (!q) {
    hits.value = [];
    return;
  }
  error.value = "";
  if (searchIndex.ready) {
    hits.value = doLocalSearch(q);
    searched.value = true;
    return;
  }
  // Bundle not loaded yet: server-side fallback this once.
  busy.value = true;
  try {
    const res = await api<{ hits: ServerHit[] }>(
      `/api/search?q=${encodeURIComponent(q)}`,
    );
    hits.value = doServerSearchSync(res.hits);
  } catch (err) {
    error.value = String(err);
  } finally {
    searched.value = true;
    busy.value = false;
  }
}

async function loadSources() {
  try {
    const res = await api<{ sources: SourceRow[] }>("/api/sources");
    sources.value = res.sources;
  } catch {
    sources.value = [];
  }
}

async function addSource() {
  const p = newSourcePath.value.trim();
  if (!p) return;
  sourceMsg.value = "";
  try {
    await api("/api/sources", {
      method: "POST",
      body: JSON.stringify({ rootPath: p }),
    });
    newSourcePath.value = "";
    sourceMsg.value = "已添加，扫描已在后台启动";
    await loadSources();
  } catch (err) {
    sourceMsg.value = String(err);
  }
}

async function doLogout() {
  await logout();
  auth.setUser(null);
  router.push({ name: "login" });
}

const uploading = ref(false);
const uploadMsg = ref("");

/** Poll until the extraction queue drains, then confirm + auto-clear. */
async function watchIndexing() {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await api<{ jobs: Array<{ status: string }> }>("/api/jobs");
      const busy = res.jobs.filter(
        (j) => j.status === "pending" || j.status === "running",
      ).length;
      if (busy === 0) {
        uploadMsg.value = "索引完成，可以搜索了";
        await new Promise((r) => setTimeout(r, 4000));
        uploadMsg.value = "";
        return;
      }
      uploadMsg.value = `正在索引…（剩余 ${busy} 个任务）`;
    } catch {
      return;
    }
  }
  uploadMsg.value = "";
}

async function onUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length === 0) return;
  uploading.value = true;
  uploadMsg.value = "";
  try {
    const outcomes = await uploadFiles(files);
    const total = outcomes.reduce((n, o) => n + o.unpackedFiles, 0);
    uploadMsg.value =
      total > 0
        ? `已上传 ${outcomes.length} 个文件，解包 ${total} 个条目，正在索引…`
        : `已上传 ${outcomes.length} 个文件，正在索引…`;
    void watchIndexing();
  } catch (err) {
    uploadMsg.value = String(err);
  } finally {
    uploading.value = false;
  }
}

onMounted(() => {
  void loadSources();
  void searchIndex.init();
});
</script>

<template>
  <main class="mx-auto min-h-screen max-w-3xl p-4 sm:p-6">
    <header class="mb-4 flex items-center justify-between gap-2">
      <h1 class="text-lg font-semibold tracking-tight">Mentro</h1>
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <span v-if="auth.user">{{ auth.user.username }}</span>
        <Button variant="ghost" size="sm" @click="doLogout">退出</Button>
      </div>
    </header>

    <form class="mb-4 flex gap-2" @submit.prevent="search">
      <Input v-model="query" placeholder="搜索全部内容单元（页/幻灯片）…" />
      <Button type="submit" :disabled="busy">搜索</Button>
      <label
        class="inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-input bg-background px-4 text-sm font-medium shadow-sm hover:bg-accent"
      >
        {{ uploading ? "上传中…" : "上传" }}
        <input
          type="file"
          multiple
          class="hidden"
          :disabled="uploading"
          @change="onUpload"
        />
      </label>
    </form>
    <p v-if="uploadMsg" class="mb-3 text-xs text-muted-foreground">
      {{ uploadMsg }}
    </p>

    <details class="mb-4 text-sm">
      <summary class="cursor-pointer text-muted-foreground">
        素材源（{{ sources.length }}）
      </summary>
      <div class="mt-2 flex gap-2">
        <Input v-model="newSourcePath" placeholder="添加目录绝对路径…" />
        <Button variant="outline" size="sm" @click="addSource">添加</Button>
      </div>
      <p v-if="sourceMsg" class="mt-1 text-xs text-muted-foreground">
        {{ sourceMsg }}
      </p>
      <ul class="mt-2 space-y-1">
        <li
          v-for="s in sources"
          :key="s.id"
          class="flex items-center justify-between gap-2 rounded border px-2 py-1"
        >
          <span class="truncate font-mono text-xs">{{ s.rootPath }}</span>
          <span class="shrink-0 text-xs text-muted-foreground">
            {{ s.doneCount }}/{{ s.assetCount }}
          </span>
        </li>
      </ul>
    </details>

    <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
    <p
      v-else-if="searched && hits.length === 0"
      class="text-sm text-muted-foreground"
    >
      没有命中。换个关键词，或先在上方添加素材源。
    </p>

    <div class="space-y-2">
      <Card
        v-for="hit in hits"
        :key="hit.unitId"
        class="cursor-pointer p-3 hover:bg-accent/40"
        @click="openPreview(hit)"
        :data-unit="hit.unitId"
      >
        <div class="mb-1 flex items-baseline justify-between gap-2">
          <span class="truncate text-sm font-medium">{{ hit.fileName }}</span>
          <span
            class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            {{ hit.unitType }} {{ hit.ordinal }}
          </span>
        </div>
        <p v-if="hit.title" class="truncate text-xs text-muted-foreground">
          {{ hit.title }}
        </p>
        <p class="mt-1 line-clamp-3 text-sm">
          <template v-for="(part, i) in hit.parts" :key="i">
            <mark
              v-if="part.hit"
              class="rounded bg-yellow-200/70 px-0.5 dark:bg-yellow-600/40"
              >{{ part.text }}</mark
            >
            <template v-else>{{ part.text }}</template>
          </template>
        </p>
        <p class="mt-1 truncate font-mono text-[11px] text-muted-foreground">
          {{ hit.assetPath }}
        </p>
      </Card>
    </div>

    <PdfPreview
      v-if="preview"
      :asset-id="preview.assetId"
      :file-name="preview.fileName"
      :initial-page="preview.page"
      @close="preview = null"
    />
  </main>
</template>
