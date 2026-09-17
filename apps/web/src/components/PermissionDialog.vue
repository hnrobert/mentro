<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Button from "@/components/ui/Button.vue";
import { api } from "@/api/client";
import { X, Shield, ShieldCheck } from "lucide-vue-next";

/**
 * Admin permission editor for ONE target (knowledge-base folder or
 * single file): visibility toggle (internal/public) + ACL entries
 * (user or user-group subjects with read/write/deny levels). Entries
 * on nearer targets override inherited ones (server resolves).
 */

const props = defineProps<{
  targetType: "group" | "asset";
  targetId: string;
  name: string;
}>();
const emit = defineEmits<{ close: [] }>();

interface PermEntry {
  id: string;
  subjectType: "user" | "user_group";
  subjectId: string;
  subjectName: string | null;
  level: "read" | "write" | "deny";
}

interface UserGroup {
  id: string;
  name: string;
  memberIds: string[];
}

interface UserRow {
  id: string;
  username: string;
  role: string;
}

const entries = ref<PermEntry[]>([]);
const userGroups = ref<UserGroup[]>([]);
const users = ref<UserRow[]>([]);
const visibility = ref<"internal" | "public">("internal");
const error = ref("");
const busy = ref(false);

// add-entry form
const newSubject = ref("");
const newLevel = ref<"read" | "write" | "deny">("read");

const subjects = computed(() => [
  ...users.value.map((u) => ({
    value: `user:${u.id}`,
    label: `👤 ${u.username}`,
  })),
  ...userGroups.value.map((g) => ({
    value: `user_group:${g.id}`,
    label: `👥 ${g.name}`,
  })),
]);

async function load(): Promise<void> {
  error.value = "";
  try {
    const [perm, groups, usersRes] = await Promise.all([
      api<{
        entries: PermEntry[];
      }>(
        `/api/admin/permissions?targetType=${props.targetType}&targetId=${props.targetId}`,
      ),
      api<{ groups: UserGroup[] }>("/api/admin/user-groups"),
      api<{ users: UserRow[] }>("/api/admin/users"),
    ]);
    entries.value = perm.entries;
    userGroups.value = groups.groups;
    users.value = usersRes.users;
    // Current visibility: folders from the tree data, files via detail.
    if (props.targetType === "group") {
      const tree = await api<{
        groups: Array<{
          id: string;
          visibility: "internal" | "public";
        }>;
      }>("/api/groups").catch(() => null);
      // /api/groups returns a tree; find node by id.
      const findNode = (
        nodes: Array<{
          id: string;
          visibility: "internal" | "public";
          children?: unknown;
        }>,
      ): "internal" | "public" | null => {
        for (const n of nodes) {
          if (n.id === props.targetId) return n.visibility;
          const hit = findNode((n.children ?? []) as typeof nodes);
          if (hit) return hit;
        }
        return null;
      };
      if (tree) visibility.value = findNode(tree.groups) ?? "internal";
    } else {
      const detail = await api<{
        asset: { visibility: "internal" | "public" };
      }>(`/api/assets/${props.targetId}`).catch(() => null);
      if (detail) visibility.value = detail.asset.visibility;
    }
  } catch (err) {
    error.value = String(err);
  }
}

async function setVisibility(next: "internal" | "public"): Promise<void> {
  busy.value = true;
  try {
    await api("/api/admin/visibility", {
      method: "PATCH",
      body: JSON.stringify({
        targetType: props.targetType,
        targetId: props.targetId,
        visibility: next,
      }),
    });
    visibility.value = next;
  } catch (err) {
    error.value = String(err);
  } finally {
    busy.value = false;
  }
}

async function addEntry(): Promise<void> {
  const subject = newSubject.value;
  if (!subject.includes(":")) return;
  const [subjectType, subjectId] = subject.split(":", 2);
  busy.value = true;
  try {
    await api("/api/admin/permissions", {
      method: "PUT",
      body: JSON.stringify({
        subjectType,
        subjectId,
        targetType: props.targetType,
        targetId: props.targetId,
        level: newLevel.value,
      }),
    });
    newSubject.value = "";
    await load();
  } catch (err) {
    error.value = String(err);
  } finally {
    busy.value = false;
  }
}

