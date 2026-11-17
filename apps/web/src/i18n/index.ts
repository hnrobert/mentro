import { createI18n } from "vue-i18n";
import en from "./locales/en";
import zh from "./locales/zh";

/** Main-chrome strings only for now (sidebar / search / settings tabs /
 *  detail headers / common verbs). Long-tail strings (permission
 *  dialog, AI card, translation settings detail) stay English until a
 *  follow-up pass. */
const stored = localStorage.getItem("mentro.lang");

export const i18n = createI18n({
  legacy: false,
  locale: stored === "en" || stored === "zh" ? stored : "zh",
  fallbackLocale: "en",
  messages: { en, zh },
});
