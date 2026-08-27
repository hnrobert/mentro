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
        Self-hosted knowledge base
      </p>

      <div class="mb-4 flex rounded-md border p-0.5 text-sm">
        <button
          class="flex-1 rounded px-3 py-1.5 transition-colors"
          :class="mode === 'login' ? 'bg-primary text-primary-foreground' : ''"
          @click="mode = 'login'"
        >
          Sign In
        </button>
        <button
          class="flex-1 rounded px-3 py-1.5 transition-colors"
          :class="
            mode === 'register' ? 'bg-primary text-primary-foreground' : ''
          "
          @click="mode = 'register'"
        >
          Register
        </button>
      </div>

      <form class="flex flex-col gap-3" @submit.prevent="submit">
        <div class="flex flex-col gap-1.5">
          <Label for="username">Username</Label>
          <Input id="username" v-model="username" autocomplete="username" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="password">Password</Label>
          <Input
            id="password"
            v-model="password"
            type="password"
            autocomplete="current-password"
          />
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <Button type="submit" :disabled="busy || !username || !password">
          {{ mode === "login" ? "Sign In" : "Register & Sign In" }}
        </Button>
      </form>

      <p class="mt-4 text-xs text-muted-foreground">
        The first registered user becomes the super admin; registration is
        controlled by the admin in Settings.
      </p>
    </Card>
  </main>
</template>
