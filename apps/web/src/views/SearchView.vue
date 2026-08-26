<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import Button from "@/components/ui/Button.vue";
import Card from "@/components/ui/Card.vue";
import Input from "@/components/ui/Input.vue";
import { api } from "@/api/client";
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

const uploadMsg = ref("");

const libraryCount = ref<number | null>(null);

onMounted(() => {
  void searchIndex.init();
  void api<{ total: number }>("/api/library?pageSize=1")
    .then((r) => (libraryCount.value = r.total))
    .catch(() => (libraryCount.value = null));
});
</script>

<template>
  <div class="mx-auto max-w-3xl p-4 sm:p-6">
    <div class="mb-4 flex items-center gap-3">
      <form class="flex flex-1 gap-2" @submit.prevent="search">
        <Input v-model="query" placeholder="搜索全部内容单元（页/幻灯片）…" />
        <Button type="submit" :disabled="busy">搜索</Button>
      </form>
    </div>

    <p v-if="uploadMsg" class="mb-3 text-xs text-muted-foreground">
      {{ uploadMsg }}
    </p>

    <!-- Library counter entry -->
    <button
      class="mb-4 flex w-full items-center justify-between rounded-lg border px-4 py-2 text-sm transition-colors hover:bg-accent/40"
      @click="router.push({ name: 'library' })"
    >
      <span class="text-muted-foreground">素材库</span>
      <span class="font-medium">{{ libraryCount ?? "…" }} 个文件 →</span>
    </button>

    <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
    <p
      v-else-if="searched && hits.length === 0"
      class="text-sm text-muted-foreground"
    >
      没有命中。换个关键词，或去素材库上传。
    </p>

    <div class="space-y-2">
      <Card
        v-for="hit in hits"
        :key="hit.unitId"
        class="cursor-pointer p-3 hover:bg-accent/40"
        @click="openPreview(hit)"
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
  </div>
</template>
