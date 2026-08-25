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
  ],
});

router.beforeEach((to) => {
  if (to.name !== "login" && !loadAuth()) return { name: "login" };
  return true;
});

export default router;
