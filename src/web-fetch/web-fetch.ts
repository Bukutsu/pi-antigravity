/**
 * Read a public page through Google's Antigravity fetch service.
 *
 * The official `agy` CLI serves its `read_url_content` tool from two Cloud Code Assist
 * RPCs rather than from a local HTTP client, so the crawl happens on Google's side and
 * the account's OAuth token is the only credential involved:
 *
 *   1. `v1internal:rewriteUri` resolves a redirect chain and reports the final URI.
 *   2. `v1internal:fetchFromTrawlerCache` answers from Google's crawl cache, and a
 *      404 there means "not cached" rather than "no such page".
 *   3. The same RPC with `liveFetch: true` retries missing or inadequate copies.
 *
 * The response is crawled source, usually HTML. Inspection preserves metadata and
 * recovery links before Markdown cleanup; output is capped before reaching a model.
 * No local HTTP client or JavaScript renderer contacts the target site.
 */
import {
  antigravityHeaders,
  endpointCandidates,
  jsonOrTextError,
  parseApiKey,
} from "../client/client.js";
import { isPrivateAddress } from "../search/index.js";
import { antigravityFetch } from "../utils/http.js";
import { safeError } from "../utils/security.js";
import { antigravityEnv, isRecord } from "../utils/util.js";
import { looksLikeHtml } from "./markdown.js";

import { articleRepresentation, inspectPage, type PageInspection } from "./inspect.js";
import { inspectMdnRepresentation, mdnRepresentationUrl } from "./mdn.js";

export const REWRITE_URI_PATH = "/v1internal:rewriteUri";
export const TRAWLER_FETCH_PATH = "/v1internal:fetchFromTrawlerCache";

/** Output budget for one page, in characters. Roughly 15k tokens of prose. */
export const DEFAULT_WEB_FETCH_MAX_CHARS = 60_000;

/** Shared network budget, including redirects, endpoint failover, and recovery. */
export const WEB_FETCH_TIMEOUT_MS = 10_000;

/** Hosts that name the local machine or a private network rather than a public site. */
const LOCAL_HOST_SUFFIXES = ["localhost", "local", "internal", "home.arpa"];

export type WebFetchSource = "cache" | "live";

export type WebFetchOptions = {
  apiKey?: string;
  /** Page to read. */
  url: string;
  /** Return the crawled source instead of Markdown. */
  raw?: boolean;
  /** Character budget for the returned content. */
  maxChars?: number;
  signal?: AbortSignal;
};

export type WebFetchResult = {
  /** URL as requested. */
  requestedUrl: string;
  /** URL the fetch service finally read, after any redirect. */
  resolvedUrl: string;
  /** Converted page content, already truncated to the character budget. */
  content: string;
  title?: string;
  description?: string;
  /** Date the page states it was last modified, when it states one. */
  updated?: string;
  /** Whether the crawl cache answered, or the page was fetched live. */
  source: WebFetchSource;
  /** Size of the crawler response before conversion and truncation. */
  bytes: number;
  /** Whether the returned content was capped at the character budget. */
  truncated: boolean;
  /** True if incomplete, false if complete, or null when the source is ambiguous. */
  partial: boolean | null;
  /** Assessment of the extracted content, independent of source completeness. */
  assessment?: PageInspection["assessment"];
  author?: string;
  published?: string;
  language?: string;
  /** Actual fetched representation, when different from the article URL. */
  representationUrl?: string;
  attempts?: Array<{ url: string; source: WebFetchSource; outcome: string }>;
  /** Uncapped rendering for bounded, in-memory continuation reads. Not model-facing. */
  fullContent?: string;
};

/**
 * Validate a target URL, returning its normalized form.
 *
 * The fetch runs on Google's machines, so a private address is not a request-forgery
 * risk here, but it can never be reached from there: rejecting it locally turns a
 * confusing remote failure into a clear message. Credentials in the URL are dropped for
 * the same reason, and because they would be sent to a third party.
 */
export function validateFetchTarget(raw: string): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) throw new Error("A URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Not a valid URL: ${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http and https URLs can be read (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not supported.");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const localName = LOCAL_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (!host || localName || isPrivateAddress(host)) {
    throw new Error(
      "That URL is a private or local address, which the fetch service cannot reach.",
    );
  }
  return parsed.toString();
}

/** Request body for the redirect resolver. */
export function buildRewriteUriRequest(originalUri: string): Record<string, unknown> {
  return { originalUri };
}

