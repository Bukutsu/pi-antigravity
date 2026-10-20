/**
 * HTML parsing and Markdown rendering belong to Domino and Turndown. This module
 * only chooses page content, resolves links, and reads the crawler's metadata.
 */
import { createDocument } from "@mixmark-io/domino";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";

const markdown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  hr: "---",
});
markdown.use(tables);
markdown.addRule("inlineCodeText", {
  filter: (node) => node.nodeName === "CODE" && node.parentNode?.nodeName !== "PRE",
  replacement: (_content, node) => {
    const content = (node.textContent ?? "").replace(/\r?\n|\r/g, " ");
    if (!content) return "";
    const matches: string[] = content.match(/`+/g) ?? [];
    let delimiter = "`";
    while (matches.includes(delimiter)) delimiter += "`";
    const padding = /^`|^ .*?[^ ].* $|`$/.test(content) ? " " : "";
    return delimiter + padding + content + padding + delimiter;
  },
});
markdown.addRule("strikethrough", {
  filter: (node) => /^(DEL|S|STRIKE)$/.test(node.nodeName),
  replacement: (content) => `~~${content}~~`,
});
// GFM cells cannot contain block-level Markdown or unescaped pipes.
markdown.addRule("tableCell", {
  filter: ["td", "th"],
  replacement: (content, node) =>
    `${node.previousElementSibling ? " " : "| "}${content
      .trim()
      .replace(/\s*\n\s*/g, " ")
      .replace(/\|/g, "\\|")} |`,
});

const DROPPED_ELEMENTS =
  "script, style, noscript, template, svg, canvas, iframe, form, select, option, button";
const CHROME =
  'nav, aside, footer, .social-icons, [role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], [aria-hidden="true"], [hidden]';

export type PageMetadata = {
  title?: string;
  description?: string;
  /** Date the page says it was last modified, exactly as the page states it. */
  updated?: string;
};

/** Read metadata through the HTML parser, not a search through attribute text. */
export function extractPageMetadata(html: string): PageMetadata {
  const document = createDocument(html);
  const meta = (selector: string) =>
    document.querySelector(selector)?.getAttribute("content")?.trim() || undefined;
  return {
    title:
      meta('meta[property="og:title"]') ??
      meta('meta[name="twitter:title"]') ??
      (document.querySelector("title")?.textContent?.trim() || undefined),
    description:
      meta('meta[property="og:description"]') ??
      meta('meta[name="description"]') ??
      meta('meta[name="twitter:description"]'),
    updated:
      meta('meta[property="article:modified_time"]') ??
      meta('meta[property="og:updated_time"]') ??
      meta('meta[name="last-modified"]') ??
      meta('meta[name="lastmod"]'),
  };
}

/** Leave plain text, JSON, and already-Markdown responses alone. */
export function looksLikeHtml(text: string): boolean {
  return /<!doctype\b[^<>]*>|<\/?(?:a|address|article|aside|audio|b|blockquote|body|br|button|canvas|caption|code|dd|details|div|dl|dt|em|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|label|legend|li|link|main|meta|nav|ol|option|p|pre|section|select|small|source|span|strong|style|sub|summary|sup|table|tbody|td|textarea|tfoot|th|thead|time|title|tr|u|ul|video)\b[^<>]*>/i.test(
    text.slice(0, 4000),
  );
}

/** Find a tag's closing angle bracket without mistaking a quoted attribute for markup. */
function findMarkupTagEnd(source: string, start: number): number {
  let quote = "";
  let afterEquals = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === ">") return index;
    if ((character === "'" || character === '"') && afterEquals) {
      quote = character;
      afterEquals = false;
    } else if (character === "=") {
      afterEquals = true;
    } else if (!/\s/.test(character)) {
      afterEquals = false;
    }
  }
  return -1;
}

export type CopyCompleteness = "complete" | "incomplete" | "unknown";