async function removeEntry(id: string): Promise<void> {
  const entry = entries.value.find((e) => e.id === id);
  if (!entry) return;
  busy.value = true;
  try {
    await api("/api/admin/permissions", {
      method: "PUT",
      body: JSON.stringify({
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        targetType: props.targetType,
        targetId: props.targetId,
        level: null,
      }),
    });
    await load();
  } catch (err) {
    error.value = String(err);
  } finally {
    busy.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    @click.self="emit('close')"
  >
    <div
      class="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-background shadow-xl"
    >
      <div
        class="flex shrink-0 items-center justify-between border-b px-4 py-3"
      >
        <div class="min-w-0">
          <h2 class="flex items-center gap-2 text-base font-semibold">
            <Shield class="h-4 w-4 text-muted-foreground" />
            Permissions
          </h2>
          <p class="truncate text-xs text-muted-foreground">{{ name }}</p>
        </div>
        <button
          class="rounded p-1 text-muted-foreground hover:bg-accent"
          aria-label="Close"
          @click="emit('close')"
        >
          <X class="h-4 w-4" />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <p v-if="error" class="text-xs text-destructive">{{ error }}</p>

        <!-- Visibility -->
        <div class="rounded-lg border p-3">
          <p class="text-xs font-medium text-muted-foreground">Visibility</p>
          <p class="mt-1 text-[11px] text-muted-foreground/70">
            Applies when no explicit entry matches (inheritance fallback).
          </p>
          <div
            class="mt-2 inline-flex overflow-hidden rounded-full border text-xs"
          >
            <button
              class="px-3 py-1 transition-colors"
              :class="
                visibility === 'internal'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              "
              :disabled="busy"
              @click="setVisibility('internal')"
            >
              <Shield class="mr-1 inline h-3 w-3" />
              Internal
            </button>
            <button
              class="border-l px-3 py-1 transition-colors"
              :class="
                visibility === 'public'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              "
              :disabled="busy"
              @click="setVisibility('public')"
            >
              <ShieldCheck class="mr-1 inline h-3 w-3" />
              Public (对外)
            </button>
          </div>
        </div>

        <!-- Entries -->
        <div class="rounded-lg border">
          <div
            class="border-b px-3 py-2 text-xs font-medium text-muted-foreground"
          >
            Explicit grants (override inheritance)
          </div>
          <div
            v-if="entries.length === 0"
            class="px-3 py-3 text-xs text-muted-foreground"
          >
            No entries — this target inherits from its parent.
          </div>
          <div
            v-for="e in entries"
            :key="e.id"
            class="flex items-center justify-between gap-2 border-b px-3 py-2 text-sm last:border-b-0"
          >
            <span class="min-w-0 flex-1 truncate">
              <span
                class="mr-1.5 rounded bg-muted px-1 py-0.5 text-[10px] uppercase text-muted-foreground"
              >
                {{ e.subjectType === "user" ? "user" : "group" }}
              </span>
              {{ e.subjectName ?? e.subjectId }}
            </span>
            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium"
              :class="
                e.level === 'deny'
                  ? 'bg-destructive/10 text-destructive'
                  : e.level === 'write'
                    ? 'bg-emerald-500/10 text-emerald-600'
                    : 'bg-muted text-muted-foreground'
              "
            >
              {{ e.level }}
            </span>
            <button
              class="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
              :aria-label="`Remove entry`"
              :disabled="busy"
              @click="removeEntry(e.id)"
            >
              <X class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <!-- Add entry -->
        <div class="rounded-lg border p-3">
          <p class="mb-2 text-xs font-medium text-muted-foreground">
            Add grant
          </p>
          <div class="flex items-center gap-2">
            <select
              v-model="newSubject"
              class="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 text-sm"
            >
              <option value="" disabled>Select user or group…</option>
              <option v-for="s in subjects" :key="s.value" :value="s.value">
                {{ s.label }}
              </option>
            </select>
            <select
              v-model="newLevel"
              class="h-8 shrink-0 rounded border border-input bg-background px-2 text-sm"
            >
              <option value="read">read</option>
              <option value="write">write</option>
              <option value="deny">deny</option>
            </select>
            <Button size="sm" :disabled="!newSubject || busy" @click="addEntry">
              Add
            </Button>
          </div>
          <p class="mt-2 text-[11px] text-muted-foreground/70">
            deny beats write/read; user beats group; nearer target beats
            farther.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
