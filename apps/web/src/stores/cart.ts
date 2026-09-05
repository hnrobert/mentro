import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

/**
 * Page-selection cart: collect pages/slides across files, then export
 * them in one click (per-file crop keeps each deck's theme; multiple
 * files arrive as one zip). Persisted in localStorage.
 */

export interface CartItem {
  unitId: string;
  assetId: string;
  ordinal: number;
  unitType: string;
  title: string | null;
  fileName: string;
}

const STORE_KEY = "mentro.cart";

function load(): CartItem[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as CartItem[]) : [];
  } catch {
    return [];
  }
}

export const useCartStore = defineStore("cart", () => {
  const items = ref<CartItem[]>(load());

  watch(
    items,
    (next) => localStorage.setItem(STORE_KEY, JSON.stringify(next)),
    { deep: true },
  );

  const count = computed(() => items.value.length);

  /** assetId -> items, insertion order preserved. */
  const byAsset = computed(() => {
    const map = new Map<string, CartItem[]>();
    for (const it of items.value) {
      const list = map.get(it.assetId) ?? [];
      list.push(it);
      map.set(it.assetId, list);
    }
    return map;
  });

  function has(unitId: string): boolean {
    return items.value.some((i) => i.unitId === unitId);
  }

  function toggle(item: CartItem): void {
    if (has(item.unitId)) {
      remove(item.unitId);
    } else {
      items.value.push(item);
    }
  }

  function addMany(list: CartItem[]): void {
    for (const item of list) {
      if (!has(item.unitId)) items.value.push(item);
    }
  }

  function remove(unitId: string): void {
    items.value = items.value.filter((i) => i.unitId !== unitId);
  }

  function removeAsset(assetId: string): void {
    items.value = items.value.filter((i) => i.assetId !== assetId);
  }

  function clear(): void {
    items.value = [];
  }

  return {
    items,
    count,
    byAsset,
    has,
    toggle,
    addMany,
    remove,
    removeAsset,
    clear,
  };
});
