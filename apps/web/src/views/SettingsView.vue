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

const tab = ref<"sources" | "users">(
  route.name === "settings-users" ? "users" : "sources",
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
    message.value = "已添加，扫描已启动";
    await loadSources();
  } catch (err) {
    message.value = String(err);
  }
}

async function rescanSource(id: string): Promise<void> {
  await api(`/api/sources/${id}/rescan`, { method: "POST" });
  message.value = "重扫已启动";
}

async function removeSource(id: string): Promise<void> {
  if (!confirm("移除此挂载目录？已索引内容也会移除。")) return;
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
  const pw = prompt(`为「${u.username}」设置新密码（≥8 位）：`);
  if (!pw) return;
  try {
    await api(`/api/admin/users/${u.id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ newPassword: pw }),
    });
    message.value = `已重置 ${u.username} 的密码`;
  } catch (err) {
    message.value = String(err);
  }
}

async function toggleUser(u: UserRow): Promise<void> {
  if (u.role === "super_admin" && u.enabled) {
    alert("不能禁用超级管理员");
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
    alert("不能删除自己");
    return;
  }
  if (!confirm(`删除用户「${u.username}」？`)) return;
  await api(`/api/admin/users/${u.id}`, { method: "DELETE" });
  await loadUsers();
}

onMounted(() => {
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
        挂载目录
      </button>
      <button
        class="rounded px-3 py-1.5 text-sm transition-colors hover:bg-accent"
        :class="tab === 'users' ? 'bg-accent font-medium' : ''"
        @click="tab = 'users'"
      >
        用户
      </button>
    </div>
    <p v-if="message" class="mb-3 text-xs text-muted-foreground">
      {{ message }}
    </p>

    <!-- Sources tab -->
    <template v-if="tab === 'sources'">
      <div class="mb-4 flex gap-2">
        <Input v-model="newSourcePath" placeholder="服务器目录绝对路径…" />
        <Button variant="outline" size="sm" @click="addSource">挂载</Button>
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
              {{ s.doneCount }}/{{ s.assetCount }} 已索引
            </p>
          </div>
          <div class="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" @click="rescanSource(s.id)">
              重扫
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-destructive"
              @click="removeSource(s.id)"
            >
              移除
            </Button>
          </div>
        </div>
      </div>
    </template>

    <!-- Users tab -->
    <template v-else>
      <label class="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          :checked="allowRegistration"
          @change="toggleRegistration"
        />
        允许新用户注册
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
              {{ u.role }} · {{ u.enabled ? "启用" : "已禁用" }}
            </p>
          </div>
          <div class="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" @click="resetPassword(u)">
              重置密码
            </Button>
            <Button variant="ghost" size="sm" @click="toggleUser(u)">
              {{ u.enabled ? "禁用" : "启用" }}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="text-destructive"
              @click="removeUser(u)"
            >
              删除
            </Button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
