import { createDocument } from "@mixmark-io/domino";
import { isRecord } from "../utils/util.js";
import {
  classifyCopyCompleteness,
  extractPageMetadata,
  htmlToMarkdown,
  looksLikeHtml,
  sanitizeMetadataText,
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
  alternates: Array<{
    url: string;
    type: "text/markdown" | "application/json";
    language?: string;
  }>;
};

function normalizedWallHeading(value: string): string {
  return value
    .replace(/\s*[|•–—-]\s*cloudflare\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Headings that are a wall on their own. They stay exact: "429 Too Many Requests"
 * is also the title of a real article about that status, and "Forbidden error
 * handling" is a real article title.
 */
const ACCESS_WALL_HEADINGS = [
  "forbidden",
  "403 forbidden",
  "unauthorized",
  "401 unauthorized",
  "access denied",
];

/**
 * Openings of the interstitials that stand in for an article. The heading of a real
 * wall usually carries more than the phrase itself ("Please enable JavaScript to
 * continue"), so a phrase that opens the heading marks a wall.
 */
const ACCESS_WALL_OPENINGS = [
  "just a moment",
  "verify you are human",
  "verifying you are human",
  "attention required",
  "you have been blocked",
  "sorry, you have been blocked",
  "checking your browser",
  "security check",
  "enable javascript",
  "please enable javascript",
  "javascript is required",
  "javascript required",
  "are you a robot",
  "unusual traffic",
  "request blocked",
  "rate limited",
  "you are being rate limited",
];

/** Sign-in pages read like a wall, but an article title may also start with one. */
const ACCESS_WALL_SIGN_IN_OPENINGS = ["sign in", "log in"];

/** How much text may follow the wall phrase before the heading is an article title. */
const ACCESS_WALL_TAIL = 40;
const ACCESS_WALL_SIGN_IN_TAIL = 24;

/** A short block/sign-in heading, not an article that happens to discuss one. */
function isAccessWallHeading(value: string | undefined): boolean {
  if (!value) return false;
  const text = normalizedWallHeading(value).toLowerCase();
  if (!text) return false;
  if (ACCESS_WALL_HEADINGS.includes(text.replace(/[.!…\s]*$/, ""))) return true;
  const opens = (opening: string, tail: number) =>
    text.startsWith(opening) && text.length - opening.length <= tail;
  return (
    ACCESS_WALL_OPENINGS.some((opening) => opens(opening, ACCESS_WALL_TAIL)) ||
    ACCESS_WALL_SIGN_IN_OPENINGS.some((opening) => opens(opening, ACCESS_WALL_SIGN_IN_TAIL))
  );
}

function isLoadingShell(rendered: string): boolean {
  const visible = rendered.replace(/^#{1,6} .*$/gm, "").trim();
  return /^(?:loading|please wait|redirecting|initializing)[.!…\s]*$/i.test(visible);
}

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
export function inspectPage(content: string, url: string, contentType?: string): PageInspection {
  if (!looksLikeHtml(content, contentType)) {
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
      metadata: { title: sanitizeMetadataText(title, 300) },
      alternates: [],
    };
  }
  const document = createDocument(content);
  const metadata: PageInspection["metadata"] = extractPageMetadata(content);
  metadata.language = sanitizeMetadataText(document.documentElement.lang || undefined, 50);
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
      typeof value === "string" && value.trim() ? sanitizeMetadataText(value, 1000) : undefined;
    metadata.title ??= text(article.headline);
    metadata.description ??= text(article.description);
    metadata.updated ??= text(article.dateModified);
    metadata.published = text(article.datePublished);
    metadata.language ??= text(article.inLanguage);
    const author: unknown = Array.isArray(article.author) ? article.author[0] : article.author;
    const person: unknown =
      isRecord(author) && !author.name && typeof author["@id"] === "string"
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
      if (/\.pdf$/i.test(alternate.pathname)) continue;
      alternate.hash = "";
      if (alternate.href === identity || alternates.some((item) => item.url === alternate.href))
        continue;
      const language = sanitizeMetadataText(
        link.getAttribute("hreflang") ?? undefined,
        35,
      )?.toLowerCase();
      const declaredLanguage = language && language !== "x-default" ? language : undefined;
      alternates.push({
        url: alternate.href,
        type,
        ...(declaredLanguage ? { language: declaredLanguage } : {}),
      });
    } catch {
      // Ignore invalid URLs, including malformed base-relative references.
    }
  }
  const pageLanguage = metadata.language?.split("-")[0].toLowerCase();
  const sameLanguage = pageLanguage
    ? alternates.filter((item) => !item.language || item.language.split("-")[0] === pageLanguage)
    : alternates;
  const preferred = sameLanguage.length ? sameLanguage : alternates;
  preferred.sort((a, b) => Number(b.type === "text/markdown") - Number(a.type === "text/markdown"));
  const rendered = htmlToMarkdown(content, { baseUrl: url });
  const heading = document.querySelector("h1")?.textContent?.trim() || metadata.title || "";
  // A page that loads an application script and shows nothing else is a shell.
  const completeness = classifyCopyCompleteness(content);
  // A page that loads application JavaScript and shows only a placeholder is a shell.
  const appScript = Boolean(document.querySelector('script[src], script[type="module"]'));
  const assessment: ContentAssessment = !rendered.trim()
    ? // A copy that ends before the content is cut off, not an application shell.
      appScript && completeness !== "incomplete"
      ? "suspected-shell"
      : "empty"
    : isAccessWallHeading(heading) || isAccessWallHeading(metadata.title)
      ? "suspected-access-wall"
      : (appScript && isLoadingShell(rendered)) || !rendered.replace(/^#{1,6} .*$/gm, "").trim()
        ? "suspected-shell"
        : "readable";
  return {
    rendered,
    completeness,
    assessment,
    metadata,
    alternates: preferred.slice(0, 8),
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
