<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import Button from "@/components/ui/Button.vue";
import Card from "@/components/ui/Card.vue";
import Input from "@/components/ui/Input.vue";
import { api } from "@/api/client";
import { fetchGroups, type GroupNode } from "@/api/library";
import type { SearchField } from "@/search/engine";
import { ChevronDown, Library, Search, X } from "lucide-vue-next";
import { useSearchIndexStore } from "@/stores/searchIndex";

/**
 * Home search. Centered hero layout; kind chips filter hits (client-side
 * post-filter on the engine result — the bundle already carries kind).
 * Clicking a hit navigates to the library detail view AT that page.
 */

const KIND_FILTERS = [
  { label: "All", value: "" },
  { label: "PDF", value: "pdf" },
  { label: "Slides", value: "presentation" },
  { label: "Docs", value: "document" },
  { label: "Sheets", value: "spreadsheet" },
  { label: "Images", value: "image" },
  { label: "Video", value: "video" },
  { label: "Audio", value: "audio" },
  { label: "Text", value: "text" },
] as const;

const router = useRouter();

const query = ref("");
const hits = ref<DisplayHit[]>([]);
const searched = ref(false);
const busy = ref(false);
const error = ref("");
const kindFilter = ref<string>("");
/** Query scope: body content only / content + filenames / filenames only. */
type Scope = "content" | "everywhere" | "filename";
const scope = ref<Scope>("everywhere");
const SCOPES: Array<{ value: Scope; label: string }> = [
  { value: "content", label: "Content" },
  { value: "everywhere", label: "Content + filenames" },
  { value: "filename", label: "Filenames" },
];
const scopeFields: Record<Scope, SearchField[] | undefined> = {
  content: ["text", "title"],
  everywhere: undefined,
  filename: ["fileName"],
};

const searchIndex = useSearchIndexStore();

// --- live search: results while typing (search-engine style) ---
const composing = ref(false); // IME (pinyin etc.) mid-composition
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const LIVE_DEBOUNCE_MS = 250;

function liveSearch(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Only live against the local index; the server fallback stays
    // submit-only (no request spam before the bundle is ready).
    if (!searchIndex.ready) return;
    if (query.value.trim()) void search();
    else hits.value = [];
  }, LIVE_DEBOUNCE_MS);
}

watch(query, () => {
  if (composing.value) return;
  liveSearch();
});

function onCompositionStart(): void {
  composing.value = true;
}

function onCompositionEnd(): void {
  composing.value = false;
  liveSearch();
}

function clearQuery(): void {
  query.value = "";
  hits.value = [];
  searched.value = false;
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
  groupId: string | null;
  parts: SnippetPart[];
}

interface SnippetPart {
  text: string;
  hit: boolean;
}

/** Synthesize a snippet around the first term occurrence. Prefers the
 *  body text; falls back to the title / file name so a hit that matched
 *  there still highlights where it actually matched. */
function buildSnippet(
  text: string,
  terms: string[],
  title?: string | null,
  fileName?: string,
): SnippetPart[] {
  const sources = [
    { body: text, label: "" },
    { body: title ?? "", label: "title · " },
    { body: fileName ?? "", label: "file · " },
  ];
  for (const src of sources) {
    if (!src.body) continue;
    const norm = src.body.toLowerCase();
    let idx = -1;
    let len = 0;
    for (const t of terms) {
      const i = norm.indexOf(t.toLowerCase());
      if (i >= 0 && (idx < 0 || i < idx)) {
        idx = i;
        len = t.length;
      }
    }
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(src.body.length, idx + len + 80);
      const parts: SnippetPart[] = [];
      if (src.label) parts.push({ text: src.label, hit: false });
      if (start > 0) parts.push({ text: "…", hit: false });
      parts.push({ text: src.body.slice(start, idx), hit: false });
      parts.push({ text: src.body.slice(idx, idx + len), hit: true });
      parts.push({ text: src.body.slice(idx + len, end), hit: false });
      if (end < src.body.length) parts.push({ text: "…", hit: false });
      return parts;
    }
  }
  if (!text) return [];
  return [{ text: text.slice(0, 120), hit: false }];
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
  groupId?: string | null;
}

