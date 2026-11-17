import type { RouteLocationNormalized } from "vue-router";
import { computed } from "vue";
import { useRoute } from "vue-router";

export interface BreadcrumbItem {
  label: string;
  /** Internal route (rendered as RouterLink). Omit for the current page. */
  to?: string;
}

const SETTINGS_LABELS: Record<string, string> = {
  sources: "Sources",
  users: "Users",
  groups: "Groups",
  translation: "Translation",
};

function buildTrail(route: RouteLocationNormalized): BreadcrumbItem[] {
  const settings: BreadcrumbItem = {
    label: "Settings",
    to: "/settings/sources",
  };
  const library: BreadcrumbItem = { label: "Library", to: "/library" };

  if (route.path === "/library") return [library];
  // Asset detail: /library/:id — label supplied by the page via meta.
  if (route.name === "asset-detail") {
    return [
      library,
      { label: String(route.meta.breadcrumb ?? route.params.id) },
    ];
  }
  if (route.path.startsWith("/settings/")) {
    const tab =
      SETTINGS_LABELS[String(route.name).replace("settings-", "")] ??
      "Settings";
    return [settings, { label: tab }];
  }
  return [];
}

/** Route-derived breadcrumb trail; empty on the search home (no
 *  hierarchy to show there). */
export function useBreadcrumbs() {
  const route = useRoute();
  return computed(() => buildTrail(route));
}
