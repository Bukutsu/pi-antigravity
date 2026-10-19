/**
 * Minimal HTML to Markdown conversion for pages returned by the Antigravity fetch RPCs.
 *
 * The fetch service hands back whole documents rather than clean text: example.com
 * arrives as raw markup and a Wikipedia article as 300 KB of it. A model reading that
 * pays for navigation chrome, inline scripts, and attribute soup, so the tool converts
 * it first. This is deliberately line-oriented replacement instead of a DOM parser:
 * it keeps the extension dependency-free, and the output only has to be readable, not
 * round-trippable.
 */
import { decodeEntityText, decodeHtmlEntities } from "../utils/html.js";

/** Placeholder standing in for an extracted `<pre>` while the rest of the page is rewritten. */
const CODE_SLOT = "\u0000code\u0000";

/** Elements whose contents are never page text. */
const DROPPED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "form",
  "select",
  "option",
  "button",
] as const;

/** Elements that end a block when they close. */
const BLOCK_CLOSERS = [
  "p",
  "div",
  "section",
  "article",
  "aside",
  "main",
  "header",
  "footer",
  "nav",
  "figure",
  "figcaption",
  "ul",
  "ol",
  "dl",
  "dd",
  "dt",
  "table",
  "thead",
  "tbody",
  "blockquote",
  "address",
] as const;

/** Read an attribute from a raw tag, in any of the quoting styles HTML allows. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  const value = match?.[2] ?? match?.[3] ?? match?.[4];
  return value?.trim() ? value.trim() : undefined;
}

/** Drop every remaining tag, keeping the text between them. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

/** Absolute form of a link target when a base URL is known; the raw value otherwise. */
function resolveTarget(target: string, baseUrl?: string): string {
  if (!baseUrl) return target;
  try {
    return new URL(target, baseUrl).toString();
  } catch {
    return target;
  }
}

/**
 * Whether a payload is a full HTML document rather than already-plain text.
 *
 * The fetch RPC returns markup for ordinary pages, but nothing guarantees it: the
 * trawler also serves plain text, JSON, and Markdown, and running the tag stripper
 * over those would eat any `<...>` they legitimately contain.
 */
export function looksLikeHtml(text: string): boolean {
  return /<(?:!doctype|html|head|body|div|p|table|span|article|main)\b/i.test(text.slice(0, 4000));
}

/** Escape the label characters that would end Markdown link or image text early. */
function escapeLabel(text: string): string {
  return text.replace(/[[\]\\]/g, "\\$&");
}

/** Encode the destination characters that would end a Markdown target early. */
function encodeDestination(url: string): string {
  return url.replace(/\)/g, "%29").replace(/ /g, "%20");
}

export type PageMetadata = {
  title?: string;
  description?: string;
};

