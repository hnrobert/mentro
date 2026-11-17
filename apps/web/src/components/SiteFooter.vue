<script setup lang="ts">
import { Moon, Sun } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useColorMode } from "@vueuse/core";

/** Footer with theme + language switches (adapted from
 *  unnc-freshmen-verifier-gateway's SiteFooter; switches live here
 *  instead of crowding the sidebar). */
const { t, locale } = useI18n();
const mode = useColorMode({ storageKey: "mentro.theme" });

function toggleLocale(): void {
  const next = locale.value === "zh" ? "en" : "zh";
  locale.value = next;
  localStorage.setItem("mentro.lang", next);
}
</script>

<template>
  <footer
    class="mt-auto flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground"
  >
    <span>© {{ new Date().getFullYear() }} Mentro</span>
    <span class="flex items-center gap-1">
      <button
        class="rounded-md border p-1.5 transition-colors hover:bg-accent hover:text-foreground"
        :aria-label="t('theme.toggle')"
        :title="t('theme.toggle')"
        @click="mode = mode === 'dark' ? 'light' : 'dark'"
      >
        <Sun v-if="mode === 'dark'" class="size-3.5" />
        <Moon v-else class="size-3.5" />
      </button>
      <button
        class="rounded-md border px-2 py-1 font-medium transition-colors hover:bg-accent hover:text-foreground"
        :aria-label="t('lang.toggle')"
        :title="t('lang.toggle')"
        @click="toggleLocale"
      >
        {{ locale === "zh" ? "EN" : "中" }}
      </button>
    </span>
  </footer>
</template>
