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

/** Placeholder standing in for an extracted table or `<pre>` while the rest of the page is rewritten. */
const BLOCK_SLOT = "\u0000block\u0000";

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

/** Elements that are site chrome rather than the page's own content. */
const BOILERPLATE_ELEMENTS = ["nav", "aside", "footer"] as const;

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
 * Slice a document down to its `<main>` (or `<article>`) content when it has one.
 *
 * That is where publishers put the page itself; everything before and after it is
 * masthead, menus, and footers. The crawler's copy can stop mid-page, so a document
 * without the matching close tag keeps everything from the opening tag on, which is
 * still better than site chrome.
 */
function selectContentRegion(html: string): string {
  for (const tag of ["main", "article"]) {
    const open = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(html);
    if (!open || open.index === undefined) continue;
    const from = open.index + open[0].length;
    const close = html.toLowerCase().lastIndexOf(`</${tag}>`);
    return close > from ? html.slice(from, close) : html.slice(from);
  }
  return html;
}

/**
 * Remove every `<tag>` subtree, nested ones included.
 *
 * A plain non-greedy regex would stop at the first close tag, which for nested
 * landmarks (a `<nav>` inside a `<nav>`) leaves the rest of the outer one behind.
 */
function dropElement(html: string, tag: string): string {
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  let text = "";
  let cursor = 0;
  let start = -1;
  let depth = 0;
  for (const match of html.matchAll(pattern)) {
    if (match[1] !== "/") {
      if (/\/>$/.test(match[0])) continue;
      if (depth === 0) start = match.index;
      depth += 1;
      continue;
    }
    if (depth === 0) continue;
    depth -= 1;
    if (depth === 0) {
      text += `${html.slice(cursor, start)} `;
      cursor = match.index + match[0].length;
    }
  }
  if (depth > 0) {
    // A copy that ends mid-element implicitly closes it.
    text += `${html.slice(cursor, start)} `;
    cursor = html.length;
  }
  return text + html.slice(cursor);
}