/** Request body for the crawl cache, and for the live fetch when the cache misses. */
export function buildTrawlerFetchRequest(url: string, live = false): Record<string, unknown> {
  return live ? { url, liveFetch: true } : { url };
}

/** Some Cloud Code Assist methods answer with a `response` wrapper; accept both shapes. */
function unwrapResponse(data: unknown): unknown {
  if (isRecord(data) && isRecord(data.response)) return data.response;
  return data;
}

/** Final URI from a rewrite response, when the request was redirected. */
export function parseRedirectUri(data: unknown): string | undefined {
  const body = unwrapResponse(data);
  if (!isRecord(body)) return undefined;
  const value = body.redirectUri ?? body.redirect_uri ?? body.rewrittenUri;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Page content from a trawler response. */
export function parseTrawlerContent(data: unknown): string | undefined {
  const body = unwrapResponse(data);
  if (!isRecord(body)) return undefined;
  const value = body.content ?? body.markdownContent;
  return typeof value === "string" && value ? value : undefined;
}

/** Character budget, from the caller or `ANTIGRAVITY_WEB_FETCH_MAX_CHARS`. */
export function resolveMaxChars(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const configured = Number(antigravityEnv("WEB_FETCH_MAX_CHARS"));
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_WEB_FETCH_MAX_CHARS;
}

type JsonPost = {
  status: number;
  data: unknown;
  text: string;
};

async function postJson(
  endpoint: string,
  path: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<JsonPost> {
  const response = await antigravityFetch(`${endpoint}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text };
}

/** Error carrying `fatal` when retrying another endpoint cannot help. */
function fetchError(text: string, status: number, stage: "cache" | "live"): Error {
  const detail = jsonOrTextError(text).slice(0, 400) || `HTTP ${status}`;
  const message =
    stage === "cache"
      ? `The crawl cache could not answer (HTTP ${status}: ${detail}).`
      : `The live fetch failed (HTTP ${status}: ${detail}). Try again later, or open the page in a browser.`;
  return Object.assign(new Error(message), { fatal: status < 500 && status !== 429, status });
}

/** Ask the service where a URL really points, ignoring resolver failures. */
async function resolveRedirect(
  endpoint: string,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  strict = false,
): Promise<string | undefined> {
  try {
    const response = await postJson(
      endpoint,
      REWRITE_URI_PATH,
      headers,
      buildRewriteUriRequest(url),
      signal,
    );
    if (response.status !== 200) {
      if (strict) throw new Error(`Alternate redirect resolver failed (HTTP ${response.status}).`);
      return undefined;
    }
    const redirect = parseRedirectUri(response.data);
    if (!redirect || redirect === url) return undefined;
    return validateFetchTarget(redirect);
  } catch (error) {
    // Original-page resolution is best-effort. Alternate recovery must fail closed.
    if (strict) throw error;
    return undefined;
  }
}

/** Return an unmatched fenced-code delimiter, if the Markdown ends inside one. */
function unclosedFence(markdown: string): { marker: string; length: number } | undefined {
  let open: { marker: string; length: number } | undefined;
  for (const line of markdown.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const delimiter = match[1];
    const rest = match[2];
    const marker = delimiter[0];
    if (!open) {
      if (marker === "`" && rest.includes("`")) continue;
      open = { marker, length: delimiter.length };
    } else if (marker === open.marker && delimiter.length >= open.length && !rest.trim()) {
      open = undefined;
    }
  }
  return open;
}

/** Close a code fence the character cap cut through, so the note is not read as code. */
function keepFencesClosed(markdown: string): string {
  const fence = unclosedFence(markdown);
  return fence ? `${markdown}\n${fence.marker.repeat(fence.length)}` : markdown;
}

/** Format the rendered page, extract metadata, and apply the character budget. */
function toResult(params: {
  requestedUrl: string;
  resolvedUrl: string;
  content: string;
  rendered: string;
  source: WebFetchSource;
  maxChars: number;
  inspection: PageInspection;
  representationUrl?: string;
  attempts: NonNullable<WebFetchResult["attempts"]>;
}): WebFetchResult {
  const { requestedUrl, resolvedUrl, content, rendered, source, maxChars, inspection } = params;
  const metadata = inspection.metadata;
  const completeness = inspection.completeness;
  const partial = completeness === "complete" ? false : completeness === "incomplete" ? true : null;
  const truncated = rendered.length > maxChars;
  const text = truncated
    ? `${keepFencesClosed(rendered.slice(0, maxChars))}\n\n… [truncated at ${maxChars} characters; the page is ${rendered.length}]`
    : rendered;
  return {
    requestedUrl,
    resolvedUrl,
    content: text,
    title: metadata.title,
    description: metadata.description,
    updated: metadata.updated,
    source,
    bytes: new TextEncoder().encode(content).byteLength,
    truncated,
    partial,
    assessment: inspection.assessment,
    author: metadata.author,
    published: metadata.published,
    language: metadata.language,
    representationUrl: params.representationUrl,
    attempts: params.attempts,
    fullContent: rendered,
  };
}

/** Read a character range from a captured rendering, with independently closed code fences. */
export function readCapturedPage(
  result: WebFetchResult,
  offset = 0,
  maxChars = DEFAULT_WEB_FETCH_MAX_CHARS,
): {
  result: WebFetchResult;
  offset: number;
  nextOffset?: number;
  totalChars: number;
} {
  const text = result.fullContent;
  if (text === undefined) throw new Error("This result has no captured rendering.");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= text.length)
    throw new Error("Offset is outside the captured page.");
  if (!Number.isSafeInteger(maxChars) || maxChars < 1)
    throw new Error("Page size must be a positive integer.");
  // Do not split UTF-16 surrogate pairs at either boundary.
  if (
    offset > 0 &&
    /[\uDC00-\uDFFF]/.test(text[offset]) &&
    /[\uD800-\uDBFF]/.test(text[offset - 1])
  )
    offset -= 1;
  let end = Math.min(text.length, offset + maxChars);
  if (
    end < text.length &&
    /[\uDC00-\uDFFF]/.test(text[end]) &&
    /[\uD800-\uDBFF]/.test(text[end - 1])
  )
    end += 1;
  const fence = unclosedFence(text.slice(0, offset));
  const prefix = fence ? fence.marker.repeat(fence.length) + "\n" : "";
  const content = keepFencesClosed(prefix + text.slice(offset, end));
  return {
    result: { ...result, content, truncated: end < text.length },
    offset,
    nextOffset: end < text.length ? end : undefined,
    totalChars: text.length,
  };
}

type Candidate = {
  content: string;
  inspection: PageInspection;
  resolvedUrl: string;
  representationUrl?: string;
  source: WebFetchSource;
};

/** Prefer readable article evidence, then a closed source, then additional content. */
function candidateRank(candidate: Candidate): number {
  const page = candidate.inspection;
  return (
    (page.assessment === "readable"
      ? 4_000_000
      : page.assessment === "suspected-shell"
        ? 1_000_000
        : 0) +
    (page.completeness === "complete"
      ? 2_000_000
      : page.completeness === "unknown"
        ? 1_000_000
        : 0) +
    Math.min(page.rendered.length, 999_999)
  );
}

/** A readable fragment is usable; only positive signs of a problem trigger recovery. */
function needsRecovery(candidate: Candidate): boolean {
  return (
    candidate.inspection.assessment !== "readable" ||
    candidate.inspection.completeness === "incomplete"
  );
}

/**
 * Read through Google only: inspect cache, recover live when inadequate, and try
 * one advertised same-origin article representation. Keep the best usable copy
 * if recovery fails; never splice different versions of an article together.
 */
export async function executeAntigravityWebFetch(
  options: WebFetchOptions,
): Promise<WebFetchResult> {
  const requestedUrl = validateFetchTarget(options.url);
  if (/\.pdf$/i.test(new URL(requestedUrl).pathname))
    throw new Error(
      "This tool does not support PDF content. Do not retry this URL with read_url_content. " +
        "If permitted, use an available download tool or terminal to download it directly, then read the local file with a PDF reader. " +
        "Downloading alone does not extract its text.",
    );
  const deadline = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const creds = parseApiKey(options.apiKey);
  const headers = antigravityHeaders(creds.token);
  const maxChars = resolveMaxChars(options.maxChars);
  const attempts: NonNullable<WebFetchResult["attempts"]> = [];
  let best: Candidate | undefined;
  let alternateTried = false;
  let lastError = "no endpoint available";
  const aborted = () => {
    if (options.signal?.aborted) throw new Error("Web fetch aborted");
  };
  const retain = (candidate: Candidate) => {
    if (!best || candidateRank(candidate) > candidateRank(best)) best = candidate;
  };
  const result = (candidate: Candidate) =>
    toResult({
      requestedUrl,
      resolvedUrl: candidate.resolvedUrl,
      content: candidate.content,
      rendered: options.raw ? candidate.content : candidate.inspection.rendered,
      source: candidate.source,
      maxChars,
      inspection: candidate.inspection,
      representationUrl: candidate.representationUrl,
      attempts,
    });

  for (const endpoint of endpointCandidates()) {
    aborted();
    if (deadline.aborted) break;
    const resolvedUrl =
      (await resolveRedirect(endpoint, requestedUrl, headers, signal)) ?? requestedUrl;
    aborted();
    let page: Candidate | undefined;
    let alternatePage: Candidate | undefined;
    for (const source of ["cache", "live"] as const) {
      aborted();
      if (deadline.aborted) break;
      const attempt = { url: resolvedUrl, source, outcome: "transport failed" };
      attempts.push(attempt);
      try {
        const response = await postJson(
          endpoint,
          TRAWLER_FETCH_PATH,
          headers,
          buildTrawlerFetchRequest(resolvedUrl, source === "live"),
          signal,
        );
        aborted();
        attempt.outcome = `HTTP ${response.status}`;
        if (response.status !== 200) {
          if (source === "cache" && response.status === 404) continue;
          throw fetchError(response.text, response.status, source);
        }
        const content = parseTrawlerContent(response.data);
        if (content === undefined) {
          lastError =
            "Google returned no readable article content. The response may be truncated, blocked, or a page shell.";
          continue;
        }
        const candidate: Candidate = {
          content,
          resolvedUrl,
          source,
          inspection: inspectPage(content, resolvedUrl),
        };
        attempt.outcome = `${candidate.inspection.assessment}; source ${candidate.inspection.completeness}`;
        retain(candidate);
        if (
          candidate.inspection.alternates.length &&
          (!alternatePage || candidateRank(candidate) > candidateRank(alternatePage))
        )
          alternatePage = candidate;
        if (!page || candidateRank(candidate) > candidateRank(page)) page = candidate;
        if (!needsRecovery(candidate)) return result(candidate);
      } catch (error) {
        aborted();
        if (deadline.aborted) attempt.outcome = "overall deadline exceeded";
        if (error instanceof Error && (error as { fatal?: boolean }).fatal) {
          const status = (error as { status?: number }).status;
          if (
            source === "cache" ||
            status === 401 ||
            status === 403 ||
            !best?.inspection.rendered.trim()
          )
            throw error;
        }
        lastError = safeError(error).slice(0, 400);
      }
    }
    // Raw mode means the requested page source, not a substituted representation.
    const discovery = alternatePage ?? page;
    const mdnUrl = mdnRepresentationUrl(resolvedUrl);
    const alternate =
      !options.raw && !alternateTried
        ? (discovery?.inspection.alternates[0] ??
          (mdnUrl ? { url: mdnUrl, type: "application/json" as const } : undefined))
        : undefined;
    if (alternate && discovery && !deadline.aborted) {
      alternateTried = true;
      aborted();
      const url = validateFetchTarget(alternate.url);
      try {
        // Resolve explicitly, so advertised links cannot redirect recovery to a different origin.
        const redirected = await resolveRedirect(endpoint, url, headers, signal, true);
        aborted();
        if (deadline.aborted) break;
        if (redirected && new URL(redirected).origin !== new URL(resolvedUrl).origin) {
          attempts.push({ url, source: "live", outcome: "cross-origin redirect rejected" });
        } else {
          const representationUrl = redirected ?? url;
          const response = await postJson(
            endpoint,
            TRAWLER_FETCH_PATH,
            headers,
            buildTrawlerFetchRequest(representationUrl, true),
            signal,
          );
          aborted();
          attempts.push({
            url: representationUrl,
            source: "live",
            outcome: `HTTP ${response.status}`,
          });
          if (response.status === 200) {
            const content = parseTrawlerContent(response.data);
            const mdn =
              content !== undefined && alternate.url === mdnUrl
                ? inspectMdnRepresentation(content, resolvedUrl)
                : undefined;
            const body =
              mdn?.html ??
              (content === undefined
                ? undefined
                : alternate.type === "application/json"
                  ? articleRepresentation(content, resolvedUrl)
                  : content);
            if (body?.trim()) {
              const articleUrl = mdn?.resolvedUrl ?? resolvedUrl;
              const inspection = inspectPage(body, articleUrl);
              if (mdn) inspection.completeness = mdn.completeness;
              inspection.metadata = {
                ...discovery.inspection.metadata,
                ...Object.fromEntries(
                  Object.entries(mdn?.metadata ?? {}).filter(([, value]) => value !== undefined),
                ),
                ...Object.fromEntries(
                  Object.entries(inspection.metadata).filter(([, value]) => value !== undefined),
                ),
              };
              const candidate: Candidate = {
                content: content!,
                resolvedUrl: articleUrl,
                representationUrl,
                source: "live",
                inspection,
              };
              attempts[attempts.length - 1].outcome = inspection.assessment;
              retain(candidate);
              if (!needsRecovery(candidate)) return result(candidate);
            }
          } else if (response.status === 401 || response.status === 403) {
            throw fetchError(response.text, response.status, "live");
          }
        }
      } catch (error) {
        aborted();
        if (error instanceof Error && (error as { fatal?: boolean }).fatal) throw error;
        lastError = safeError(error).slice(0, 400);
      }
    }
    // A useful partial result beats an error; recovery is bounded to this endpoint.
    if (best && (best.inspection.rendered.trim() || (options.raw && best.content.trim())))
      return result(best);
  }
  aborted();
  if (best && (best.inspection.rendered.trim() || (options.raw && best.content.trim())))
    return result(best);
  if (best && best.inspection.completeness !== "complete" && looksLikeHtml(best.content))
    return result(best);
  if (best)
    lastError =
      best.inspection.assessment === "suspected-shell"
        ? "This appears to be a JavaScript-rendered page; this tool cannot render it. Open it in a browser."
        : "Google returned no readable article content. The response may be truncated, blocked, or a page shell; try another representation or open it in a browser.";
  if (deadline.aborted)
    lastError =
      "The web fetch exceeded its overall 10-second deadline. Try again later or open the page in a browser.";
  const stages = attempts.map((attempt) => `${attempt.source}: ${attempt.outcome}`).join("; ");
  throw new Error(
    `Antigravity web fetch failed: ${lastError}${stages ? ` (Attempts: ${stages})` : ""}`,
  );
}

/**
 * Render a result as the block a model or the user reads.
 *
 * The requested URL is only printed when it differs from the source, so a redirect is
 * visible without repeating the same URL twice on ordinary pages, and an incomplete
 * crawler copy is called out rather than passed off as the whole page.
 */
export function formatWebFetchResult(result: WebFetchResult): string {
  const header = [`Title: ${result.title ?? "Untitled page"}`];
  if (result.description) header.push(`Description: ${result.description}`);
  if (result.updated) header.push(`Updated: ${result.updated}`);
  if (result.author) header.push(`Author: ${result.author}`);
  if (result.published) header.push(`Published: ${result.published}`);
  if (result.language) header.push(`Language: ${result.language}`);
  if (result.representationUrl) header.push(`Representation: ${result.representationUrl}`);
  if (result.attempts && result.attempts.length > 1) {
    header.push(
      `Retrieval: ${result.attempts.map((attempt) => `${attempt.source}: ${attempt.outcome}`).join("; ")}`,
    );
  }
  if (result.assessment && result.assessment !== "readable") {
    header.push(
      `Content assessment: ${result.assessment} (heuristic; source completeness does not establish article coverage).`,
    );
  }
  if (result.requestedUrl !== result.resolvedUrl) {
    header.push(`Requested: ${result.requestedUrl}`);
  }
  header.push(`Source: ${result.resolvedUrl} (${result.source === "live" ? "live" : "cache"})`);
  if (result.assessment === "suspected-shell") {
    header.push(
      "Note: this appears to be a JavaScript-rendered page; this tool cannot render it. Open it in a browser.",
    );
  } else if (result.partial === true) {
    header.push(
      result.content.trim()
        ? "Note: the crawler's copy ends mid-page, so some content may be missing."
        : "Note: the crawler's copy ends mid-page and holds no readable content.",
    );
  } else if (result.partial === null) {
    header.push(
      result.content.trim()
        ? "Note: the crawler's copy has no clear end marker, so completeness is unknown."
        : "Note: the crawler's copy has no clear end marker and holds no readable content.",
    );
  }
  return `${header.join("\n")}\n\n---\n\n${result.content}`;
}

export type FetchCommandArgs = {
  url: string;
  raw: boolean;
};

/** Parse `/antigravity.fetch [--raw] <url>`. */
export function parseFetchCommandArgs(args: string): FetchCommandArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  let raw = false;
  for (const token of tokens) {
    if (token === "--raw") {
      raw = true;
      continue;
    }
    rest.push(token);
  }
  return { url: rest.join(" "), raw };
}
