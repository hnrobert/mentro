<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import Button from "@/components/ui/Button.vue";
import Card from "@/components/ui/Card.vue";
import { assistantStream, api, type AssistantSource } from "@/api/client";
import { fetchGroups, type GroupNode } from "@/api/library";
import {
  BookOpen,
  ChevronDown,
  FileText,
  Library,
  Search,
  Sparkles,
  Square,
  X,
} from "lucide-vue-next";

/**
 * Server-side search, search-engine style: typing fetches SUGGESTIONS
 * (completion phrases + quick-jump page hits); Enter runs the full
 * hybrid search. The browser-local index is gone — every query hits the
 * server (FTS5 + embeddings, scope- and group-filtered there).
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

type Scope = "content" | "everywhere" | "filename";
const SCOPES: Array<{ value: Scope; label: string }> = [
  { value: "content", label: "Content" },
  { value: "everywhere", label: "Content + filenames" },
  { value: "filename", label: "Filenames" },
];

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

interface SuggestHit {
  unitId: string;
  assetId: string;
  ordinal: number;
  unitType: string;
  title: string | null;
  fileName: string;
  kind: string;
}

interface DisplayHit extends ServerHit {
  parts: SnippetPart[];
}

interface SnippetPart {
  text: string;
  hit: boolean;
}

const router = useRouter();
const query = ref("");
const hits = ref<DisplayHit[]>([]);
const searched = ref(false);
const busy = ref(false);
const error = ref("");
const kindFilter = ref<string>("");
const scope = ref<Scope>("everywhere");

// --- suggestions (as-you-type) ---

const terms = ref<string[]>([]);
const suggestHits = ref<SuggestHit[]>([]);
const suggestOpen = ref(false);
/** Highlighted row in the combined list: -1 = raw query, 0.. = items. */
const suggestIndex = ref(-1);
const composing = ref(false);
let suggestTimer: ReturnType<typeof setTimeout> | null = null;

type SuggestItem =
  { kind: "term"; value: string } | { kind: "hit"; value: SuggestHit };

const suggestItems = computed<SuggestItem[]>(() => [
  ...terms.value.map((t): SuggestItem => ({ kind: "term", value: t })),
  ...suggestHits.value.map((h): SuggestItem => ({ kind: "hit", value: h })),
]);
const suggestCount = computed(() => suggestItems.value.length);

function requestSuggestions(): void {
  if (suggestTimer) clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => void fetchSuggestions(), 200);
}

async function fetchSuggestions(): Promise<void> {
  const q = query.value.trim();
  if (!q) {
    terms.value = [];
    suggestHits.value = [];
    suggestOpen.value = false;
    return;
  }
  try {
    const res = await api<{ terms: string[]; hits: SuggestHit[] }>(
      `/api/search/suggest?q=${encodeURIComponent(q)}`,
    );
    // Stale-response guard: a newer keystroke may have arrived.
    if (q !== query.value.trim()) return;
    terms.value = res.terms;
    suggestHits.value = res.hits;
    suggestIndex.value = -1;
    suggestOpen.value = res.terms.length > 0 || res.hits.length > 0;
  } catch {
    /* suggestions are best-effort */
  }
}

watch(query, () => {
  if (composing.value) return;
  requestSuggestions();
});

function onCompositionStart(): void {
  composing.value = true;
}
function onCompositionEnd(): void {
  composing.value = false;
  requestSuggestions();
}

function closeSuggest(): void {
  suggestOpen.value = false;
}

function chooseSuggestion(item: (typeof suggestItems.value)[number]): void {
  closeSuggest();
  if (item.kind === "term") {
    query.value = item.value;
    void submitSearch();
  } else {
    openHit(item.value);
  }
}

