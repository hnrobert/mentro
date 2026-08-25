import { defineStore } from "pinia";
import { ref } from "vue";
import { api, clearAuth, loadAuth } from "@/api/client";

export interface Me {
  id: string;
  username: string;
  role: string;
  enabled: boolean;
}

export const useAuthStore = defineStore("auth", () => {
  const user = ref<Me | null>(null);
  const ready = ref(false);

  async function restore(): Promise<void> {
    if (!loadAuth()) {
      ready.value = true;
      return;
    }
    try {
      const res = await api<{ user: Me | null }>("/api/auth/me");
      user.value = res.user;
    } catch {
      user.value = null;
    }
    ready.value = true;
  }

  function setUser(me: Me | null): void {
    user.value = me;
    if (!me) clearAuth();
  }

  return { user, ready, restore, setUser };
});
