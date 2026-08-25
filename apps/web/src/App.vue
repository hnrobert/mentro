<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const router = useRouter();

onMounted(() => {
  void auth.restore();
  window.addEventListener("mentro:unauthorized", () => {
    auth.setUser(null);
    router.push({ name: "login" });
  });
});
</script>

<template>
  <RouterView />
</template>