function suggestKeydown(e: KeyboardEvent): void {
  if (!suggestOpen.value || suggestCount.value === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    suggestIndex.value = (suggestIndex.value + 1) % suggestCount.value;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    suggestIndex.value =
      suggestIndex.value <= 0 ? suggestCount.value - 1 : suggestIndex.value - 1;
  } else if (e.key === "Escape") {
    closeSuggest();
  } else if (e.key === "Enter" && suggestIndex.value >= 0) {
    e.preventDefault();
    chooseSuggestion(suggestItems.value[suggestIndex.value]!);
  }
}

// --- group filter (multi-select, applied server-side) ---

const UNGROUPED = "__ungrouped__";
const groups = ref<GroupNode[]>([]);
const ungroupedCount = ref(0);
const groupPanelOpen = ref(false);
const selectedGroups = ref(new Set<string>());

// --- full search (Enter) ---

function groupParams(): string {
  if (!groupFilterActive.value) return "";
  return `&groups=${encodeURIComponent([...selectedGroups.value].join(","))}`;
}

/** Snapshot of what produced the displayed hits — summarize must
 *  describe THESE, not whatever the text box holds afterwards. */
const executedQuery = ref("");
const executedScope = ref<Scope>("everywhere");
const executedGroups = ref("");

async function submitSearch(): Promise<void> {
  const q = query.value.trim();
  if (!q) {
    hits.value = [];
    searched.value = false;
    return;
  }
  closeSuggest();
  error.value = "";
  busy.value = true;
  try {
    const res = await api<{ hits: ServerHit[] }>(
      `/api/search?q=${encodeURIComponent(q)}&limit=50&scope=${scope.value}${groupParams()}`,
    );
    hits.value = res.hits.map((h) => ({
      ...h,
      parts: parseSnippet(h.snippet),
    }));
    executedQuery.value = q;
    executedScope.value = scope.value;
    executedGroups.value = groupFilterActive.value
      ? [...selectedGroups.value].join(",")
      : "";
  } catch (err) {
    error.value = String(err);
  } finally {
    searched.value = true;
    busy.value = false;
  }
}

/** Re-run when scope/groups change (they are part of the query now). */
watch([scope, selectedGroups], () => {
  if (query.value.trim()) void submitSearch();
});

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

const filteredHits = computed(() =>
  kindFilter.value
    ? hits.value.filter((h) => h.kind === kindFilter.value)
    : hits.value,
);

const kindCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const h of hits.value) counts.set(h.kind, (counts.get(h.kind) ?? 0) + 1);
  return counts;
});

