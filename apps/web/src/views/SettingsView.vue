<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import Button from "@/components/ui/Button.vue";
import Input from "@/components/ui/Input.vue";
import { api } from "@/api/client";
import { GuardedSave } from "vue-guarded-save";
import { Trash2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { confirmDialog } from "@/lib/confirm";
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

interface SourceRow {
  id: string;
  rootPath: string;
  assetCount: number;
  doneCount: number;
  lastScanAt: string | null;
}

interface UserRow {
  id: string;
  username: string;
  role: string;
  enabled: boolean;
  createdAt: string;
}

/** The tab IS the route — every settings page has its own URL, so
 *  refresh/back/forward land on the same tab instead of bouncing to
 *  the default. Tab buttons navigate; no local tab state to drift. */
const tab = computed<"sources" | "users" | "groups" | "translation" | "models">(
  () =>
    route.name === "settings-users"
      ? "users"
      : route.name === "settings-groups"
        ? "groups"
        : route.name === "settings-translation"
          ? "translation"
          : route.name === "settings-models"
            ? "models"
            : "sources",
);

function navTab(name: string): void {
  void router.push({ name });
}
const sources = ref<SourceRow[]>([]);
const users = ref<UserRow[]>([]);
const newSourcePath = ref("");
const allowRegistration = ref(true);
const allowRegistrationSaved = ref(true);

async function loadSources(): Promise<void> {
  try {
    const res = await api<{ sources: SourceRow[] }>("/api/sources");
    sources.value = res.sources;
  } catch {
    sources.value = [];
  }
}

async function loadUsers(): Promise<void> {
  try {
    const res = await api<{ users: UserRow[] }>("/api/admin/users");
    users.value = res.users;
    usersSaved.value = JSON.parse(JSON.stringify(res.users));
  } catch {
    users.value = [];
  }
  try {
    const settings = await api<{ allowRegistration: boolean }>(
      "/api/admin/settings",
    );
    allowRegistration.value = settings.allowRegistration;
    allowRegistrationSaved.value = settings.allowRegistration;
  } catch {
    /* admin only */
  }
}

async function addSource(): Promise<void> {
  const p = newSourcePath.value.trim();
  if (!p) return;
  try {
    await api("/api/sources", {
      method: "POST",
      body: JSON.stringify({ rootPath: p }),
    });
    newSourcePath.value = "";
    toast.success("Added, scan started");
    await loadSources();
  } catch (err) {
    toast.error(String(err));
  }
}

async function rescanSource(id: string): Promise<void> {
  await api(`/api/sources/${id}/rescan`, { method: "POST" });
}

async function removeSource(id: string): Promise<void> {
  const ok = await confirmDialog({
    title: "Remove this mount directory?",
    description: "Indexed content will also be removed.",
    confirmText: "Remove",
    destructive: true,
  });
  if (!ok) return;
  await api(`/api/sources/${id}`, { method: "DELETE" });
  await loadSources();
}

/** The Users tab is one draft: registration flag + per-user
 *  role/enabled checkboxes mutate locally; a single GuardedSave bar
 *  commits the diff (PATCH only what changed). */
const usersSaved = ref<UserRow[]>([]);

const regDirty = computed(
  () => allowRegistration.value !== allowRegistrationSaved.value,
);
const usersDirty = computed(() =>
  users.value.some((u, i) => {
    const snap = usersSaved.value[i];
    return snap && (snap.role !== u.role || snap.enabled !== u.enabled);
  }),
);
const accountDirty = computed(() => regDirty.value || usersDirty.value);

async function saveUsers(): Promise<boolean> {
  try {
    if (regDirty.value) {
      await api("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ allowRegistration: allowRegistration.value }),
      });
      allowRegistrationSaved.value = allowRegistration.value;
    }
    for (let i = 0; i < users.value.length; i++) {
      const u = users.value[i]!;
      const snap = usersSaved.value[i];
      if (!snap || (snap.role === u.role && snap.enabled === u.enabled)) {
        continue;
      }
      await api(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: u.role, enabled: u.enabled }),
      });
    }
    usersSaved.value = JSON.parse(JSON.stringify(users.value));
    toast.success("Account settings saved");
    return true;
  } catch (err) {
    toast.error(String(err));
    return false;
  }
}

