<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import Button from "@/components/ui/Button.vue";
import Input from "@/components/ui/Input.vue";
import { api } from "@/api/client";
import { useAuthStore } from "@/stores/auth";

const route = useRoute();
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

const tab = ref<"sources" | "users" | "groups">(
  route.name === "settings-users"
    ? "users"
    : route.name === "settings-groups"
      ? "groups"
      : "sources",
);
const sources = ref<SourceRow[]>([]);
const users = ref<UserRow[]>([]);
const newSourcePath = ref("");
const message = ref("");
const allowRegistration = ref(true);

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
  } catch {
    users.value = [];
  }
  try {
    const settings = await api<{ allowRegistration: boolean }>(
      "/api/admin/settings",
    );
    allowRegistration.value = settings.allowRegistration;
  } catch {
    /* admin only */
  }
}

async function addSource(): Promise<void> {
  const p = newSourcePath.value.trim();
  if (!p) return;
  message.value = "";
  try {
    await api("/api/sources", {
      method: "POST",
      body: JSON.stringify({ rootPath: p }),
    });
    newSourcePath.value = "";
    message.value = "Added, scan started";
    await loadSources();
  } catch (err) {
    message.value = String(err);
  }
}

async function rescanSource(id: string): Promise<void> {
  await api(`/api/sources/${id}/rescan`, { method: "POST" });
  message.value = "Rescan started";
}

async function removeSource(id: string): Promise<void> {
  if (
    !confirm(
      "Remove this mount directory? Indexed content will also be removed.",
    )
  )
    return;
  await api(`/api/sources/${id}`, { method: "DELETE" });
  await loadSources();
}

async function toggleRegistration(): Promise<void> {
  const res = await api<{ allowRegistration: boolean }>("/api/admin/settings", {
    method: "PATCH",
    body: JSON.stringify({ allowRegistration: !allowRegistration.value }),
  });
  allowRegistration.value = res.allowRegistration;
}

async function resetPassword(u: UserRow): Promise<void> {
  const pw = prompt(`Set a new password for "${u.username}" (min 8 chars):`);
  if (!pw) return;
  try {
    await api(`/api/admin/users/${u.id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ newPassword: pw }),
    });
    message.value = `Reset ${u.username}  password`;
  } catch (err) {
    message.value = String(err);
  }
}

async function toggleUser(u: UserRow): Promise<void> {
  if (u.role === "super_admin" && u.enabled) {
    alert("Cannot disable super admin");
    return;
  }
  await api(`/api/admin/users/${u.id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled: !u.enabled }),
  });
  await loadUsers();
}

async function removeUser(u: UserRow): Promise<void> {
  if (u.id === auth.user?.id) {
    alert("Cannot delete yourself");
    return;
  }
  if (!confirm(`DeleteUsers「${u.username}"?`)) return;
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
});
</script>

<template>
  <div class="mx-auto max-w-3xl p-6">
    <div class="mb-4 flex gap-2 border-b pb-2">
      <button
        class="rounded px-3 py-1.5 text-sm transition-colors hover:bg-accent"
        :class="tab === 'sources' ? 'bg-accent font-medium' : ''"
        @click="tab = 'sources'"
      >
        Mounted Directories
      </button>
      <button
        class="rounded px-3 py-1.5 text-sm transition-colors hover:bg-accent"
        :class="tab === 'users' ? 'bg-accent font-medium' : ''"
        @click="tab = 'users'"
      >
        Users
      </button>
    </div>
    <p v-if="message" class="mb-3 text-xs text-muted-foreground">
      {{ message }}
    </p>

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

    <template v-else>
      <label class="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          :checked="allowRegistration"
          @change="toggleRegistration"
        />
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
          <div class="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" @click="resetPassword(u)">
              Reset Password
            </Button>
            <Button variant="ghost" size="sm" @click="toggleUser(u)">
              {{ u.enabled ? "Disable" : "Enable" }}
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
    </template>
  </div>
</template>