/**
 * A parsed DOM repairs truncated markup, so completeness must be checked against
 * the original source. Missing document-end tags alone are ambiguous because HTML
 * permits omitting them; a clean end at an element boundary is likewise ambiguous.
 * Unfinished tokens and unclosed article/main regions in full documents are
 * positive signs of truncation; sentence punctuation alone is not.
 */
export function classifyCopyCompleteness(html: string): CopyCompleteness {
  if (!html.trim()) return "complete";
  let index = 0;
  let documentRootSeen = false;
  let rootClosedAtEnd = false;
  let templateDepth = 0;
  let contentDepth = 0;

  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const commentEnd = html.indexOf("-->", index + 4);
      if (commentEnd < 0) return "incomplete";
      index = commentEnd + 3;
      continue;
    }
    if (html[index] !== "<") {
      if (!/\s/.test(html[index])) rootClosedAtEnd = false;
      index += 1;
      continue;
    }
    if (index + 1 >= html.length) return "incomplete";
    const next = html[index + 1];
    if (!/[a-z]/i.test(next) && next !== "!" && next !== "?" && next !== "/") {
      rootClosedAtEnd = false;
      index += 1;
      continue;
    }

    const tagEnd = findMarkupTagEnd(html, index);
    if (tagEnd < 0) return "incomplete";
    const tag = html.slice(index, tagEnd + 1);
    const name = /^<\s*\/?\s*([a-z][a-z0-9:-]*)\b/i.exec(tag)?.[1]?.toLowerCase();
    const closing = /^<\s*\//.test(tag);

    if (name === "html" || name === "body" || /^<!doctype\b/i.test(tag)) {
      documentRootSeen = true;
    }
    if (
      closing &&
      (name === "html" || name === "body") &&
      documentRootSeen &&
      templateDepth === 0
    ) {
      rootClosedAtEnd = true;
      index = tagEnd + 1;
      continue;
    }

    rootClosedAtEnd = false;
    if (templateDepth === 0 && (name === "article" || name === "main"))
      contentDepth = Math.max(0, contentDepth + (closing ? -1 : 1));
    if (!closing && name === "template" && !/\/\s*>$/.test(tag)) templateDepth += 1;
    if (closing && name === "template" && templateDepth > 0) templateDepth -= 1;

    if (
      !closing &&
      name &&
      /^(?:script|style|textarea|title|noscript|xmp|iframe|noembed|noframes|plaintext)$/.test(name)
    ) {
      if (name === "plaintext") return "unknown";
      const rawClose = new RegExp("</\\s*" + name + "\\s*>", "ig");
      rawClose.lastIndex = tagEnd + 1;
      const match = rawClose.exec(html);
      if (!match) return "incomplete";
      index = match.index + match[0].length;
      continue;
    }
    index = tagEnd + 1;
  }

  if (rootClosedAtEnd) return "complete";
  return documentRootSeen && contentDepth > 0 ? "incomplete" : "unknown";
}

/** Whether the source has an unambiguously unfinished final HTML token. */
export function isPartialCopy(html: string): boolean {
  return classifyCopyCompleteness(html) === "incomplete";
}

export type HtmlToMarkdownOptions = {
  /** Page URL, used to turn relative links and image sources into absolute ones. */
  baseUrl?: string;
};

function resolveTarget(target: string, baseUrl?: string): string {
  try {
    return new URL(target, baseUrl).toString();
  } catch {
    return target;
  }
}

function sameLanguage(first: string, second: string): boolean {
  const parts = (tag: string) => {
    const subtags = tag.toLowerCase().split("-");
    return {
      language: subtags[0],
      script: subtags.slice(1).find((part) => /^[a-z]{4}$/.test(part)),
      variants: subtags
        .slice(1)
        .filter((part) => /^[a-z0-9]{5,8}$/.test(part) || /^[0-9][a-z0-9]{3}$/.test(part)),
    };
  };
  const left = parts(first);
  const right = parts(second);
  return (
    left.language === right.language &&
    (!left.script || !right.script || left.script === right.script) &&
    ((left.variants.length === 0 && right.variants.length === 0) ||
      left.variants.join("-") === right.variants.join("-"))
  );
}