function discardUsers(): void {
  allowRegistration.value = allowRegistrationSaved.value;
  users.value = JSON.parse(JSON.stringify(usersSaved.value));
}

function toggleEnabledLocal(u: UserRow, on: boolean): void {
  u.enabled = on;
}

async function resetPassword(u: UserRow): Promise<void> {
  const pw = prompt(`Set a new password for "${u.username}" (min 8 chars):`);
  if (!pw) return;
  try {
    await api(`/api/admin/users/${u.id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ newPassword: pw }),
    });
  } catch (err) {
    toast.error(String(err));
  }
}

async function removeUser(u: UserRow): Promise<void> {
  if (u.id === auth.user?.id) {
    toast.error("Cannot delete yourself");
    return;
  }
  const ok = await confirmDialog({
    title: `Delete user "${u.username}"?`,
    confirmText: "Delete",
    destructive: true,
  });
  if (!ok) return;
  await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
  await loadUsers();
}

// --- user groups (admin) ---

interface UserGroupRow {
  id: string;
  name: string;
  memberIds: string[];
  _open?: boolean;
}

const userGroups = ref<UserGroupRow[]>([]);
const newGroupName = ref("");
const groupsError = ref("");

async function loadUserGroups(): Promise<void> {
  try {
    const res = await api<{ groups: UserGroupRow[] }>("/api/admin/user-groups");
    userGroups.value = res.groups.map((g) => ({ ...g, _open: false }));
  } catch (err) {
    groupsError.value = String(err);
  }
}

async function createUserGroup(): Promise<void> {
  const name = newGroupName.value.trim();
  if (!name) return;
  groupsError.value = "";
  try {
    await api("/api/admin/user-groups", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    newGroupName.value = "";
    await loadUserGroups();
  } catch (err) {
    groupsError.value = String(err);
  }
}

async function renameUserGroup(g: UserGroupRow): Promise<void> {
  try {
    await api(`/api/admin/user-groups/${g.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: g.name.trim() }),
    });
  } catch (err) {
    groupsError.value = String(err);
  }
}

async function deleteUserGroup(g: UserGroupRow): Promise<void> {
  try {
    await api(`/api/admin/user-groups/${g.id}`, { method: "DELETE" });
    await loadUserGroups();
  } catch (err) {
    groupsError.value = String(err);
  }
}

function toggleMembers(g: UserGroupRow): void {
  g._open = !g._open;
}

async function toggleMember(g: UserGroupRow, userId: string): Promise<void> {
  const next = g.memberIds.includes(userId)
    ? g.memberIds.filter((id) => id !== userId)
    : [...g.memberIds, userId];
  g.memberIds = next;
  try {
    await api(`/api/admin/user-groups/${g.id}`, {
      method: "PATCH",
      body: JSON.stringify({ memberIds: next }),
    });
  } catch (err) {
    groupsError.value = String(err);
  }
}

onMounted(() => {
  void loadUserGroups();
  void loadSources();
  void loadUsers();
  if (auth.user?.role === "super_admin" && tab.value === "translation") {
    void loadTranslation();
  }
  if (auth.user?.role === "super_admin" && tab.value === "models") {
    void loadModels();
  }
});

// --- models tab (admin: LLM registry) ---------------------------------------

interface ModelRow {
  id: string; // "" for a new draft row
  name: string;
  baseUrl: string;
  apiKey: string; // "__set__" = unchanged
  model: string;
  enabled: boolean;
  makeDefault: boolean;
  hasKey?: boolean;
  isNew?: boolean;
}
const modelsDraft = ref<ModelRow[]>([]);
const modelsSaved = ref<ModelRow[]>([]);

const modelsDirty = computed(
  () => JSON.stringify(modelsDraft.value) !== JSON.stringify(modelsSaved.value),
);

async function loadModels(): Promise<void> {
  try {
    const res = await api<{ models: ModelRow[] }>("/api/admin/models");
    // apiKey never comes back; keep "__set__" sentinel on saved rows.
    const rows = res.models.map((m) => ({ ...m, apiKey: "__set__" }));
    modelsDraft.value = JSON.parse(JSON.stringify(rows));
    modelsSaved.value = JSON.parse(JSON.stringify(rows));
  } catch {
    modelsDraft.value = [];
    modelsSaved.value = [];
  }
}