/** Remove whole subtrees of the given elements. */
function dropElements(html: string, elements: readonly string[]): string {
  let text = html;
  for (const element of elements) text = dropElement(text, element);
  return text;
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

/** One `<img>` element as Markdown, or a space when there is nothing usable. */
function imageToMarkdown(tag: string, baseUrl?: string): string {
  const source = attribute(tag, "src");
  if (!source || /^data:/i.test(source)) return " ";
  const alt = decodeHtmlEntities(attribute(tag, "alt") ?? "");
  return `![${escapeLabel(alt)}](${encodeDestination(resolveTarget(source, baseUrl))})`;
}

/**
 * One `<a>` element as Markdown.
 *
 * A link that only wraps an image stays an image, and a link whose label is its own
 * URL keeps just the URL, both of which read better than the nested or repeated form.
 */
function anchorToMarkdown(attrs: string, inner: string, baseUrl?: string): string {
  // The image pass runs first, so an image-only link arrives as Markdown already.
  if (/^\s*!\[[\s\S]*?\]\([^)]*\)\s*$/.test(inner)) return inner.trim();
  const href = attribute(attrs, "href");
  const label = decodeHtmlEntities(stripTags(inner));
  if (!href || /^(?:javascript|#)/i.test(href)) return label || " ";
  const target = encodeDestination(resolveTarget(href, baseUrl));
  // Not `<target>`: the surrounding pass strips anything that looks like a tag.
  if (!label || label === href || label === target) return target;
  return `[${escapeLabel(label)}](${target})`;
}

/** One table cell as inline Markdown on a single line, with pipes escaped. */
function cellText(html: string, baseUrl?: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<img\b[^>]*>/gi, (tag: string) => imageToMarkdown(tag, baseUrl))
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs: string, inner: string) =>
      anchorToMarkdown(attrs, inner, baseUrl),
    )
    .replace(/<(?:code|kbd|samp)\b[^>]*>/gi, "`")
    .replace(/<\/(?:code|kbd|samp)>/gi, "`")
    .replace(/<(?:strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/(?:strong|b)>/gi, "**")
    .replace(/<(?:em|i)\b[^>]*>/gi, "*")
    .replace(/<\/(?:em|i)>/gi, "*");
  return decodeEntityText(stripTags(text)).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

/**
 * One `<table>` as a Markdown table.
 *
 * A first row of `<th>` cells becomes the header, as registry and documentation tables
 * already write it; a table whose labels start further down (an infobox, say) gets an
 * empty header row instead of promoting a data row. Empty rows are dropped and short
 * rows padded, so the pipes line up for a reader.
 */
function tableToMarkdown(html: string, baseUrl?: string): string {
  const rows: Array<{ cells: string[]; header: boolean }> = [];
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map((cell) =>
      cellText(cell.replace(/^<t[dh]\b[^>]*>/i, "").replace(/<\/t[dh]>$/i, ""), baseUrl),
    );
    if (cells.some((cell) => cell !== "")) rows.push({ cells, header: /<th\b/i.test(row) });
  }
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.cells.length));
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_cell, index) => cells[index] ?? "").join(" | ")} |`;
  const useFirstRow = rows[0].header || !rows.some((row) => row.header);
  const header = useFirstRow ? rows[0].cells : Array.from({ length: width }, () => "");
  const body = useFirstRow ? rows.slice(1).map((row) => row.cells) : rows.map((row) => row.cells);
  const caption = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(html)?.[1];
  const captionText = caption ? cellText(caption, baseUrl) : "";
  const lines = [line(header), line(Array.from({ length: width }, () => "---")), ...body.map(line)];
  return `\n\n${captionText ? `${captionText}\n\n` : ""}${lines.join("\n")}\n\n`;
}

export type PageMetadata = {
  title?: string;
  description?: string;
  /** Date the page says it was last modified, exactly as the page states it. */
  updated?: string;
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
 * Page title, description, and update date for the result header.
 *
 * Open graph wins over `<title>`, which on article pages carries a site suffix a
 * reader does not need; `<title>` remains the fallback for pages with no metadata.
 * Only dates a page states as its own modification are reported: guessing one from
 * other dates would be wrong often enough to mislead.
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
  const rawUpdated =
    metaContent(head, "property", "article:modified_time") ??
    metaContent(head, "property", "og:updated_time") ??
    metaContent(head, "name", "last-modified") ??
    metaContent(head, "name", "lastmod");
  const title = rawTitle ? decodeHtmlEntities(rawTitle).trim() : "";
  const description = rawDescription ? decodeHtmlEntities(rawDescription).trim() : "";
  const updated = rawUpdated ? decodeHtmlEntities(rawUpdated).trim() : "";
  return {
    title: title || undefined,
    description: description || undefined,
    updated: updated || undefined,
  };
}

/** Collapse runs of blank lines and horizontal whitespace outside code blocks. */
function tidy(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ""))
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

/** Replace every extracted block slot with its finished Markdown. */
function restoreBlocks(markdown: string, blocks: string[]): string {
  let text = markdown;
  for (const [index, block] of blocks.entries()) {
    // A function replacement, so `$&` and `$'` inside the block stay literal.
    text = text.replace(`${BLOCK_SLOT}${index}${BLOCK_SLOT}`, () => block);
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

  // Scripting and site chrome go first, then everything outside the page's own content.
  text = selectContentRegion(dropElements(text, DROPPED_ELEMENTS));
  text = dropElements(text, BOILERPLATE_ELEMENTS);

  // Head metadata is not page text; the caller keeps the title separately.
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");

  // Tables and `<pre>` blocks are lifted out whole: their shape is the point, and the
  // per-tag pass below would flatten it.
  const blocks: string[] = [];
  const keepBlock = (markdown: string): string => {
    blocks.push(markdown);
    return `${BLOCK_SLOT}${blocks.length - 1}${BLOCK_SLOT}`;
  };

  text = text.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table: string) => {
    const markdown = tableToMarkdown(table, baseUrl);
    return markdown ? keepBlock(markdown) : " ";
  });

  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const code = decodeEntityText(stripTags(inner).replace(/^\s+|\s+$/g, ""));
    const fence = code.includes("```") ? "````" : "```";
    return keepBlock(`\n\n${fence}\n${code}\n${fence}\n\n`);
  });

  text = text.replace(/<img\b[^>]*>/gi, (tag: string) => imageToMarkdown(tag, baseUrl));

  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs: string, inner: string) =>
    anchorToMarkdown(attrs, inner, baseUrl),
  );

  for (let level = 1; level <= 6; level += 1) {
    text = text
      .replace(new RegExp(`<h${level}\\b[^>]*>`, "gi"), `\n\n${"#".repeat(level)} `)
      .replace(new RegExp(`</h${level}>`, "gi"), "\n\n");
  }

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n")
    // Whitespace around list-item tags would otherwise leave a blank line per item.
    .replace(/<\/li>\s*(?=<li\b)/gi, "")
    .replace(/\s*<li\b[^>]*>\s*/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<tr\b[^>]*>/gi, "\n| ")
    .replace(/<\/(?:td|th)>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
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

  return restoreBlocks(tidy(text), blocks);
}
