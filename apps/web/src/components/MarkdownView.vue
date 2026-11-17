<script setup lang="ts">
/**
 * Renders markdown source into sanitized HTML with auto-linked URLs/emails.
 * Raw HTML in the source is escaped (markdown-it `html: false`), so it is
 * safe to bind via `v-html` (ported from unnc-freshmen-verifier-gateway).
 */
import { computed } from "vue";
import { renderMarkdown } from "@/lib/markdown";

const props = defineProps<{ source: string }>();
const html = computed(() => renderMarkdown(props.source));
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- source is escaped by markdown-it (html: false) -->
  <div class="mentro-prose text-sm leading-relaxed" v-html="html"></div>
</template>

<style scoped>
.mentro-prose :deep(p) {
  margin: 0.375rem 0;
}
.mentro-prose :deep(ul),
.mentro-prose :deep(ol) {
  margin: 0.375rem 0;
  padding-left: 1.25rem;
  list-style: disc;
}
.mentro-prose :deep(ol) {
  list-style: decimal;
}
.mentro-prose :deep(li) {
  margin: 0.125rem 0;
}
.mentro-prose :deep(strong) {
  font-weight: 600;
}
.mentro-prose :deep(h1),
.mentro-prose :deep(h2),
.mentro-prose :deep(h3) {
  margin: 0.625rem 0 0.25rem;
  font-weight: 600;
  font-size: inherit;
}
.mentro-prose :deep(a) {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.mentro-prose :deep(code) {
  border-radius: 0.25rem;
  background: color-mix(in oklab, var(--muted) 80%, transparent);
  padding: 0.1rem 0.3rem;
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
}
.mentro-prose :deep(pre) {
  overflow-x: auto;
  border-radius: 0.5rem;
  background: var(--muted);
  padding: 0.75rem;
}
.mentro-prose :deep(pre code) {
  background: transparent;
  padding: 0;
}
</style>