/** Whether an inline style explicitly hides its element. */
function isHiddenStyle(style: string | null): boolean {
  return (
    style?.split(";").some((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator < 0) return false;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration
        .slice(separator + 1)
        .replace(/\s*!important\s*$/i, "")
        .trim()
        .toLowerCase();
      return (
        (property === "display" && value === "none") ||
        (property === "visibility" && (value === "hidden" || value === "collapse"))
      );
    }) ?? false
  );
}

/** Remove only a dangling tag fragment at the end of a partial page. */
function removeDanglingTailText(node: Node): boolean {
  const children = Array.from(node.childNodes);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child.nodeType === 3) {
      const text = child.textContent ?? "";
      if (!text.trim()) {
        child.remove();
        continue;
      }
      if (/^\s*(?:<\s*|<\/?[a-z][a-z0-9:-]*(?:\s[^<>]*)?\s*)$/i.test(text)) {
        child.remove();
        return true;
      }
      return false;
    }
    if (child.nodeType === 8) continue;
    if (child.nodeType === 1) {
      if (removeDanglingTailText(child)) return true;
      if (!child.textContent?.trim()) continue;
    }
    return false;
  }
  return false;
}

function tableCellHasContent(cell: HTMLTableCellElement): boolean {
  return Boolean(cell.textContent?.trim() || cell.querySelector("img"));
}

function tableRowHasContent(row: HTMLTableRowElement): boolean {
  return Array.from(row.cells).some(tableCellHasContent);
}

function belongsToTable(row: HTMLTableRowElement, table: HTMLTableElement): boolean {
  let ancestor: Node | null = row.parentNode;
  while (ancestor && ancestor !== table) {
    if (ancestor.nodeName === "TABLE") return false;
    ancestor = ancestor.parentNode;
  }
  return ancestor === table;
}

function hasTableAncestor(table: HTMLTableElement): boolean {
  let ancestor: Node | null = table.parentNode;
  while (ancestor) {
    if (ancestor.nodeName === "TABLE") return true;
    ancestor = ancestor.parentNode;
  }
  return false;
}

function flattenNestedTables(root: Element, document: Document): void {
  for (const table of Array.from(root.querySelectorAll("table")).reverse()) {
    if (!hasTableAncestor(table)) continue;
    const rows = Array.from(table.rows).filter(
      (row) => belongsToTable(row, table) && tableRowHasContent(row),
    );
    const text = rows
      .map((row) =>
        Array.from(row.cells)
          .map((cell) => cell.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" — "),
      )
      .filter(Boolean)
      .join("; ");
    table.replaceWith(document.createTextNode(text ? ` ${text} ` : ""));
  }
}

