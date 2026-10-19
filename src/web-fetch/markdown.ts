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

/**
 * Elements whose contents are raw text rather than markup.
 *
 * A browser ends `<script>` at the first `</script>`, however many `<script>` strings
 * the code inside holds: old pages are full of `document.write('<script …>')`, and
 * counting those as nested elements would leave the copy looking unclosed.
 */
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

/** Tags that never open a subtree, so nesting bookkeeping can skip them. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Attribute values a page uses to mark an element as furniture instead of content:
 * ARIA landmarks around navigation, banners, and page search, and content the page
 * keeps out of the accessibility tree, which is decorative or duplicated elsewhere.
 * `complementary` deliberately does not match: a sidebar is often the page's own
 * secondary content on a nav-only or content start.
 */
const CHROME_MARKERS = [
  /role\s*=\s*["'](?:navigation|banner|contentinfo|search)["']/i,
  /aria-hidden\s*=\s*["']true["']/i,
];

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
 * Index of the close tag that matches the open tag of `tag` just before `from`, or -1.
 *
 * Counting nested opens is what makes a `role="main"` region right: the region is a
 * `<div>` on plenty of sites, and the document's last `</div>` usually belongs to
 * something else. A copy that stops before the matching close tag returns -1.
 */
function matchingCloseIndex(html: string, tag: string, from: number): number {
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (/\/>$/.test(match[0])) continue;
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

/**
 * Slice a document down to its `<main>` (or `<article>`) content when it has one.
 *
 * That is where publishers put the page itself; everything before and after it is
 * masthead, menus, and footers. A `role="main"` element counts too, since plenty of
 * sites use the landmark on a `<div>` instead of the `<main>` tag. The crawler's copy
 * can stop mid-page, so a document without the matching close tag keeps everything
 * from the opening tag on, which is still better than site chrome.
 */
function selectContentRegion(html: string): string {
  const regions = [
    /<main\b[^>]*>/i,
    /<[a-z][a-z0-9-]*\b[^>]*\brole\s*=\s*["']main["'][^>]*>/i,
    /<article\b[^>]*>/i,
  ];
  for (const pattern of regions) {
    const open = pattern.exec(html);
    if (!open) continue;
    const tag = /^<([a-z][a-z0-9-]*)/i.exec(open[0])?.[1]?.toLowerCase();
    if (!tag) continue;
    const from = open.index + open[0].length;
    const close = matchingCloseIndex(html, tag, from);
    return close > from ? html.slice(from, close) : html.slice(from);
  }
  return html;
}

/**
 * Remove the elements a page marks as furniture through attributes.
 *
 * `role` names the element's job, so a navigation, banner, or search landmark can be
 * dropped however it is tagged, and `aria-hidden` means the page itself keeps the
 * element out of the accessibility tree, which is the mark of icons, duplicate
 * labels, and decorative wrappers. A stack walk rather than a regex: the marker can
 * sit on any tag, and nesting decides where its subtree ends. A copy that ends inside
 * one implicitly closes it, as in `dropElement`.
 */
function dropChromeElements(html: string): string {
  const tag = /<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi;
  const stack: string[] = [];
  let text = "";
  let cursor = 0;
  let droppedAt = -1;
  let droppedDepth = -1;
  for (const match of html.matchAll(tag)) {
    const name = match[1].toLowerCase();
    const closing = match[0].startsWith("</");
    if (VOID_ELEMENTS.has(name) || /\/>$/.test(match[0])) continue;
    if (!closing) {
      if (droppedAt < 0 && CHROME_MARKERS.some((marker) => marker.test(match[0]))) {
        droppedAt = match.index;
        droppedDepth = stack.length;
      }
      stack.push(name);
      continue;
    }
    const open = stack.lastIndexOf(name);
    if (open < 0) continue;
    if (droppedAt >= 0 && open === droppedDepth) {
      text += `${html.slice(cursor, droppedAt)} `;
      cursor = match.index + match[0].length;
      droppedAt = -1;
      droppedDepth = -1;
    }
    stack.length = open;
  }
  if (droppedAt >= 0) {
    text += `${html.slice(cursor, droppedAt)} `;
    cursor = html.length;
  }
  return text + html.slice(cursor);
}

/** The document's own language tag, when it declares one. */
function documentLanguage(html: string): string {
  const match =
    /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html) ??
    /<body\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html);
  return match ? match[1].trim().toLowerCase() : "";
}

/**
 * Remove every `<tag>` subtree, nested ones included.
 *
 * A plain non-greedy regex would stop at the first close tag, which for nested
 * landmarks (a `<nav>` inside a `<nav>`) leaves the rest of the outer one behind.
 * Raw-text elements are the exception: the first close tag ends them, exactly as a
 * browser reads them.
 */
function dropElement(html: string, tag: string): string {
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  const rawText = RAW_TEXT_ELEMENTS.has(tag);
  let text = "";
  let cursor = 0;
  let start = -1;
  let depth = 0;
  for (const match of html.matchAll(pattern)) {
    if (match[1] !== "/") {
      if (/\/>$/.test(match[0])) continue;
      // Inside a raw-text element every tag is text, so only the first open counts.
      if (rawText && depth > 0) continue;
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

/** Whether an anchor declares a language other than the document's own. */
function isForeignLanguageLink(attrs: string, pageLanguage?: string): boolean {
  if (!pageLanguage) return false;
  const declared = (attribute(attrs, "hreflang") ?? attribute(attrs, "lang"))?.toLowerCase();
  return declared !== undefined && declared !== pageLanguage;
}

/**
 * Whether a fragment link's label is a permalink mark or a skip-link caption.
 *
 * Pages put a pilcrow or an arrow next to every heading and a "Skip to content" link at
 * the top of the document; neither says anything about the page, and both link nowhere
 * but the page itself.
 */
function isSelfLinkLabel(label: string): boolean {
  return !/[\p{L}\p{N}]/u.test(label) || /^skip\b/i.test(label);
}

/**
 * One `<a>` element as Markdown.
 *
 * A link that only wraps an image stays an image, a link whose label is its own URL
 * keeps just the URL, and a link the page declares as pointing at another language is
 * dropped: on the pages that carry them, those are language pickers, not reading
 * matter. Fragment links keep their label, unless the label is a permalink mark or a
 * skip-link caption.
 */
function anchorToMarkdown(
  attrs: string,
  inner: string,
  baseUrl?: string,
  pageLanguage?: string,
): string {
  // The image pass runs first, so an image-only link arrives as Markdown already.
  if (/^\s*!\[[\s\S]*?\]\([^)]*\)\s*$/.test(inner)) return inner.trim();
  if (isForeignLanguageLink(attrs, pageLanguage)) return " ";
  const href = attribute(attrs, "href");
  const label = decodeHtmlEntities(stripTags(inner));
  if (!href || /^(?:javascript|#)/i.test(href)) {
    if (href !== undefined && /^#/.test(href) && isSelfLinkLabel(label)) return " ";
    return label || " ";
  }
  const target = encodeDestination(resolveTarget(href, baseUrl));
  // Not `<target>`: the surrounding pass strips anything that looks like a tag.
  if (!label || label === href || label === target) return target;
  return `[${escapeLabel(label)}](${target})`;
}

/** One table cell as inline Markdown on a single line, with pipes escaped. */
function cellText(html: string, baseUrl?: string, pageLanguage?: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<img\b[^>]*>/gi, (tag: string) => imageToMarkdown(tag, baseUrl))
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attrs: string, inner: string) =>
      anchorToMarkdown(attrs, inner, baseUrl, pageLanguage),
    )
    .replace(/<(?:code|kbd|samp)\b[^>]*>/gi, "`")
    .replace(/<\/(?:code|kbd|samp)\s*>/gi, "`")
    .replace(/<(?:strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/(?:strong|b)\s*>/gi, "**")
    .replace(/<(?:em|i)\b[^>]*>/gi, "*")
    .replace(/<\/(?:em|i)\s*>/gi, "*");
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
function tableToMarkdown(html: string, baseUrl?: string, pageLanguage?: string): string {
  const rows: Array<{ cells: string[]; header: boolean }> = [];
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi) ?? []) {
    const cells = (row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]\s*>/gi) ?? []).map((cell) =>
      cellText(
        cell.replace(/^<t[dh]\b[^>]*>/i, "").replace(/<\/t[dh]\s*>$/i, ""),
        baseUrl,
        pageLanguage,
      ),
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
  const caption = /<caption\b[^>]*>([\s\S]*?)<\/caption\s*>/i.exec(html)?.[1];
  const captionText = caption ? cellText(caption, baseUrl, pageLanguage) : "";
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
  const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(html)?.[1] ?? html.slice(0, 32 * 1024);
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

/**
 * Collapse blank lines, horizontal whitespace, and empty blocks outside code fences.
 *
 * A copy that was cut off can also end inside an unclosed tag, which `stripTags` cannot
 * match because the tag never closes, so the leftover fragment goes here.
 */
function tidy(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ""))
    .filter((line) => !/^#{1,6}$/.test(line) && !/^-\s*$/.test(line))
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/<[a-z][a-z0-9-]*(?:\s[^<>]*)?$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

/** A tail that shows a copy ran to the end of its own document. */
const COMPLETE_COPY_TAIL =
  /(?:<\/[a-z][a-z0-9-]*\s*>|<(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b[^>]*>|<[a-z][a-z0-9-]*\b[^>]*\/>)\s*$/i;

/**
 * Whether the crawler's copy stops mid-document, so part of the page never arrived.
 *
 * The copy is bytes with no length promise attached: pages that stream their markup,
 * or that the crawler gives up on, end inside a tag or mid-sentence. A copy that ends
 * with a closing tag of its own document ran to the end. Callers surface this instead
 * of presenting the fragment as the whole page.
 */
export function isPartialCopy(html: string): boolean {
  const text = html.trimEnd();
  return Boolean(text) && !COMPLETE_COPY_TAIL.test(text);
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
  const pageLanguage = documentLanguage(html);

  let text = html.replace(/<!--[\s\S]*?-->/g, " ");

  // Scripting and site chrome go first, then everything outside the page's own content.
  text = selectContentRegion(dropElements(text, DROPPED_ELEMENTS));
  text = dropElements(text, BOILERPLATE_ELEMENTS);
  text = dropChromeElements(text);

  // Head metadata is not page text; the caller keeps the title separately.
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ");

  // Tables and `<pre>` blocks are lifted out whole: their shape is the point, and the
  // per-tag pass below would flatten it.
  const blocks: string[] = [];
  const keepBlock = (markdown: string): string => {
    blocks.push(markdown);
    return `${BLOCK_SLOT}${blocks.length - 1}${BLOCK_SLOT}`;
  };

  text = text.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (table: string) => {
    const markdown = tableToMarkdown(table, baseUrl, pageLanguage);
    return markdown ? keepBlock(markdown) : " ";
  });

  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, inner: string) => {
    const code = decodeEntityText(stripTags(inner).replace(/^\s+|\s+$/g, ""));
    const fence = code.includes("```") ? "````" : "```";
    return keepBlock(`\n\n${fence}\n${code}\n${fence}\n\n`);
  });

  text = text.replace(/<img\b[^>]*>/gi, (tag: string) => imageToMarkdown(tag, baseUrl));

  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attrs: string, inner: string) =>
    anchorToMarkdown(attrs, inner, baseUrl, pageLanguage),
  );

  for (let level = 1; level <= 6; level += 1) {
    text = text
      .replace(new RegExp(`<h${level}\\b[^>]*>`, "gi"), `\n\n${"#".repeat(level)} `)
      .replace(new RegExp(`</h${level}\\s*>`, "gi"), "\n\n");
  }

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n")
    // Whitespace around list-item tags would otherwise leave a blank line per item.
    .replace(/<\/li\s*>\s*(?=<li\b)/gi, "")
    .replace(/\s*<li\b[^>]*>\s*/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<tr\b[^>]*>/gi, "\n| ")
    .replace(/<\/(?:td|th)\s*>/gi, " | ")
    .replace(/<\/tr\s*>/gi, "\n")
    .replace(/<blockquote\b[^>]*>/gi, "\n\n> ")
    .replace(/<(?:strong|b)\b[^>]*>/gi, "**")
    .replace(/<\/(?:strong|b)\s*>/gi, "**")
    .replace(/<(?:em|i)\b[^>]*>/gi, "*")
    .replace(/<\/(?:em|i)\s*>/gi, "*")
    .replace(/<(?:del|s|strike)\b[^>]*>/gi, "~~")
    .replace(/<\/(?:del|s|strike)\s*>/gi, "~~")
    .replace(/<code\b[^>]*>/gi, "`")
    .replace(/<\/code\s*>/gi, "`");

  for (const element of BLOCK_CLOSERS) {
    text = text.replace(new RegExp(`</${element}\\s*>`, "gi"), "\n\n");
  }

  text = decodeEntityText(stripTags(text));

  return restoreBlocks(tidy(text), blocks);
}