/** Navigate to the library detail view at the hit's page. */
function openHit(hit: SuggestHit | ServerHit): void {
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

function clearQuery(): void {
  query.value = "";
  hits.value = [];
  searched.value = false;
  terms.value = [];
  suggestHits.value = [];
  suggestOpen.value = false;
}

// --- group filter (multi-select, applied server-side) ---

async function loadGroups(): Promise<void> {
  try {
    const tree = await fetchGroups();
    groups.value = tree.groups;
    ungroupedCount.value = tree.ungrouped;
  } catch {
    groups.value = [];
  }
}

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

onMounted(() => {
  void loadGroups();
});

// --- AI assistant card (inline, streaming) ---------------------------------

type AiMode = "summarize" | "ask" | "plan" | "deepread";
const AI_MODES: Array<{ value: AiMode; label: string }> = [
  { value: "summarize", label: "总结" },
  { value: "ask", label: "问答" },
  { value: "plan", label: "计划" },
  { value: "deepread", label: "深读" },
];

const aiOn = ref(localStorage.getItem("mentro:ai-on") === "1");
const aiMode = ref<AiMode>("summarize");
const aiText = ref("");
const aiSources = ref<AssistantSource[]>([]);
const aiBusy = ref(false);
const aiError = ref("");
const askInput = ref("");
const topicInput = ref("");
/** deepread target, set by the 📖 button on a result row. */
const aiTarget = ref<{ unitId: string; label: string } | null>(null);
let aiAbort: AbortController | null = null;

function toggleAi(): void {
  aiOn.value = !aiOn.value;
  localStorage.setItem("mentro:ai-on", aiOn.value ? "1" : "0");
}

function stopAi(): void {
  aiAbort?.abort();
}

function switchAiMode(m: AiMode): void {
  aiMode.value = m;
  aiAbort?.abort(); // any in-flight generation belongs to the old mode
  aiText.value = "";
  aiSources.value = [];
  aiError.value = "";
}

async function runAi(task: AiMode): Promise<void> {
  const body: Record<string, unknown> = { task };
  if (task === "summarize") {
    // Summarize what is DISPLAYED: the query that produced the hits,
    // not whatever is in the text box right now.
    if (!executedQuery.value || hits.value.length === 0) return;
    body.q = executedQuery.value;
    body.scope = executedScope.value;
    if (executedGroups.value) body.groups = executedGroups.value;
  } else if (task === "ask") {
    if (!askInput.value.trim()) return;
    body.question = askInput.value.trim();
  } else if (task === "plan") {
    if (!topicInput.value.trim()) return;
    body.topic = topicInput.value.trim();
  } else {
    if (!aiTarget.value) return;
    body.unitId = aiTarget.value.unitId;
  }
  // Re-entrancy: kill any in-flight stream before starting the new one.
  aiAbort?.abort();
  aiText.value = "";
  aiSources.value = [];
  aiError.value = "";
  aiBusy.value = true;
  const myAbort = new AbortController();
  aiAbort = myAbort;
  try {
    await assistantStream(
      body,
      {
        onDelta: (t) => {
          aiText.value += t;
        },
        onSources: (s) => {
          aiSources.value = s;
        },
      },
      myAbort.signal,
    );
  } catch (err) {
    // A superseded/aborted run must not clobber the newer one's state.
    if (!myAbort.signal.aborted) {
      aiError.value = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (aiAbort === myAbort) aiBusy.value = false;
  }
}

onUnmounted(() => {
  aiAbort?.abort();
});

/** Result-row 📖: deep-read this page (auto-runs — the click is intent). */
function startDeepread(hit: ServerHit): void {
  aiOn.value = true;
  localStorage.setItem("mentro:ai-on", "1");
  aiMode.value = "deepread";
  aiTarget.value = {
    unitId: hit.unitId,
    label: `${hit.fileName} · ${hit.unitType} ${hit.ordinal}`,
  };
  void runAi("deepread");
}

/** Streamed text -> lines; `QUERY: x` lines become search buttons.
 *  Tolerant of model drift: optional list marker, full-width colon,
 *  any case (the prompt asks for `QUERY: 词` but nothing enforces it). */
const aiLines = computed(() =>
  aiText.value.split("\n").map((line) => {
    const m = line.match(/^\s*(?:[-*·•]\s*)?QUERY\s*[:：]\s*(.+?)\s*$/i);
    return m
      ? { kind: "query" as const, q: m[1] }
      : { kind: "text" as const, line };
  }),
);

/** Split a text line into plain/citation【i】parts for click-to-jump. */
function citeParts(line: string): Array<{ text: string; cite?: number }> {
  const parts: Array<{ text: string; cite?: number }> = [];
  const re = /【(\d+)】/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) parts.push({ text: line.slice(last, m.index) });
    parts.push({ text: m[0], cite: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last) });
  return parts;
}

function openSourceByIndex(i: number): void {
  const s = aiSources.value.find((x) => x.i === i);
  if (!s) return;
  void router.push({
    name: "asset-detail",
    params: { id: s.assetId },
    query:
      s.unitType === "page" || s.unitType === "slide" || s.unitType === "sheet"
        ? { page: String(s.ordinal) }
        : {},
  });
}

/** Plan suggestion clicked: run it as a real search. */
function runSuggestedQuery(q: string): void {
  query.value = q;
  void submitSearch();
}
</script>