function normalizeTableRows(table: HTMLTableElement, document: Document): HTMLTableRowElement[] {
  const rows = Array.from(table.rows).filter((row) => belongsToTable(row, table));
  const occupiedUntil = new Map<number, number>();
  const placements: Array<Array<{ cell: HTMLTableCellElement; column: number; span: number }>> =
    rows.map(() => []);
  let width = 0;

  rows.forEach((row, rowIndex) => {
    if (!tableRowHasContent(row)) return;
    let column = 0;
    for (const cell of Array.from(row.cells)) {
      if (!tableCellHasContent(cell) && cell.rowSpan > 1) continue;
      const span = Math.max(1, cell.colSpan);
      while (
        Array.from(
          { length: span },
          (_value, offset) => occupiedUntil.get(column + offset) ?? -1,
        ).some((lastRow) => lastRow >= rowIndex)
      ) {
        column += 1;
      }
      placements[rowIndex].push({ cell, column, span });
      const rowSpan = Math.min(
        rows.length - rowIndex,
        cell.rowSpan === 0 ? rows.length - rowIndex : Math.max(1, cell.rowSpan),
      );
      for (let offset = 0; offset < span; offset += 1) {
        occupiedUntil.set(column + offset, rowIndex + rowSpan - 1);
      }
      column += span;
    }
    if (tableRowHasContent(row)) width = Math.max(width, column);
  });

  rows.forEach((row, rowIndex) => {
    const placed = new Map(placements[rowIndex].map((item) => [item.column, item]));
    const cells: HTMLTableCellElement[] = [];
    for (let column = 0; column < width;) {
      const item = placed.get(column);
      if (item) {
        item.cell.removeAttribute("colspan");
        item.cell.removeAttribute("rowspan");
        cells.push(item.cell);
        for (let offset = 1; offset < item.span; offset += 1) {
          cells.push(document.createElement(item.cell.localName) as HTMLTableCellElement);
        }
        column += item.span;
      } else {
        cells.push(document.createElement("td"));
        column += 1;
      }
    }
    for (const child of Array.from(row.childNodes)) child.remove();
    for (const cell of cells) row.appendChild(cell);
  });

  return rows;
}

/** Read preformatted text while retaining the line breaks represented by <br>. */
function preformattedText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeName === "BR") return "\n";
  return Array.from(node.childNodes, preformattedText).join("");
}

/** HN's front page uses layout tables, not tabular article data. */
function hackerNewsListing(document: Document, baseUrl?: string): HTMLElement | undefined {
  if (!baseUrl) return undefined;
  const url = new URL(baseUrl);
  if (url.hostname !== "news.ycombinator.com" || !["/", "/news"].includes(url.pathname))
    return undefined;
  const stories = Array.from(document.querySelectorAll("tr.athing")).filter((row) =>
    row.querySelector(".titleline"),
  );
  if (!stories.length) return undefined;
  const main = document.createElement("main");
  const heading = document.createElement("h1");
  heading.textContent = document.title;
  main.appendChild(heading);
  const list = document.createElement("ol");
  for (const row of stories) {
    const item = document.createElement("li");
    item.appendChild(row.querySelector(".titleline")!.cloneNode(true));
    const metadata = row.nextElementSibling?.querySelector(".subtext");
    if (metadata) {
      item.appendChild(document.createTextNode(" — "));
      for (const child of Array.from(metadata.childNodes)) item.appendChild(child.cloneNode(true));
    }
    list.appendChild(item);
  }
  main.appendChild(list);
  const more = document.querySelector("a.morelink");
  if (more) main.appendChild(more.cloneNode(true));
  return main;
}

