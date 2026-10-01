<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useCartStore } from "@/stores/cart";
import { api } from "@/api/client";
import UploadModal from "@/components/UploadModal.vue";
import CartModal from "@/components/CartModal.vue";
import {
  Library,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  ShoppingCart,
  Upload,
  X,
} from "lucide-vue-next";

const auth = useAuthStore();
const cart = useCartStore();
const router = useRouter();
const route = useRoute();

const totalCount = ref<number | null>(null);

const isAdmin = computed(() => auth.user?.role === "super_admin");
const showSidebar = computed(() => route.name !== "login");

const uploadOpen = ref(false);
const cartOpen = ref(false);

// --- sidebar geometry / state ---
// Desktop (lg+): inline flow, drag-resizable, collapsible to an icon
// rail. Below lg: fixed overlay drawer behind a hamburger button.
const LG_QUERY = "(min-width: 1024px)"; // tailwind lg breakpoint
const isLg = ref(window.matchMedia(LG_QUERY).matches);
let lgMq: MediaQueryList | null = null;
const onLgChange = (): void => {
  isLg.value = lgMq?.matches ?? false;
};

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 208; // w-52
const resizingSidebar = ref(false);
const sidebarCollapsed = ref(
  localStorage.getItem("mentro:sidebar-collapsed") === "1",
);
const mobileNavOpen = ref(false);
/** Icon-rail mode: only meaningful on lg+ screens. */
const collapsedRail = computed(() => isLg.value && sidebarCollapsed.value);
const sidebarWidth = ref(
  ((): number => {
    const stored = Number(localStorage.getItem("mentro:sidebar-w"));
    return Number.isFinite(stored) &&
      stored >= SIDEBAR_MIN &&
      stored <= SIDEBAR_MAX
      ? stored
      : SIDEBAR_DEFAULT;
  })(),
);

