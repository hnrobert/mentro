<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import Button from "@/components/ui/Button.vue";
import Card from "@/components/ui/Card.vue";
import Input from "@/components/ui/Input.vue";
import Label from "@/components/ui/Label.vue";
import { ApiError, login, register } from "@/api/client";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();

const mode = ref<"login" | "register">("login");
const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    const res =
      mode.value === "login"
        ? await login(username.value, password.value)
        : await register(username.value, password.value);
    auth.setUser(res.user);
    router.push({ name: "search" });
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="flex min-h-screen items-center justify-center p-4">
    <Card class="w-full max-w-sm p-6">
      <h1 class="mb-1 text-xl font-semibold tracking-tight">Mentro</h1>
      <p class="mb-5 text-sm text-muted-foreground">
        自部署的素材索引与检索服务
      </p>

      <div class="mb-4 flex rounded-md border p-0.5 text-sm">
        <button
          class="flex-1 rounded px-3 py-1.5 transition-colors"
          :class="mode === 'login' ? 'bg-primary text-primary-foreground' : ''"
          @click="mode = 'login'"
        >
          登录
        </button>
        <button
          class="flex-1 rounded px-3 py-1.5 transition-colors"
          :class="
            mode === 'register' ? 'bg-primary text-primary-foreground' : ''
          "
          @click="mode = 'register'"
        >
          注册
        </button>
      </div>

      <form class="flex flex-col gap-3" @submit.prevent="submit">
        <div class="flex flex-col gap-1.5">
          <Label for="username">用户名</Label>
          <Input
            id="username"
            v-model="username"
            autocomplete="username"
            placeholder="[A-Za-z0-9_-]{3,32}"
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="password">密码</Label>
          <Input
            id="password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="≥ 8 位"
          />
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <Button type="submit" :disabled="busy || !username || !password">
          {{ mode === "login" ? "登录" : "注册并登录" }}
        </Button>
      </form>

      <p class="mt-4 text-xs text-muted-foreground">
        首位注册者将成为超级管理员；注册开关由管理员在设置中控制。
      </p>
    </Card>
  </main>
</template>
