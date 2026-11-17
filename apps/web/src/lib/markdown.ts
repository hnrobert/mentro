/**
 * Markdown rendering for the welcome body.
 *
 *  - Raw HTML is disabled (escaped), so user-authored content is safe to bind
 *    via `v-html` in a static bundle.
 *  - Bare URLs and emails are auto-linked by a source preprocessor that wraps
 *    them in markdown-it"s native (TLD-agnostic) autolink syntax. We avoid
 *    linkify-it here because its bundled TLD whitelist is stale and misses
 *    modern gTLDs (`.dev`, `.app`, `.email`, …). Code spans, fenced code, and
 *    existing links/autolinks are protected so they are never modified.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: true,
  typographer: false,
});

const PLACEHOLDER = "\u200b";

/** Strip trailing punctuation that should not be part of a link. */
function stripTrailing(s: string): string {
  return s.replace(/[.,;:!?]+$/, "");
}

/** Wrap bare URLs/emails in autolink syntax while protecting code & links. */
function autolinkSource(src: string): string {
  const stash: string[] = [];
  const hide = (m: string): string =>
    PLACEHOLDER + (stash.push(m) - 1) + PLACEHOLDER;
  const restore = (s: string): string =>
    s.replace(/\u200b(\d+)\u200b/g, (_m, i) => stash[Number(i)] ?? "");

  let s = src;
  // Protect regions that must not be autolinked.
  s = s.replace(/`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}/g, hide); // fenced code
  s = s.replace(/`[^`\n]+`/g, hide); // inline code
  s = s.replace(/<[^\s<>]+>/g, hide); // existing autolinks / inline HTML
  s = s.replace(/\]\([^)]*\)/g, hide); // inline link destinations: [..](..)

  // URLs (explicit scheme or leading www.) -> explicit markdown link, so the
  // `www.` form also resolves with an http:// href.
  s = s.replace(
    /(?<![=@\w/"'(])(https?:\/\/[^\s<>"')\]]+|www\.[^\s<>"')\]]+)/gi,
    (m) => {
      const text = stripTrailing(m);
      const href = /^www\./i.test(text) ? `http://${text}` : text;
      return hide(`[${text}](${href})`);
    },
  );
  // Emails -> angle-bracket autolink (TLD-agnostic in markdown-it).
  s = s.replace(
    /(?<![=@\w/"'(])([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g,
    (m) => hide(`<${stripTrailing(m)}>`),
  );

  return restore(s);
}

// Open every rendered link (auto or authored) in a new tab, safely.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) =>
    self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  const href = token?.attrGet("href") ?? "";
  if (typeof href === "string" && /^(https?|mailto|tel):/i.test(href)) {
    token?.attrSet("target", "_blank");
    token?.attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, idx, options, _env, self);
};

/** Render a markdown source string to sanitized HTML. */
export function renderMarkdown(source: string): string {
  return md.render(autolinkSource(source ?? ""));
}