function doLocalSearch(q: string): DisplayHit[] {
  const results = searchIndex.engine.search(q, 50, {
    fields: scopeFields[scope.value],
  });
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
      groupId: u.groupId ?? null,
      parts: buildSnippet(u.text ?? "", hit.terms, u.title, u.fileName),
    };
  });
}

function doServerSearchSync(hits: ServerHit[]): DisplayHit[] {
  return hits.map((h) => ({
    ...h,
    groupId: h.groupId ?? null,
    parts: parseSnippet(h.snippet),
  }));
}

async function search() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
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

// --- group filter (multi-select over the knowledge-base tree) ---

const UNGROUPED = "__ungrouped__";
const groups = ref<GroupNode[]>([]);
const ungroupedCount = ref(0);
const groupPanelOpen = ref(false);
const selectedGroups = ref(new Set<string>());

async function loadGroups(): Promise<void> {
  try {
    const tree = await fetchGroups();
    groups.value = tree.groups;
    ungroupedCount.value = tree.ungrouped;
  } catch {
    groups.value = [];
  }
}
void loadGroups();

function flattenGroups(
  nodes: GroupNode[],
  depth = 0,
): Array<GroupNode & { depth: number }> {
  return nodes.flatMap((n) => [
    { ...n, depth },
    ...flattenGroups(n.children ?? [], depth + 1),
  ]);
}

function toggleGroup(id: string): void {
  const next = new Set(selectedGroups.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedGroups.value = next;
}

function clearGroups(): void {
  selectedGroups.value = new Set();
}

const groupFilterActive = computed(() => selectedGroups.value.size > 0);

const filteredHits = computed(() => {
  let out = hits.value;
  if (kindFilter.value) out = out.filter((h) => h.kind === kindFilter.value);
  if (groupFilterActive.value) {
    const sel = selectedGroups.value;
    out = out.filter((h) =>
      h.groupId ? sel.has(h.groupId) : sel.has(UNGROUPED),
    );
  }
  return out;
});

/** Per-kind hit counts for the chips (computed pre-filter). */
const kindCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const h of hits.value) counts.set(h.kind, (counts.get(h.kind) ?? 0) + 1);
  return counts;
});

/** Navigate to the library detail view at the hit's page. */
function openHit(hit: DisplayHit): void {
  void router.push({
    name: "asset-detail",
    params: { id: hit.assetId },
    query:
      hit.unitType === "page" ||
      hit.unitType === "slide" ||
      hit.unitType === "sheet"
        ? { page: String(hit.ordinal) }
        : {},
  });
}

// Scope is part of the query — switching it re-runs the search.
watch(scope, () => {
  if (query.value.trim()) void search();
});

onMounted(() => {
  void searchIndex.init();
});
</script>

