<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useCartStore } from "@/stores/cart";
import { api } from "@/api/client";
import UploadModal from "@/components/UploadModal.vue";
import CartModal from "@/components/CartModal.vue";
import { ShoppingCart } from "lucide-vue-next";

const auth = useAuthStore();
const cart = useCartStore();
const router = useRouter();
const route = useRoute();

const totalCount = ref<number | null>(null);

const isAdmin = computed(() => auth.user?.role === "super_admin");
const showSidebar = computed(() => route.name !== "login");

const uploadOpen = ref(false);
const cartOpen = ref(false);

async function refreshCount(): Promise<void> {
  try {
    const res = await api<{ total: number }>("/api/library?pageSize=1");
    totalCount.value = res.total;
  } catch {
    totalCount.value = null;
  }
}

function nav(name: string): void {
  router.push({ name });
}

onMounted(() => {
  void auth.restore();
  window.addEventListener("mentro:unauthorized", () => {
    auth.setUser(null);
    router.push({ name: "login" });
  });
  void refreshCount();
});
</script>

<template>
  <div class="flex h-screen overflow-hidden">
    <!-- Sidebar -->
    <aside
      v-if="showSidebar"
      class="flex w-52 shrink-0 flex-col border-r bg-muted/30"
    >
      <div class="px-4 pb-2 pt-5">
        <span class="text-lg font-semibold tracking-tight">Mentro</span>
      </div>
      <nav class="flex flex-1 flex-col gap-0.5 px-2">
        <button
          class="rounded px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
          :class="route.name === 'search' ? 'bg-accent font-medium' : ''"
          @click="nav('search')"
        >
          Search
        </button>
        <button
          class="rounded px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
          :class="route.name === 'library' ? 'bg-accent font-medium' : ''"
          @click="nav('library')"
        >
          Library
          <span
            v-if="totalCount !== null"
            class="ml-1 text-xs text-muted-foreground"
          >
            {{ totalCount }}
          </span>
        </button>
        <button
          v-if="isAdmin"
          class="rounded px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
          :class="
            route.name?.toString().startsWith('settings')
              ? 'bg-accent font-medium'
              : ''
          "
          @click="nav('settings-sources')"
        >
          Settings
        </button>
      </nav>
      <div class="border-t p-3">
        <div class="mb-2 flex gap-2">
          <button
            class="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
            @click="uploadOpen = true"
          >
            Upload
          </button>
          <button
            class="relative rounded-md border border-input bg-background px-3 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
            title="Selected pages"
            @click="cartOpen = true"
          >
            <ShoppingCart class="h-4 w-4" />
            <span
              v-if="cart.count > 0"
              class="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground"
            >
              {{ cart.count }}
            </span>
          </button>
        </div>
        <div
          v-if="auth.user"
          class="mt-3 flex items-center justify-between px-1 text-xs text-muted-foreground"
        >
          <span class="truncate">{{ auth.user.username }}</span>
          <button
            class="text-destructive hover:underline"
            @click="
              () => {
                import('@/api/client').then(({ logout }) => {
                  void logout();
                });
                auth.setUser(null);
                router.push({ name: 'login' });
              }
            "
          >
            Sign Out
          </button>
        </div>
      </div>
    </aside>

    <!-- Main: page-level vertical scroll. Views that manage their own
         height (Library) fill h-full and never overflow this. -->
    <main class="min-w-0 flex-1 overflow-y-auto">
      <RouterView @library-changed="refreshCount" />
    </main>

    <UploadModal
      v-if="uploadOpen"
      @close="uploadOpen = false"
      @uploaded="refreshCount"
    />

    <CartModal v-if="cartOpen" @close="cartOpen = false" />
  </div>
</template>