function addModelRow(): void {
  modelsDraft.value.push({
    id: "",
    name: "",
    baseUrl: "",
    apiKey: "",
    model: "",
    enabled: true,
    makeDefault: modelsDraft.value.length === 0,
    isNew: true,
  });
}

function removeModelRow(i: number): void {
  const row = modelsDraft.value[i]!;
  if (!row.id) {
    modelsDraft.value.splice(i, 1);
    return;
  }
  void (async () => {
    const ok = await confirmDialog({
      title: `Delete model "${row.name}"?`,
      description: "Users on it fall back to the default.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/api/admin/models/${row.id}`, { method: "DELETE" });
      toast.success("Model deleted");
      await loadModels();
    } catch (err) {
      toast.error(String(err));
    }
  })();
}

function setModelDefault(i: number): void {
  modelsDraft.value.forEach((m, j) => (m.makeDefault = j === i));
}

async function saveModels(): Promise<boolean> {
  try {
    for (const m of modelsDraft.value) {
      if (!m.name.trim() || !m.baseUrl.trim() || !m.model.trim()) {
        toast.error("Every model needs name, base URL and model id");
        return false;
      }
    }
    for (let i = 0; i < modelsDraft.value.length; i++) {
      const m = modelsDraft.value[i]!;
      const snap = modelsSaved.value[i];
      if (m.id === "") {
        const res = await api<{ model: { id: string } }>("/api/admin/models", {
          method: "POST",
          body: JSON.stringify({
            name: m.name,
            baseUrl: m.baseUrl,
            apiKey: m.apiKey,
            model: m.model,
            makeDefault: m.makeDefault,
          }),
        });
        m.id = res.model.id;
        m.hasKey = true;
      } else if (snap && JSON.stringify(m) !== JSON.stringify(snap)) {
        await api(`/api/admin/models/${m.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: m.name,
            baseUrl: m.baseUrl,
            apiKey: m.apiKey,
            model: m.model,
            enabled: m.enabled,
            makeDefault: m.makeDefault,
          }),
        });
      }
    }
    await loadModels();
    toast.success("Models saved");
    return true;
  } catch (err) {
    toast.error(String(err));
    return false;
  }
}

function discardModels(): void {
  modelsDraft.value = JSON.parse(JSON.stringify(modelsSaved.value));
}

// --- translation tab -------------------------------------------------------

interface TranslateSettings {
  translateEnabledLangs: string[];
  translateBackendOrder: string[];
  translateRatePerMin: number;
  translateGlossary: Array<{ src: string; dst: string }>;
  translateDeeplKey: string;
  translateDeeplPro: boolean;
  translateBaiduAppid: string;
  translateBaiduKey: string;
  translateGoogleKey: string;
  translateLibreUrl: string;
  translateLibreKey: string;
}

interface LangStatus {
  lang: string;
  total: number;
  translated: number;
  skipped: number;
  done: number;
  missing: number;
  complete: boolean;
  pending: boolean;
  running: boolean;
}

const EXTRA_LANGS = [
  { code: "ja", label: "日本語 ja" },
  { code: "ko", label: "한국어 ko" },
  { code: "de", label: "Deutsch de" },
  { code: "fr", label: "Français fr" },
  { code: "ru", label: "Русский ru" },
  { code: "es", label: "Español es" },
] as const;

const tset = ref<TranslateSettings | null>(null);
/** Pristine copy the draft is diffed against (GuardedSave dirty/discard). */
const tsetSaved = ref<TranslateSettings | null>(null);
const tstatus = ref<LangStatus[]>([]);
let statusTimer: ReturnType<typeof setInterval> | null = null;

async function loadTranslation(): Promise<void> {
  try {
    const s = await api<TranslateSettings>("/api/admin/settings");
    tset.value = {
      ...s,
      translateGlossary: s.translateGlossary ?? [],
    };
    tsetSaved.value = JSON.parse(JSON.stringify(tset.value));
    await refreshTranslateStatus();
  } catch (err) {
    toast.error(String(err));
  }
}

async function refreshTranslateStatus(): Promise<void> {
  try {
    const res = await api<{ langs: LangStatus[] }>(
      "/api/admin/translate/status",
    );
    tstatus.value = res.langs;
    const busy = res.langs.some((l) => l.pending || l.running);
    if (busy && statusTimer === null) {
      statusTimer = setInterval(() => void refreshTranslateStatus(), 3000);
    } else if (!busy && statusTimer !== null) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  } catch {
    /* status is best-effort */
  }
}

const tsetDirty = computed(() => {
  if (!tset.value || !tsetSaved.value) return false;
  return JSON.stringify(tset.value) !== JSON.stringify(tsetSaved.value);
});

function discardTranslation(): void {
  if (tsetSaved.value) tset.value = JSON.parse(JSON.stringify(tsetSaved.value));
}

function toggleLang(code: string): void {
  if (!tset.value) return;
  const cur = tset.value.translateEnabledLangs;
  tset.value.translateEnabledLangs = cur.includes(code)
    ? cur.filter((c) => c !== code)
    : [...cur, code];
}

async function saveTranslation(): Promise<boolean> {
  if (!tset.value) return false;
  try {
    const s = await api<TranslateSettings>("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(tset.value),
    });
    tset.value = { ...tset.value, ...s };
    tsetSaved.value = JSON.parse(JSON.stringify(tset.value));
    toast.success("Saved — newly enabled languages backfill automatically");
    await refreshTranslateStatus();
    return true;
  } catch (err) {
    return false; // no ✓-flash on failure
  }
}

async function runTranslateNow(): Promise<void> {
  try {
    await api("/api/admin/translate/run", {
      method: "POST",
      body: JSON.stringify({}),
    });
    toast.success("Translation queued");
    await refreshTranslateStatus();
  } catch (err) {
    toast.error(String(err));
  }
}

function moveBackend(i: number, dir: -1 | 1): void {
  if (!tset.value) return;
  const order = [...tset.value.translateBackendOrder];
  const j = i + dir;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  tset.value.translateBackendOrder = order;
}
</script>

<template>
  <div class="mx-auto max-w-3xl p-6">
    <div class="mb-4 flex gap-2 border-b pb-2">
      <button
        class="rounded px-3 py-1.5 text-sm transition-colors hover:bg-accent"
        :class="tab === 'sources' ? 'bg-accent font-medium' : ''"
        @click="navTab('settings-sources')"
      >
        Mounted Directories
      </button>
      <button
        v-if="auth.user?.role === 'super_admin'"
        class="rounded px-3 py-1.5 text-sm transition-colors hover:bg-accent"
        :class="tab === 'users' ? 'bg-accent font-medium' : ''"
        @click="navTab('settings-users')"
      >
        Users
      </button>
      <button
        v-if="auth.user?.role === 'super_admin'"
        class="rounded px-3 py-1.5 text-sm transition-colors hover:bg-accent"
        :class="tab === 'translation' ? 'bg-accent font-medium' : ''"
        @click="
          () => {
            navTab('settings-translation');
            if (!tset) void loadTranslation();
          }
        "
      >
        Translation
      </button>
      <button
        v-if="auth.user?.role === 'super_admin'"
        class="rounded px-3 py-1.5 text-sm transition-colors hover:bg-accent"
        :class="tab === 'models' ? 'bg-accent font-medium' : ''"
        @click="
          () => {
            navTab('settings-models');
            if (modelsDraft.length === 0) void loadModels();
          }
        "
      >
        Models
      </button>
    </div>

    <!-- Sources tab -->
    <template v-if="tab === 'sources'">
      <div class="mb-4 flex gap-2">
        <Input
          v-model="newSourcePath"
          placeholder="Server directory absolute path…"
        />
        <Button variant="outline" size="sm" @click="addSource">Mount</Button>
      </div>
      <div class="space-y-2">
        <div
          v-for="s in sources"
          :key="s.id"
          class="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
        >
          <div class="min-w-0">
            <p class="truncate font-mono text-xs">{{ s.rootPath }}</p>
            <p class="mt-0.5 text-xs text-muted-foreground">
              {{ s.doneCount }}/{{ s.assetCount }} indexed
            </p>
          </div>
          <div class="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" @click="rescanSource(s.id)">
              Rescan
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-destructive"
              @click="removeSource(s.id)"
            >
              Remove
            </Button>
          </div>
        </div>
      </div>
    </template>

    <!-- Users tab -->
    <template v-else-if="tab === 'groups'">
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">User Groups</h2>
          <div class="flex items-center gap-2">
            <Input
              v-model="newGroupName"
              placeholder="New group name"
              class="h-8 w-44"
              @keydown.enter="createUserGroup"
            />
            <Button
              size="sm"
              :disabled="!newGroupName.trim()"
              @click="createUserGroup"
            >
              Create
            </Button>
          </div>
        </div>
        <p v-if="groupsError" class="text-xs text-destructive">
          {{ groupsError }}
        </p>
        <p v-if="userGroups.length === 0" class="text-sm text-muted-foreground">
          No user groups yet — create one, then grant it permissions on
          folders/files from the Library.
        </p>
        <div v-for="g in userGroups" :key="g.id" class="rounded-lg border p-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <input
                v-model="g.name"
                class="h-8 rounded border border-input bg-background px-2 text-sm"
                @change="renameUserGroup(g)"
              />
              <span class="text-xs text-muted-foreground">
                {{ g.memberIds.length }} member{{
                  g.memberIds.length === 1 ? "" : "s"
                }}
              </span>
            </div>
            <div class="flex items-center gap-1">
              <Button size="sm" variant="ghost" @click="toggleMembers(g)">
                {{ g._open ? "Hide members" : "Members" }}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                class="text-destructive"
                @click="deleteUserGroup(g)"
              >
                Delete
              </Button>
            </div>
          </div>
          <div v-if="g._open" class="mt-2 border-t pt-2">
            <label
              v-for="u in users"
              :key="u.id"
              class="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent/40"
            >
              <input
                type="checkbox"
                :checked="g.memberIds.includes(u.id)"
                @change="toggleMember(g, u.id)"
              />
              {{ u.username }}
              <span class="text-xs text-muted-foreground">{{ u.role }}</span>
            </label>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="tab === 'users'">
      <label class="mb-4 flex items-center gap-2 text-sm">
        <input v-model="allowRegistration" type="checkbox" />
        Allow new user registration
      </label>
      <div class="space-y-2">
        <div
          v-for="u in users"
          :key="u.id"
          class="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
        >
          <div>
            <p class="font-medium">{{ u.username }}</p>
            <p class="text-xs text-muted-foreground">
              {{ u.role }} · {{ u.enabled ? "enabled" : "disabled" }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-4">
            <label
              class="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              Role
              <select
                class="h-7 rounded border border-input bg-background px-1.5 text-xs"
                :value="u.role"
                :disabled="u.id === auth.user?.id"
                @change="u.role = ($event.target as HTMLSelectElement).value"
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
                <option value="super_admin">super_admin</option>
              </select>
            </label>
            <label
              class="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              Enabled
              <input
                type="checkbox"
                class="h-4 w-4"
                :disabled="u.role === 'super_admin'"
                :checked="u.enabled"
                @change="
                  toggleEnabledLocal(
                    u,
                    ($event.target as HTMLInputElement).checked,
                  )
                "
              />
            </label>
          </div>
          <div class="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" @click="resetPassword(u)">
              Reset Password
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-destructive"
              @click="removeUser(u)"
            >
              Delete
            </Button>
          </div>
        </div>
      </div>
      <!-- One bar for the whole tab: registration + role/enabled diffs
           commit together; role changes apply live (no re-login). -->
      <GuardedSave
        :dirty="accountDirty"
        :on-save="saveUsers"
        :on-discard="discardUsers"
        :sidebar-inset="false"
        save-shortcut
      />
    </template>

    <!-- Translation tab -->
    <template v-else-if="tab === 'translation'">
      <div v-if="!tset" class="text-sm text-muted-foreground">Loading…</div>
      <template v-else>
        <!-- Languages -->
        <div class="mb-5">
          <h3 class="mb-2 text-sm font-semibold">Languages</h3>
          <p class="mb-2 text-xs text-muted-foreground">
            Chinese ↔ English is always on; enabling more languages backfills
            them automatically.
          </p>
          <div class="flex flex-wrap gap-2">
            <span
              class="rounded-full border border-primary/40 bg-muted px-3 py-1 text-xs"
            >
              zh · always on
            </span>
            <span
              class="rounded-full border border-primary/40 bg-muted px-3 py-1 text-xs"
            >
              en · always on
            </span>
            <label
              v-for="l in EXTRA_LANGS"
              :key="l.code"
              class="flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors"
              :class="
                tset.translateEnabledLangs.includes(l.code)
                  ? 'border-primary bg-primary/10 font-medium'
                  : 'text-muted-foreground'
              "
            >
              <input
                type="checkbox"
                class="h-3 w-3"
                :checked="tset.translateEnabledLangs.includes(l.code)"
                @change="toggleLang(l.code)"
              />
              {{ l.label }}
            </label>
          </div>
        </div>

        <!-- Backends -->
        <div class="mb-5">
          <h3 class="mb-2 text-sm font-semibold">Backends (fallback order)</h3>
          <p class="mb-2 text-xs text-muted-foreground">
            The LLM comes from server env (MENTRO_TRANSLATE_*, falling back to
            MENTRO_LLM_*); translation API keys go below.
          </p>
          <div class="space-y-1">
            <div
              v-for="(b, i) in tset.translateBackendOrder"
              :key="b"
              class="flex items-center justify-between rounded border px-3 py-1.5 text-sm"
            >
              <span class="font-mono text-xs">{{ b }}</span>
              <span class="flex gap-1">
                <button
                  class="rounded px-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-30"
                  :disabled="i === 0"
                  @click="moveBackend(i, -1)"
                >
                  ↑
                </button>
                <button
                  class="rounded px-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-30"
                  :disabled="i === tset.translateBackendOrder.length - 1"
                  @click="moveBackend(i, 1)"
                >
                  ↓
                </button>
              </span>
            </div>
          </div>
          <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="text-xs text-muted-foreground">
              DeepL API Key
              <Input
                v-model="tset.translateDeeplKey"
                type="password"
                class="mt-1 h-8"
                placeholder="set (shows __set__)"
              />
              <span class="mt-1 flex items-center gap-1.5">
                <input
                  v-model="tset.translateDeeplPro"
                  type="checkbox"
                  class="h-3 w-3"
                />
                Pro key
              </span>
            </label>
            <label class="text-xs text-muted-foreground">
              Baidu APPID
              <Input
                v-model="tset.translateBaiduAppid"
                type="password"
                class="mt-1 h-8"
              />
            </label>
            <label class="text-xs text-muted-foreground">
              Baidu Key
              <Input
                v-model="tset.translateBaiduKey"
                type="password"
                class="mt-1 h-8"
              />
            </label>
            <label class="text-xs text-muted-foreground">
              Google API Key
              <Input
                v-model="tset.translateGoogleKey"
                type="password"
                class="mt-1 h-8"
              />
            </label>
            <label class="text-xs text-muted-foreground">
              LibreTranslate URL
              <Input
                v-model="tset.translateLibreUrl"
                class="mt-1 h-8"
                placeholder="http://libre:5000"
              />
            </label>
            <label class="text-xs text-muted-foreground">
              LibreTranslate Key (optional)
              <Input
                v-model="tset.translateLibreKey"
                type="password"
                class="mt-1 h-8"
              />
            </label>
          </div>
        </div>

        <!-- Rate + glossary -->
        <div class="mb-5">
          <h3 class="mb-2 text-sm font-semibold">Rate & Glossary</h3>
          <label class="block text-xs text-muted-foreground">
            Rate (units/min, 1–600)
            <input
              v-model.number="tset.translateRatePerMin"
              type="number"
              min="1"
              max="600"
              class="mt-1 flex h-8 w-32 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
          <p class="mb-1 mt-3 text-xs text-muted-foreground">
            Glossary (LLM backend only; existing translations pick it up on a
            manual re-run)
          </p>
          <div class="space-y-1">
            <div
              v-for="(g, i) in tset.translateGlossary"
              :key="i"
              class="flex items-center gap-2"
            >
              <Input v-model="g.src" class="h-8" placeholder="Source term" />
              <span class="text-xs text-muted-foreground">→</span>
              <Input v-model="g.dst" class="h-8" placeholder="Translation" />
              <button
                class="rounded p-1 text-muted-foreground hover:text-destructive"
                @click="tset.translateGlossary.splice(i, 1)"
              >
                ✕
              </button>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            class="mt-2"
            @click="tset.translateGlossary.push({ src: '', dst: '' })"
          >
            + Add term
          </Button>
        </div>

        <div class="mb-5 flex items-center gap-2">
          <Button variant="outline" size="sm" @click="runTranslateNow">
            Translate Now
          </Button>
        </div>
        <!-- Save bar + unsaved-leave guard + saving lifecycle. The
             sidebar is resizable, so no fixed inset — full-width bar. -->
        <GuardedSave
          :dirty="tsetDirty"
          :on-save="saveTranslation"
          :on-discard="discardTranslation"
          :sidebar-inset="false"
          save-shortcut
        />

        <!-- Progress. done = translated + same-source skips, so the bar
             reaches 100% and completed languages show an explicit check. -->
        <div>
          <h3 class="mb-2 text-sm font-semibold">Progress</h3>
          <div class="space-y-2">
            <div
              v-for="l in tstatus"
              :key="l.lang"
              class="rounded border px-3 py-2 text-xs"
              :class="l.complete ? 'border-primary/30' : ''"
            >
              <div class="mb-1 flex items-center justify-between">
                <span class="flex items-center gap-1.5 font-medium">
                  {{ l.lang }}
                  <span
                    v-if="l.complete"
                    class="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
                    >done</span
                  >
                </span>
                <span class="text-muted-foreground">
                  <template v-if="l.complete">
                    {{ l.translated }} translated ·
                    {{ l.skipped }} same-language · up to date
                  </template>
                  <template v-else>
                    {{ l.done }}/{{ l.total }}
                    <span v-if="l.missing > 0" class="ml-1">
                      ({{ l.missing }} to go)
                    </span>
                    <span
                      v-if="l.running"
                      class="ml-1 animate-pulse text-primary"
                      >running…</span
                    >
                    <span
                      v-else-if="l.pending"
                      class="ml-1 text-muted-foreground"
                      >queued</span
                    >
                  </template>
                </span>
              </div>
              <div class="h-1.5 overflow-hidden rounded bg-muted">
                <div
                  class="h-full rounded transition-all"
                  :class="l.complete ? 'bg-primary/60' : 'bg-primary'"
                  :style="{
                    width: `${l.total ? Math.round((l.done / l.total) * 100) : 0}%`,
                  }"
                />
              </div>
            </div>
          </div>
        </div>
      </template>
    </template>

    <!-- Models tab (admin: AI model registry) -->
    <template v-else-if="tab === 'models'">
      <p class="mb-4 text-xs text-muted-foreground">
        AI models available to the assistant. The default applies to everyone;
        users pick their own in the answer card.
      </p>
      <div class="space-y-3">
        <div
          v-for="(m, i) in modelsDraft"
          :key="i"
          class="rounded-lg border p-3"
          :class="m.makeDefault ? 'border-primary/40' : ''"
        >
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label class="text-xs text-muted-foreground">
              Name
              <Input
                v-model="m.name"
                class="mt-1 h-8"
                placeholder="Turbo (fast)"
              />
            </label>
            <label class="text-xs text-muted-foreground">
              Model id
              <Input
                v-model="m.model"
                class="mt-1 h-8"
                placeholder="glm-5-turbo"
              />
            </label>
            <label class="text-xs text-muted-foreground sm:col-span-2">
              Base URL (OpenAI-compatible)
              <Input
                v-model="m.baseUrl"
                class="mt-1 h-8"
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label class="text-xs text-muted-foreground sm:col-span-2">
              API key
              <Input
                v-model="m.apiKey"
                type="password"
                class="mt-1 h-8"
                :placeholder="m.hasKey ? 'set (shows __set__)' : 'sk-…'"
              />
            </label>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-3 text-xs">
            <label class="flex items-center gap-1.5 text-muted-foreground">
              <input
                type="radio"
                name="default-model"
                :checked="m.makeDefault"
                @change="setModelDefault(i)"
              />
              Default
            </label>
            <label class="flex items-center gap-1.5 text-muted-foreground">
              <input v-model="m.enabled" type="checkbox" class="h-3.5 w-3.5" />
              Enabled
            </label>
            <button
              class="ml-auto rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
              title="Delete"
              @click="removeModelRow(i)"
            >
              <Trash2 class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
      <Button variant="outline" size="sm" class="mt-3" @click="addModelRow">
        + Add model
      </Button>
      <GuardedSave
        :dirty="modelsDirty"
        :on-save="saveModels"
        :on-discard="discardModels"
        :sidebar-inset="false"
        save-shortcut
      />
    </template>
  </div>
</template>