<template>
  <div class="mx-auto flex min-h-[70vh] max-w-2xl flex-col px-4">
    <!-- Hero: quiet title, protagonist input with suggestion dropdown -->
    <div class="mb-5 mt-[9vh] text-center">
      <p
        class="mb-4 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground"
      >
        Knowledge Base
      </p>
      <div class="relative mx-auto max-w-xl">
        <form
          class="flex items-center gap-2 rounded-xl border bg-background p-1.5 pl-4 shadow-sm transition-shadow focus-within:shadow-md focus-within:ring-1 focus-within:ring-ring"
          @submit.prevent="submitSearch"
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
            @keydown="suggestKeydown"
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

        <!-- Suggestion dropdown (terms + quick-jump hits) -->
        <div
          v-if="suggestOpen && suggestCount > 0"
          class="absolute inset-x-0 top-full z-40 mt-2 overflow-hidden rounded-xl border bg-background py-1 text-left shadow-lg"
          @mousedown.prevent
        >
          <button
            v-for="(item, i) in suggestItems"
            :key="
              item.kind === 'hit'
                ? 'hit-' + item.value.unitId
                : 'term-' + item.value
            "
            class="flex w-full items-center gap-2.5 px-4 py-2 text-sm transition-colors"
            :class="i === suggestIndex ? 'bg-accent' : 'hover:bg-accent/60'"
            @click="chooseSuggestion(item)"
            @mouseenter="suggestIndex = i"
          >
            <Search
              v-if="item.kind === 'term'"
              class="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
            <FileText
              v-else
              class="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
            <span v-if="item.kind === 'term'" class="min-w-0 truncate">
              <span class="font-medium">{{ query }}</span>
              <span class="text-muted-foreground">{{
                item.value.slice(query.length)
              }}</span>
            </span>
            <span v-else class="min-w-0 flex-1 truncate">
              <span class="font-medium">{{ item.value.fileName }}</span>
              <span class="ml-1.5 text-xs text-muted-foreground">
                {{ item.value.unitType }} {{ item.value.ordinal }}
              </span>
            </span>
            <span
              v-if="item.kind === 'hit'"
              class="shrink-0 text-[11px] text-muted-foreground/70"
            >
              jump
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- Filters: available BEFORE searching (scope + type + groups) -->
    <div class="mb-6 flex flex-col items-center gap-3">
      <div class="flex items-center gap-3">
        <div
          class="inline-flex overflow-hidden rounded-full border bg-background text-xs"
          role="group"
          aria-label="Search scope"
        >
          <button
            v-for="sc in SCOPES"
            :key="sc.value"
            class="px-3 py-1.5 transition-colors"
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
        <button
          class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
          :class="
            aiOn
              ? 'border-primary bg-primary/10 font-medium text-foreground'
              : 'text-muted-foreground'
          "
          :aria-pressed="aiOn"
          title="AI 助手：总结 / 问答 / 研究计划 / 单页深读"
          @click="toggleAi"
        >
          <Sparkles class="h-3.5 w-3.5" />
          AI 助手
        </button>
      </div>

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

    <!-- AI assistant card -->
    <div
      v-if="aiOn"
      class="mb-6 w-full rounded-xl border bg-card text-left shadow-sm"
    >
      <div class="flex items-center justify-between border-b px-3 py-1.5">
        <div class="flex items-center gap-1">
          <Sparkles class="mr-1 h-3.5 w-3.5 text-muted-foreground" />
          <button
            v-for="m in AI_MODES"
            :key="m.value"
            class="rounded-full px-2.5 py-1 text-xs transition-colors"
            :class="
              aiMode === m.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent'
            "
            @click="switchAiMode(m.value)"
          >
            {{ m.label }}
          </button>
        </div>
        <button
          v-if="aiBusy"
          class="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="stopAi"
        >
          <Square class="h-3 w-3" />
          停止
        </button>
      </div>

      <!-- mode inputs -->
      <div class="border-b px-3 py-2">
        <div v-if="aiMode === 'summarize'" class="flex items-center gap-2">
          <Button
            size="sm"
            :disabled="aiBusy || !searched || hits.length === 0"
            @click="runAi('summarize')"
          >
            总结「{{ executedQuery }}」的前 {{ Math.min(hits.length, 12) }} 条
          </Button>
          <span
            v-if="!searched || hits.length === 0"
            class="text-xs text-muted-foreground"
          >
            先执行一次搜索，再总结
          </span>
        </div>
        <form
          v-else-if="aiMode === 'ask'"
          class="flex items-center gap-2"
          @submit.prevent="runAi('ask')"
        >
          <input
            v-model="askInput"
            placeholder="就库内资料提问，如：堆场派位有哪些策略？"
            class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            size="sm"
            type="submit"
            :disabled="aiBusy || !askInput.trim()"
          >
            提问
          </Button>
        </form>
        <form
          v-else-if="aiMode === 'plan'"
          class="flex items-center gap-2"
          @submit.prevent="runAi('plan')"
        >
          <input
            v-model="topicInput"
            placeholder="输入研究主题，生成检索/阅读计划"
            class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            size="sm"
            type="submit"
            :disabled="aiBusy || !topicInput.trim()"
          >
            生成计划
          </Button>
        </form>
        <div v-else class="flex items-center gap-2 text-xs">
          <template v-if="aiTarget">
            <span
              class="truncate rounded bg-muted px-2 py-1 text-muted-foreground"
            >
              {{ aiTarget.label }}
            </span>
            <button
              class="text-muted-foreground hover:underline"
              :disabled="aiBusy"
              @click="aiTarget && runAi('deepread')"
            >
              重新深读
            </button>
          </template>
          <span v-else class="text-muted-foreground">
            在下方搜索结果里点 📖 选择要深读的页
          </span>
        </div>
      </div>

      <!-- streamed output -->
      <div
        class="max-h-[28rem] overflow-y-auto px-4 py-3 text-sm leading-relaxed"
      >
        <p v-if="aiError" class="text-destructive">{{ aiError }}</p>
        <p
          v-else-if="aiBusy && !aiText"
          class="animate-pulse text-muted-foreground"
        >
          检索库内资料并生成中…
        </p>
        <p v-else-if="!aiText" class="text-muted-foreground">
          {{
            AI_MODES.find((m) => m.value === aiMode)?.label
          }}结果会显示在这里。
        </p>
        <template v-for="(l, li) in aiLines" v-else :key="li">
          <div v-if="l.kind === 'query'" class="my-1">
            <button
              class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent"
              title="以此检索词搜索"
              @click="runSuggestedQuery(l.q)"
            >
              <Search class="h-3 w-3" />
              {{ l.q }}
            </button>
          </div>
          <p v-else class="whitespace-pre-wrap">
            <template v-for="(part, pi) in citeParts(l.line)" :key="pi">
              <button
                v-if="part.cite"
                class="mx-0.5 rounded bg-muted px-1 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                :title="aiSources.find((s) => s.i === part.cite)?.fileName"
                @click="part.cite && openSourceByIndex(part.cite)"
              >
                {{ part.text }}
              </button>
              <template v-else>{{ part.text }}</template>
            </template>
          </p>
        </template>

        <!-- sources -->
        <div
          v-if="aiSources.length > 0 && !aiBusy"
          class="mt-3 flex flex-wrap gap-1.5 border-t pt-2"
        >
          <button
            v-for="s in aiSources"
            :key="s.i"
            class="inline-flex max-w-[16rem] items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :title="s.title ?? s.fileName"
            @click="openSourceByIndex(s.i)"
          >
            【{{ s.i }}】{{ s.fileName }}
            <span class="opacity-70">{{ s.unitType }} {{ s.ordinal }}</span>
          </button>
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
      No results. Try different keywords or adjust the filters.
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
          <span class="flex shrink-0 items-center gap-1">
            <button
              class="rounded p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
              title="AI 深读此页"
              @click.stop="startDeepread(hit)"
            >
              <BookOpen class="h-3.5 w-3.5" />
            </button>
            <span
              class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              {{ hit.unitType }} {{ hit.ordinal }}
            </span>
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