/** Content of a `<meta>` tag selected by one of its attributes. */
function metaContent(
  html: string,
  attributeName: "property" | "name",
  value: string,
): string | undefined {
  const tag = new RegExp(
    `<meta\\b[^>]*\\b${attributeName}\\s*=\\s*["']${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
    "i",
  ).exec(html)?.[0];
  return tag ? attribute(tag, "content") : undefined;
}

/**
 * Page title and description for the result header.
 *
 * Open graph wins over `<title>`, which on article pages carries a site suffix a
 * reader does not need; `<title>` remains the fallback for pages with no metadata.
 */
export function extractPageMetadata(html: string): PageMetadata {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? html.slice(0, 32 * 1024);
  const rawTitle =
    metaContent(head, "property", "og:title") ??
    metaContent(head, "name", "twitter:title") ??
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const rawDescription =
    metaContent(head, "property", "og:description") ??
    metaContent(head, "name", "description") ??
    metaContent(head, "name", "twitter:description");
  const title = rawTitle ? decodeHtmlEntities(rawTitle) : "";
  const description = rawDescription ? decodeHtmlEntities(rawDescription) : "";
  return { title: title || undefined, description: description || undefined };
}

/** Collapse runs of blank lines and horizontal whitespace outside code blocks. */
function tidy(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

/** Replace every extracted `<pre>` with a fenced block. */
function restoreCodeBlocks(markdown: string, blocks: string[]): string {
  let text = markdown;
  for (const [index, code] of blocks.entries()) {
    const fence = code.includes("```") ? "````" : "```";
    // A function replacement, so `$&` and `$'` inside the code stay literal.
    text = text.replace(
      `${CODE_SLOT}${index}${CODE_SLOT}`,
      () => `\n\n${fence}\n${code}\n${fence}\n\n`,
    );
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export type HtmlToMarkdownOptions = {
  /** Page URL, used to turn relative links and image sources into absolute ones. */
  baseUrl?: string;
};

/**
 * Rewrite an HTML document as Markdown.
 *
 * `<pre>` blocks are pulled out first so that their contents survive untouched, links
 * and images are resolved while their attributes are still visible, and everything
 * else is converted by tag. Unbalanced markup (the common case on real pages) degrades
 * to extra blank lines rather than to lost text.
 */
export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions = {}): string {
  if (!html) return "";
  const { baseUrl } = options;

  let text = html.replace(/<!--[\s\S]*?-->/g, " ");

  const codeBlocks: string[] = [];
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const code = decodeEntityText(stripTags(inner).replace(/^\s+|\s+$/g, ""));
    codeBlocks.push(code);
    return `\n\n${CODE_SLOT}${codeBlocks.length - 1}${CODE_SLOT}\n\n`;
  });

  for (const element of DROPPED_ELEMENTS) {
    text = text
      .replace(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?</${element}>`, "gi"), " ")
      .replace(new RegExp(`<${element}\\b[^>]*/?>`, "gi"), " ");
  }

  // Head metadata is not page text; the caller keeps the title separately.
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");

  text = text.replace(/<img\b[^>]*>/gi, (tag: string) => {
    const source = attribute(tag, "src");
    if (!source || /^data:/i.test(source)) return " ";
    const alt = decodeHtmlEntities(attribute(tag, "alt") ?? "");
    return `![${escapeLabel(alt)}](${encodeDestination(resolveTarget(source, baseUrl))})`;
  });

  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs: string, inner: string) => {
    const href = attribute(attrs, "href");
    const label = decodeHtmlEntities(stripTags(inner));
    if (!href || /^(?:javascript|#)/i.test(href)) return label || " ";
    const safeLabel = escapeLabel(label || href);
    const safeHref = encodeDestination(resolveTarget(href, baseUrl));
    return `[${safeLabel}](${safeHref})`;
  });

  for (let level = 1; level <= 6; level += 1) {
    text = text
      .replace(new RegExp(`<h${level}\\b[^>]*>`, "gi"), `\n\n${"#".repeat(level)} `)
      .replace(new RegExp(`</h${level}>`, "gi"), "\n\n");
  }

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<tr\b[^>]*>/gi, "\n| ")
    .replace(/<\/(?:td|th)>/gi, " | ")
    .replace(/<\/(?:li|tr)>/gi, "\n")
    .replace(/<blockquote\b[^>]*>/gi, "\n\n> ")
    .replace(/<(?:strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/(?:strong|b)>/gi, "**")
    .replace(/<(?:em|i)\b[^>]*>/gi, "*")
    .replace(/<\/(?:em|i)>/gi, "*")
    .replace(/<(?:del|s|strike)\b[^>]*>/gi, "~~")
    .replace(/<\/(?:del|s|strike)>/gi, "~~")
    .replace(/<code\b[^>]*>/gi, "`")
    .replace(/<\/code>/gi, "`");

  for (const element of BLOCK_CLOSERS) {
    text = text.replace(new RegExp(`</${element}>`, "gi"), "\n\n");
  }

  text = decodeEntityText(stripTags(text));

  return restoreCodeBlocks(tidy(text), codeBlocks);
}
