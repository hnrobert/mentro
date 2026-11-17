<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { computed } from "vue";
import { cn } from "@/lib/utils";

/** Inline status banner (ported from unnc-freshmen-verifier-gateway,
 *  recolored to Mentro's monochrome tokens — destructive red for
 *  errors, muted neutrals for the rest). */
const props = withDefaults(
  defineProps<{
    variant: "error" | "success" | "info";
    message: string;
    class?: HTMLAttributes["class"];
  }>(),
  {},
);

const styles = computed(
  () =>
    ({
      error: "border-destructive/30 bg-destructive/10 text-destructive",
      success:
        "border-primary/25 bg-primary/5 text-foreground [&>strong]:text-foreground",
      info: "border-border bg-muted text-muted-foreground",
    })[props.variant],
);
</script>

<template>
  <div
    :class="
      cn(
        'flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm',
        styles,
        props.class,
      )
    "
    role="status"
  >
    <span class="leading-relaxed">{{ props.message }}</span>
  </div>
</template>