<template>
  <div class="mx-auto flex min-h-[70vh] max-w-2xl flex-col px-4">
    <!-- Hero: quiet title, protagonist input -->
    <div class="mb-5 mt-[9vh] text-center">
      <p
        class="mb-4 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground"
      >
        Knowledge Base
      </p>
      <form
        class="mx-auto flex max-w-xl items-center gap-2 rounded-xl border bg-background p-1.5 pl-4 shadow-sm transition-shadow focus-within:shadow-md focus-within:ring-1 focus-within:ring-ring"
        @submit.prevent="search"
      >
        <Search
          class="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          v-model="query"
          placeholder="Search pages, slides, transcripts…"
          class="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
          autocomplete="off"
          spellcheck="false"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
        />
        <button
          v-if="query"
          class="shrink-0 rounded-full p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Clear search"
          type="button"
          @click="clearQuery"
        >
          <X class="h-3.5 w-3.5" />
        </button>
        <Button type="submit" size="sm" :disabled="busy">Search</Button>
      </form>
    </div>
    <!-- Filters: available BEFORE searching (scope + type + groups) -->
    <div class="mb-6 flex flex-col items-center gap-3">
      <!-- Scope: content / content+filenames / filenames -->
      <div
        class="inline-flex overflow-hidden rounded-full border bg-background text-xs"
        role="group"
        aria-label="Search scope"
      >
        <button
          v-for="sc in SCOPES"
          :key="sc.value"
          class="px-3 py-1.5 transition-colors first:rounded-l-full last:rounded-r-full"
          :class="
            scope === sc.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent'
          "
          :aria-pressed="scope === sc.value"
          @click="scope = sc.value"
        >
          {{ sc.label }}
        </button>
      </div>

      <!-- Kind chips (counts appear after a search) -->
      <div class="flex flex-wrap justify-center gap-1.5">
        <button
          v-for="f in KIND_FILTERS"
          :key="f.value"
          class="rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors"
          :class="
            kindFilter === f.value
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-transparent bg-muted/60 text-muted-foreground hover:bg-muted'
          "
          :disabled="f.value !== '' && searched && !kindCounts.has(f.value)"
          @click="kindFilter = f.value"
        >
          {{ f.label }}
          <span
            v-if="f.value !== '' && kindCounts.has(f.value)"
            class="ml-1 opacity-70"
          >
            {{ kindCounts.get(f.value) }}
          </span>
        </button>
      </div>

      <!-- Groups entry -->
      <div class="w-full">
        <button
          class="mx-auto flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
          @click="groupPanelOpen = !groupPanelOpen"
        >
          <Library class="h-3.5 w-3.5" />
          Groups
          <span
            v-if="groupFilterActive"
            class="rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground"
          >
            {{ selectedGroups.size }}
          </span>
          <ChevronDown
            class="h-3.5 w-3.5 transition-transform"
            :class="groupPanelOpen ? '' : '-rotate-90'"
          />
        </button>
        <div
          v-if="groupPanelOpen"
          class="mt-2 rounded-lg border bg-muted/20 p-3"
        >
          <div
            class="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2"
          >
            <label
              v-for="g in flattenGroups(groups)"
              :key="g.id"
              class="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/50"
              :style="{ paddingLeft: `${g.depth * 14 + 6}px` }"
            >
              <input
                type="checkbox"
                :checked="selectedGroups.has(g.id)"
                @change="toggleGroup(g.id)"
              />
              <span class="truncate">{{ g.name }}</span>
              <span class="ml-auto text-[11px] text-muted-foreground">{{
                g.fileCount
              }}</span>
            </label>
            <label
              class="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent/50"
            >
              <input
                type="checkbox"
                :checked="selectedGroups.has(UNGROUPED)"
                @change="toggleGroup(UNGROUPED)"
              />
              <span class="italic">Ungrouped</span>
              <span class="ml-auto text-[11px]">{{ ungroupedCount }}</span>
            </label>
          </div>
          <div class="mt-2 flex justify-end">
            <button
              class="text-[11px] text-muted-foreground hover:underline"
              :disabled="!groupFilterActive"
              @click="clearGroups"
            >
              clear
            </button>
          </div>
        </div>
      </div>
    </div>

    <p v-if="error" class="text-center text-sm text-destructive">
      {{ error }}
    </p>
    <p
      v-else-if="searched && hits.length === 0"
      class="text-center text-sm text-muted-foreground"
    >
      No results. Try different keywords or upload to the library.
    </p>
    <p
      v-else-if="searched && filteredHits.length === 0"
      class="text-center text-sm text-muted-foreground"
    >
      No matching results — adjust the kind or group filters.
    </p>

    <!-- Results -->
    <div
      v-if="searched && filteredHits.length > 0"
      class="mb-3 mt-2 flex items-baseline justify-between border-t pt-3"
    >
      <span class="text-xs font-medium tracking-wide text-muted-foreground">
        {{ filteredHits.length }}
        {{ filteredHits.length === 1 ? "result" : "results" }}
      </span>
      <span
        v-if="kindFilter || groupFilterActive || scope !== 'everywhere'"
        class="text-[11px] text-muted-foreground/70"
      >
        {{ SCOPES.find((sc) => sc.value === scope)?.label
        }}{{
          kindFilter
            ? " · " + KIND_FILTERS.find((f) => f.value === kindFilter)?.label
            : ""
        }}{{ groupFilterActive ? " · " + selectedGroups.size + " groups" : "" }}
      </span>
    </div>

    <div class="space-y-1.5">
      <Card
        v-for="hit in filteredHits"
        :key="hit.unitId"
        class="cursor-pointer p-3.5 transition-all duration-150 hover:-translate-y-px hover:bg-accent/40 hover:shadow-sm"
        @click="openHit(hit)"
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
  </div>
</template>
