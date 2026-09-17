import { createRouter, createWebHistory } from "vue-router";
import { loadAuth } from "@/api/client";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/login",
      name: "login",
      component: () => import("@/views/LoginView.vue"),
    },
    {
      path: "/",
      name: "search",
      component: () => import("@/views/SearchView.vue"),
    },
    {
      path: "/library",
      name: "library",
      component: () => import("@/views/LibraryView.vue"),
    },
    {
      path: "/library/:id",
      name: "asset-detail",
      component: () => import("@/views/AssetDetailView.vue"),
    },
    {
      path: "/settings/sources",
      name: "settings-sources",
      component: () => import("@/views/SettingsView.vue"),
    },
    {
      path: "/settings/users",
      name: "settings-users",
      component: () => import("@/views/SettingsView.vue"),
    },
    {
      path: "/settings/groups",
      name: "settings-groups",
      component: () => import("@/views/SettingsView.vue"),
    },
  ],
});

router.beforeEach((to) => {
  if (to.name !== "login" && !loadAuth()) return { name: "login" };
  return true;
});

export default router;