/** Convert the page's content; the DOM parser also repairs incomplete crawler copies. */
export function htmlToMarkdown(html: string, { baseUrl }: HtmlToMarkdownOptions = {}): string {
  if (!html) return "";
  // Mozilla Readability recommends isolating its mutating extraction on a clone (Apache-2.0):
  // https://github.com/mozilla/readability. This parse already owns a disposable DOM.
  const document = createDocument(html);
  const language = (document.documentElement.lang || document.body.lang).toLowerCase();
  for (const node of Array.from(document.querySelectorAll(DROPPED_ELEMENTS))) node.remove();
  for (const node of Array.from(document.querySelectorAll("[hidden], [aria-hidden], [style]"))) {
    if (
      node.hasAttribute("hidden") ||
      node.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" ||
      isHiddenStyle(node.getAttribute("style"))
    ) {
      node.remove();
    }
  }
  const articles = Array.from(document.querySelectorAll("article"));
  const root =
    hackerNewsListing(document, baseUrl) ??
    document.querySelector("main") ??
    document.querySelector('[role="main"]') ??
    (articles.length === 1 ? articles[0] : null) ??
    document.body;
  for (const node of Array.from(root.querySelectorAll(CHROME))) node.remove();
  if (isPartialCopy(html)) removeDanglingTailText(root);

  for (const link of Array.from(root.querySelectorAll("a"))) {
    link.removeAttribute("title");
    const declared = (link.getAttribute("hreflang") || link.getAttribute("lang"))?.toLowerCase();
    const href = link.getAttribute("href")?.trim();
    const textLabel = link.textContent?.trim() ?? "";
    const ariaLabel = link.getAttribute("aria-label")?.trim() ?? "";
    if (!textLabel && ariaLabel) link.textContent = ariaLabel;
    const label = textLabel || ariaLabel;
    if (!label && !link.querySelector("img")) {
      link.remove();
      continue;
    }
    if (
      (language && declared && !sameLanguage(language, declared)) ||
      (href?.startsWith("#") && (!/[\p{L}\p{N}]/u.test(label) || /^skip\b/i.test(label)))
    ) {
      link.remove();
    } else if (
      href?.startsWith("#") ||
      /^(?:javascript|vbscript|data):/i.test(href?.replace(/\s/g, "") ?? "")
    ) {
      link.removeAttribute("href");
    } else if (href) {
      link.setAttribute("href", resolveTarget(href, baseUrl));
      if (
        link.childNodes.length === 1 &&
        link.firstChild === link.firstElementChild &&
        link.firstElementChild?.tagName === "IMG"
      ) {
        link.removeAttribute("href");
      } else if (label === href || label === link.getAttribute("href")) {
        link.replaceWith(document.createTextNode(link.getAttribute("href")!));
      }
    }
  }
  for (const image of Array.from(root.querySelectorAll("img"))) {
    image.removeAttribute("title");
    const src = image.getAttribute("src")?.trim();
    if (!src || /^(?:data|javascript|vbscript):/i.test(src.replace(/\s/g, ""))) image.remove();
    else image.setAttribute("src", resolveTarget(src, baseUrl));
  }
  for (const link of Array.from(root.querySelectorAll("a"))) {
    if (!link.textContent?.trim() && !link.querySelector("img")) link.remove();
  }
  for (const item of Array.from(root.querySelectorAll("li"))) {
    if (!item.textContent?.trim() && !item.querySelector("img")) item.remove();
  }

  // Turndown's fenced-code rule expects <pre><code>...</code></pre>.
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    const text = preformattedText(pre);
    if (pre.childNodes.length === 1 && pre.firstChild?.nodeName === "CODE") {
      pre.firstChild.textContent = text;
      continue;
    }
    const code = document.createElement("code");
    code.textContent = text;
    pre.textContent = "";
    pre.appendChild(code);
  }
  flattenNestedTables(root, document);
  // Give the GFM plugin a rectangular table with an explicit header section.
  for (const table of Array.from(root.querySelectorAll("table"))) {
    const rows = normalizeTableRows(table, document).filter(tableRowHasContent);
    if (!rows.length || (!table.textContent?.trim() && !table.querySelector("img"))) {
      table.remove();
      continue;
    }
    const width = Math.max(...rows.map((row) => row.cells.length));
    for (const row of rows) {
      while (row.cells.length < width) row.appendChild(document.createElement("td"));
    }
    const first = rows[0];
    const header = Array.from(first.cells).every((cell) => cell.tagName === "TH")
      ? rows.shift()!
      : document.createElement("tr");
    while (header.cells.length < width) header.appendChild(document.createElement("th"));
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    head.appendChild(header);
    for (const row of rows) body.appendChild(row);
    const sourceCaption = table.querySelector("caption");
    if (sourceCaption) {
      const caption = document.createElement("p");
      caption.textContent = sourceCaption.textContent;
      table.parentNode!.insertBefore(caption, table);
    }
    table.textContent = "";
    table.appendChild(head);
    table.appendChild(body);
  }

  return markdown.turndown(root).trim();
}