function startSidebarResize(ev: MouseEvent): void {
  ev.preventDefault();
  resizingSidebar.value = true;
  const move = (e: MouseEvent): void => {
    sidebarWidth.value = Math.min(
      SIDEBAR_MAX,
      Math.max(SIDEBAR_MIN, Math.round(e.clientX)),
    );
  };
  const up = (): void => {
    resizingSidebar.value = false;
    localStorage.setItem("mentro:sidebar-w", String(sidebarWidth.value));
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem(
    "mentro:sidebar-collapsed",
    sidebarCollapsed.value ? "1" : "0",
  );
}

async function refreshCount(): Promise<void> {
  try {
    const res = await api<{ total: number }>("/api/library?pageSize=1");
    totalCount.value = res.total;
  } catch {
    totalCount.value = null;
  }
}

function nav(name: string): void {
  mobileNavOpen.value = false;
  router.push({ name });
}

function signOut(): void {
  import("@/api/client").then(({ logout }) => {
    void logout();
  });
  auth.setUser(null);
  router.push({ name: "login" });
}

onMounted(() => {
  lgMq = window.matchMedia(LG_QUERY);
  isLg.value = lgMq.matches;
  lgMq.addEventListener("change", onLgChange);
  void auth.restore();
  window.addEventListener("mentro:unauthorized", () => {
    auth.setUser(null);
    router.push({ name: "login" });
  });
  void refreshCount();
});

onUnmounted(() => {
  lgMq?.removeEventListener("change", onLgChange);
});
</script>

<template>
  <div
    class="flex h-screen overflow-hidden"
    :class="{ 'select-none': resizingSidebar }"
  >
    <!-- Backdrop for the mobile drawer -->
    <div
      v-if="showSidebar && mobileNavOpen"
      class="fixed inset-0 z-40 bg-black/40 lg:hidden"
      @click="mobileNavOpen = false"
    />

    <!-- Sidebar: overlay drawer below lg, resizable/collapsible at lg+ -->
    <aside
      v-if="showSidebar"
      class="fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r bg-muted/30 shadow-xl transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 lg:shadow-none"
      :class="mobileNavOpen ? 'translate-x-0' : '-translate-x-full'"
      :style="
        isLg ? { width: `${collapsedRail ? 56 : sidebarWidth}px` } : undefined
      "
    >
      <!-- Width drag handle (lg+, expanded only): straddles the border -->
      <div
        v-if="!collapsedRail"
        class="absolute -right-1 top-0 z-40 hidden h-full w-2 cursor-col-resize select-none hover:bg-foreground/20 active:bg-foreground/30 lg:block"
        title="Drag to resize"
        @mousedown="startSidebarResize"
      />

      <!-- Wordmark -> search home; collapse toggle on lg+ -->
      <div
        class="flex items-center gap-1 px-3 pb-2 pt-4"
        :class="collapsedRail ? 'justify-center px-0' : 'justify-between'"
      >
        <button
          v-if="!collapsedRail"
          class="rounded px-1.5 py-0.5 text-lg font-semibold tracking-tight transition-colors hover:bg-accent"
          title="Back to search"
          @click="nav('search')"
        >
          Mentro
        </button>
        <button
          class="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          :title="collapsedRail ? 'Expand sidebar' : 'Collapse sidebar'"
          @click="isLg ? toggleSidebar() : (mobileNavOpen = false)"
        >
          <PanelLeftOpen v-if="collapsedRail" class="h-4 w-4" />
          <PanelLeftClose v-else-if="isLg" class="h-4 w-4" />
          <X v-else class="h-4 w-4" />
        </button>
      </div>

      <nav
        class="flex flex-1 flex-col gap-0.5 px-2"
        :class="collapsedRail ? 'px-1.5' : ''"
      >
        <button
          class="flex items-center rounded py-2 text-sm transition-colors hover:bg-accent"
          :class="[
            route.name === 'search' ? 'bg-accent font-medium' : '',
            collapsedRail ? 'justify-center' : 'gap-2.5 px-3',
          ]"
          :title="collapsedRail ? 'Search' : undefined"
          @click="nav('search')"
        >
          <Search class="h-4 w-4 shrink-0" />
          <span v-if="!collapsedRail">Search</span>
        </button>
        <button
          class="flex items-center rounded py-2 text-sm transition-colors hover:bg-accent"
          :class="[
            route.name === 'library' ? 'bg-accent font-medium' : '',
            collapsedRail ? 'justify-center' : 'gap-2.5 px-3',
          ]"
          :title="collapsedRail ? 'Library' : undefined"
          @click="nav('library')"
        >
          <Library class="h-4 w-4 shrink-0" />
          <span v-if="!collapsedRail">
            Library
            <span
              v-if="totalCount !== null"
              class="ml-1 text-xs text-muted-foreground"
            >
              {{ totalCount }}
            </span>
          </span>
        </button>
        <button
          v-if="isAdmin"
          class="flex items-center rounded py-2 text-sm transition-colors hover:bg-accent"
          :class="[
            route.name?.toString().startsWith('settings')
              ? 'bg-accent font-medium'
              : '',
            collapsedRail ? 'justify-center' : 'gap-2.5 px-3',
          ]"
          :title="collapsedRail ? 'Settings' : undefined"
          @click="nav('settings-sources')"
        >
          <Settings class="h-4 w-4 shrink-0" />
          <span v-if="!collapsedRail">Settings</span>
        </button>
      </nav>

      <div class="border-t p-3" :class="collapsedRail ? 'px-2' : ''">
        <div class="mb-2 flex gap-2" :class="collapsedRail ? 'flex-col' : ''">
          <button
            class="flex items-center justify-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
            :class="collapsedRail ? '' : 'flex-1'"
            :title="collapsedRail ? 'Upload' : undefined"
            @click="uploadOpen = true"
          >
            <Upload class="h-4 w-4" />
            <span v-if="!collapsedRail" class="flex-1 text-left">Upload</span>
          </button>
          <button
            class="relative flex items-center justify-center rounded-md border border-input bg-background px-3 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
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
          v-if="auth.user && !collapsedRail"
          class="mt-3 flex items-center justify-between px-1 text-xs text-muted-foreground"
        >
          <span class="truncate">{{ auth.user.username }}</span>
          <button class="text-destructive hover:underline" @click="signOut">
            Sign Out
          </button>
        </div>
      </div>
    </aside>

    <!-- Main. The mobile top bar (hamburger) lives inside main so views
         that manage their own height (Library, h-full) are unaffected
         beyond the wrapper. -->
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div
        v-if="showSidebar"
        class="flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2 lg:hidden"
      >
        <button
          class="rounded p-1.5 transition-colors hover:bg-accent"
          aria-label="Open menu"
          @click="mobileNavOpen = true"
        >
          <Menu class="h-5 w-5" />
        </button>
        <button
          class="rounded px-1.5 py-0.5 text-base font-semibold tracking-tight transition-colors hover:bg-accent"
          @click="nav('search')"
        >
          Mentro
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <RouterView @library-changed="refreshCount" />
      </div>
    </main>

    <UploadModal
      v-if="uploadOpen"
      @close="uploadOpen = false"
      @uploaded="refreshCount"
    />

    <CartModal v-if="cartOpen" @close="cartOpen = false" />
  </div>
</template>
