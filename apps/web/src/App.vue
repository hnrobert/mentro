<script setup lang="ts">
import { onMounted, ref } from "vue";

const status = ref<string>("connecting…");

onMounted(async () => {
  try {
    const res = await fetch("/api/status");
    const body = (await res.json()) as { status: string };
    status.value = `server ${body.status}`;
  } catch {
    status.value = "server unreachable";
  }
});
</script>

<template>
  <main class="flex min-h-screen flex-col items-center justify-center gap-4">
    <h1 class="text-4xl font-bold tracking-tight">Mentro</h1>
    <p class="text-sm text-neutral-500">{{ status }}</p>
  </main>
</template>
