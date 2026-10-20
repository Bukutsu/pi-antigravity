import { createDocument } from "@mixmark-io/domino";
import { isRecord } from "../utils/util.js";
import {
  classifyCopyCompleteness,
  extractPageMetadata,
  htmlToMarkdown,
  looksLikeHtml,
} from "./markdown.js";

export type ContentAssessment = "readable" | "empty" | "suspected-shell" | "suspected-access-wall";

export type PageInspection = {
  rendered: string;
  completeness: "complete" | "incomplete" | "unknown";
  assessment: ContentAssessment;
  metadata: ReturnType<typeof extractPageMetadata> & {
    author?: string;
    published?: string;
    language?: string;
  };
  alternates: Array<{ url: string; type: "text/markdown" | "application/json" }>;
};

/** Match structured data to this page without treating fragments as separate pages. */
function pageIdentity(value: unknown, baseUrl: string): string | undefined {
  if (isRecord(value)) value = value["@id"];
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/** Inspect data before destructive Markdown cleanup; never execute page scripts. */
export function inspectPage(content: string, url: string): PageInspection {
  if (!looksLikeHtml(content)) {
    const rendered = content.trim();
    let title: string | undefined;
    let fence: string | undefined;
    for (const line of rendered.split("\n")) {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (delimiter) {
        if (!fence) fence = delimiter[1];
        else if (
          delimiter[1][0] === fence[0] &&
          delimiter[1].length >= fence.length &&
          !delimiter[2].trim()
        )
          fence = undefined;
      } else if (!fence) {
        title = /^ {0,3}# +(.+?)(?: +#+)?\s*$/.exec(line)?.[1];
        if (title) break;
      }
    }
    return {
      rendered,
      completeness: "unknown",
      assessment: rendered ? "readable" : "empty",
      metadata: { title },
      alternates: [],
    };
  }
  const document = createDocument(content);
  const metadata: PageInspection["metadata"] = extractPageMetadata(content);
  metadata.language = document.documentElement.lang || undefined;
  const nodes: Record<string, unknown>[] = [];
  let budget = 256_000;
  for (const script of Array.from(
    document.querySelectorAll('script[type="application/ld+json"]'),
  ).slice(0, 16)) {
    const text = script.textContent ?? "";
    budget -= text.length;
    if (budget < 0) break;
    try {
      const value: unknown = JSON.parse(text);
      const roots = Array.isArray(value) ? value : [value];
      for (const root of roots) {
        if (!isRecord(root)) continue;
        nodes.push(root);
        if (Array.isArray(root["@graph"])) nodes.push(...root["@graph"].filter(isRecord));
      }
    } catch {
      // Invalid or truncated structured data is not evidence.
    }
  }
  const identity = pageIdentity(url, url);
  const article = nodes.find((node) => {
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    return (
      types.some((type) => /^(Article|NewsArticle|BlogPosting|TechArticle)$/.test(String(type))) &&
      [node.url, node.mainEntityOfPage, node["@id"]].some(
        (value) => pageIdentity(value, url) === identity,
      )
    );
  });
  if (article) {
    const text = (value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim().slice(0, 4000) : undefined;
    metadata.title ??= text(article.headline);
    metadata.description ??= text(article.description);
    metadata.updated ??= text(article.dateModified);
    metadata.published = text(article.datePublished);
    metadata.language ??= text(article.inLanguage);
    const author: unknown = Array.isArray(article.author) ? article.author[0] : article.author;
    const person: unknown =
      isRecord(author) && !author.name
        ? nodes.find((node) => node["@id"] === author["@id"])
        : author;
    metadata.author = isRecord(person) ? text(person.name) : text(person);
  }

  const alternates: PageInspection["alternates"] = [];
  for (const link of Array.from(document.querySelectorAll("link[href][type]"))) {
    if (!(link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("alternate"))
      continue;
    const type = link.getAttribute("type")?.split(";")[0].toLowerCase().trim();
    if (type !== "text/markdown" && type !== "application/json") continue;
    try {
      const alternate = new URL(link.getAttribute("href")!, url);
      if (alternate.origin !== new URL(url).origin || alternate.username || alternate.password)
        continue;
      alternate.hash = "";
      if (alternate.href === identity || alternates.some((item) => item.url === alternate.href))
        continue;
      alternates.push({ url: alternate.href, type });
    } catch {
      // Ignore invalid URLs, including malformed base-relative references.
    }
  }
  alternates.sort(
    (a, b) => Number(b.type === "text/markdown") - Number(a.type === "text/markdown"),
  );
  const rendered = htmlToMarkdown(content, { baseUrl: url });
  const heading = document.querySelector("h1")?.textContent?.trim() || metadata.title || "";
  const scriptShell = Boolean(document.querySelector('script[type="module"][src]'));
  const assessment: ContentAssessment = !rendered.trim()
    ? scriptShell
      ? "suspected-shell"
      : "empty"
    : /^(access denied|just a moment|sign in|log in|verify you are human|attention required)[.!…\s]*$/i.test(
          heading,
        )
      ? "suspected-access-wall"
      : !rendered.replace(/^#{1,6} .*$/gm, "").trim()
        ? "suspected-shell"
        : "readable";
  return {
    rendered,
    completeness: classifyCopyCompleteness(content),
    assessment,
    metadata,
    alternates: alternates.slice(0, 8),
  };
}

/** Decode only explicit article-body JSON shapes from an advertised representation. */
export function articleRepresentation(content: string, articleUrl: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  // GitHub Docs article API.
  if (
    isRecord(value.meta) &&
    value.meta.documentType === "article" &&
    typeof value.body === "string" &&
    Array.isArray(value.meta.breadcrumbs)
  ) {
    const current: unknown = value.meta.breadcrumbs.at(-1);
    if (
      isRecord(current) &&
      pageIdentity(current.href, articleUrl) === pageIdentity(articleUrl, articleUrl)
    )
      return value.body;
  }
  // WordPress single-post REST representation (not an index or oEmbed summary).
  if (
    typeof value.id === "number" &&
    typeof value.link === "string" &&
    pageIdentity(value.link, articleUrl) === pageIdentity(articleUrl, articleUrl) &&
    isRecord(value.content) &&
    value.content.protected !== true &&
    typeof value.content.rendered === "string"
  ) {
    return value.content.rendered;
  }
  return undefined;
}
