/**
 * Read a public page through Google's Antigravity fetch service.
 *
 * This integration uses the Google-only retrieval path observed in the official `agy`
 * CLI. The crawl runs on Google's side using the account's OAuth token:
 *
 *   1. `v1internal:rewriteUri` resolves a redirect chain and reports the final URI.
 *   2. `v1internal:fetchFromTrawlerCache` answers from Google's crawl cache, and a
 *      404 there means "not cached" rather than "no such page".
 *   3. The same RPC with `liveFetch: true` retries missing or inadequate copies.
 *
 * The response is crawled source, usually HTML. Inspection preserves metadata and
 * recovery links before Markdown cleanup; output is capped before reaching a model.
 * No local HTTP client or JavaScript renderer contacts the target site. The official
 * CLI's direct-download fallback is not implemented here.
 */
import {
  antigravityHeaders,
  endpointCandidates,
  jsonOrTextError,
  parseApiKey,
} from "../client/client.js";
import { isPrivateAddress } from "../search/index.js";
import { antigravityFetch } from "../utils/http.js";
import { redactSecrets, safeError } from "../utils/security.js";
import { antigravityEnv, isRecord } from "../utils/util.js";
import { looksLikeHtml, sanitizeMetadataText } from "./markdown.js";

import { articleRepresentation, inspectPage, type PageInspection } from "./inspect.js";
import { inspectMdnRepresentation, mdnRepresentationUrl } from "./mdn.js";

export const REWRITE_URI_PATH = "/v1internal:rewriteUri";
export const TRAWLER_FETCH_PATH = "/v1internal:fetchFromTrawlerCache";

/** Output budget for one page, in characters. Roughly 15k tokens of prose. */
export const DEFAULT_WEB_FETCH_MAX_CHARS = 60_000;

/** Shared network budget, including redirects, endpoint failover, and recovery. */
export const WEB_FETCH_TIMEOUT_MS = 10_000;

/** Reject an oversized service response before parsing or retaining it. */
const MAX_RESPONSE_BYTES = 5_000_000;

/** Largest rendering retained for snapshot continuation reads. */
export const MAX_SNAPSHOT_CHARS = 2_000_000;

/** Leave room for the header and continuation footer inside the output budget. */
const OUTPUT_FOOTER_RESERVE = 512;

/** Hosts that name the local machine or a private network rather than a public site. */
const LOCAL_HOST_SUFFIXES = ["localhost", "local", "localdomain", "internal", "home.arpa"];

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
  /** Character budget used for this result, including header and footer space. */
  maxChars?: number;
  /** Uncapped rendering for bounded, in-memory continuation reads. Not model-facing. */
  fullContent?: string;
};

/**
 * Validate a target URL, returning its normalized form.
 *
 * The fetch runs on Google's machines, so a private address is not a request-forgery
 * risk here, but it can never be reached from there: rejecting it locally turns a
 * confusing remote failure into a clear message. URLs with embedded credentials are
 * refused because they would be sent to a third party. Sensitive query values are still
 * sent with the request, but are redacted from displayed output and errors.
 */
export function validateFetchTarget(raw: string): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) throw new Error("A URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Not a valid public HTTP(S) URL.");
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
    throw Object.assign(
      new Error("That URL is a private or local address, which the fetch service cannot reach."),
      { unsafeTarget: true },
    );
  }
  return parsed.toString();
}

const PDF_GUIDANCE =
  "This tool does not support PDF content. Do not retry this URL with read_url_content. " +
  "If permitted, use an available download tool or terminal to download it directly, then read the local file with a PDF reader. " +
  "Downloading alone does not extract its text.";

function pdfError(): Error {
  return Object.assign(new Error(PDF_GUIDANCE), { fatal: true, status: 415 });
}

/** ISO 32000 allows the PDF header within the first 1024 bytes of a file. */
const PDF_HEADER_WINDOW = 1_024;

function isPdfContentType(contentType?: string): boolean {
  return /^application\/pdf\b/i.test(contentType ?? "");
}

/** PDF detection is not limited to a URL suffix; inspect the returned representation too. */
function isPdfContent(content: string, contentType?: string): boolean {
  if (isPdfContentType(contentType)) return true;
  if (/^\s*%PDF-/i.test(content)) return true;
  // A file may carry a preamble before its header, but markup is never a PDF.
  const head = content.slice(0, PDF_HEADER_WINDOW);
  if (/^\s*</.test(head)) return false;
  return /%PDF-\d/.test(head);
}

/** Reject known PDF URLs with guidance for the calling agent. */
function rejectPdfUrl(url: string): void {
  if (/\.pdf$/i.test(new URL(url).pathname)) throw pdfError();
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

function firstNonEmptyText(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

/** Final URI from a rewrite response, when the request was redirected. */
export function parseRedirectUri(data: unknown): string | undefined {
  const body = unwrapResponse(data);
  if (!isRecord(body)) return undefined;
  const value = firstNonEmptyText(body.redirectUri, body.redirect_uri, body.rewrittenUri);
  return value?.trim();
}

/** Page content from a trawler response. */
export function parseTrawlerContent(data: unknown): string | undefined {
  const body = unwrapResponse(data);
  if (!isRecord(body)) return undefined;
  return firstNonEmptyText(body.content, body.markdownContent);
}

/** Explicit media type from a trawler response, when the service reports one. */
export function parseTrawlerContentType(data: unknown): string | undefined {
  const body = unwrapResponse(data);
  if (!isRecord(body)) return undefined;
  return firstNonEmptyText(body.contentType, body.content_type, body.mimeType, body.mime_type)
    ?.split(";")[0]
    .trim()
    .toLowerCase();
}

/** Character budget, from the caller or `ANTIGRAVITY_WEB_FETCH_MAX_CHARS`. */
export function resolveMaxChars(explicit?: number): number {
  if (typeof explicit === "number" && Number.isSafeInteger(Math.floor(explicit)) && explicit >= 1) {
    return Math.floor(explicit);
  }
  const configured = Number(antigravityEnv("WEB_FETCH_MAX_CHARS"));
  return Number.isSafeInteger(Math.floor(configured)) && configured >= 1
    ? Math.floor(configured)
    : DEFAULT_WEB_FETCH_MAX_CHARS;
}

type JsonPost = {
  status: number;
  data: unknown;
  text: string;
};

/** Error for a response the tool refuses to read; retrying cannot make it smaller. */
function tooLargeError(): Error {
  return Object.assign(new Error("The fetch response was too large to read safely."), {
    fatal: true,
    status: 413,
  });
}

/** Read a response without allowing an unbounded body into the parser. */
async function readResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLargeError();
  }
  const body = response.body;
  const reader = body && typeof body.getReader === "function" ? body.getReader() : undefined;
  if (!reader) {
    // A response without a readable stream has to be buffered; keep one copy of it.
    if (typeof response.arrayBuffer === "function") {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_RESPONSE_BYTES) throw tooLargeError();
      return new TextDecoder().decode(buffer);
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw tooLargeError();
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

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
  const text = await readResponseText(response);
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
  const detail = redactSecrets(jsonOrTextError(text)).slice(0, 400) || `HTTP ${status}`;
  const message =
    stage === "cache"
      ? `The crawl cache could not answer (HTTP ${status}: ${detail}).`
      : `The live fetch failed (HTTP ${status}: ${detail}). Try again later, or open the page in a browser.`;
  return Object.assign(new Error(message), { fatal: status < 500 && status !== 429, status });
}

/** Whether a validation failure names a private or local destination. */
function isUnsafeTarget(error: unknown): boolean {
  return error instanceof Error && (error as { unsafeTarget?: boolean }).unsafeTarget === true;
}

/** Resolve best-effort, but reject any unsafe destination the service reports. */
async function resolveRedirect(
  endpoint: string,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  strict = false,
): Promise<string | undefined> {
  let redirect: string | undefined;
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
    redirect = parseRedirectUri(response.data);
  } catch (error) {
    // Original-page resolution is best-effort. Alternate recovery must fail closed.
    if (strict) throw error;
  }
  if (!redirect || redirect === url) return undefined;
  let absolute: string;
  try {
    absolute = new URL(redirect, url).toString();
  } catch (error) {
    // A malformed destination says nothing about the requested page; keep reading it.
    if (strict) throw error;
    return undefined;
  }
  if (absolute === url) return undefined;
  try {
    return validateFetchTarget(absolute);
  } catch (error) {
    // An unsafe destination the service reports fails closed. A malformed or
    // unsupported target only costs the redirect, so the read continues.
    if (strict || isUnsafeTarget(error)) throw error;
    return undefined;
  }
}

const FENCE_LINE = /^ {0,3}((?:>\s*)*)(`{3,}|~{3,})(.*)$/;

/** Return an unmatched fenced-code delimiter, if the Markdown ends inside one. */
function unclosedFence(
  markdown: string,
): { marker: string; length: number; prefix: string } | undefined {
  let open: { marker: string; length: number; prefix: string } | undefined;
  for (const line of markdown.split("\n")) {
    const match = FENCE_LINE.exec(line);
    if (!match) continue;
    const prefix = match[1];
    const delimiter = match[2];
    const rest = match[3];
    const marker = delimiter[0];
    if (!open) {
      if (marker === "`" && rest.includes("`")) continue;
      open = { marker, length: delimiter.length, prefix };
    } else if (
      marker === open.marker &&
      delimiter.length >= open.length &&
      prefix === open.prefix &&
      !rest.trim()
    ) {
      open = undefined;
    }
  }
  return open;
}

/** Close a code fence the character cap cut through, so the note is not read as code. */
function keepFencesClosed(markdown: string): string {
  const fence = unclosedFence(markdown);
  return fence ? `${markdown}\n${fence.prefix}${fence.marker.repeat(fence.length)}` : markdown;
}

function splitsSurrogate(text: string, index: number): boolean {
  return (
    index > 0 &&
    index < text.length &&
    /[\uD800-\uDBFF]/.test(text[index - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[index])
  );
}

/** Move a character boundary off a surrogate pair and outside a fence delimiter line. */
function safeTruncate(text: string, end: number, start = 0): number {
  let next = Math.min(text.length, Math.max(start, end));
  if (splitsSurrogate(text, next)) next += 1;
  if (next <= start || next >= text.length) return next;
  const lineStart = text.lastIndexOf("\n", next - 1) + 1;
  const lineEndRaw = text.indexOf("\n", next);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  if (next > lineStart && next < lineEnd && FENCE_LINE.test(text.slice(lineStart, lineEnd))) {
    if (lineStart > start) return lineStart;
    // A delimiter line longer than the whole range cannot be skipped without
    // losing the range, so the budget bound wins and the fence is closed later.
    return Math.min(lineEnd < text.length ? lineEnd + 1 : text.length, next);
  }
  return next;
}

/** Move a continuation start out of the middle of a fence delimiter line. */
function safeOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= text.length) return text.length;
  let next = splitsSurrogate(text, offset) ? offset - 1 : offset;
  const lineStart = text.lastIndexOf("\n", next - 1) + 1;
  const lineEndRaw = text.indexOf("\n", next);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  if (next > lineStart && next < lineEnd && FENCE_LINE.test(text.slice(lineStart, lineEnd)))
    next = lineStart;
  return next;
}

/** Elide the middle of a long value, keeping its head and tail. */
function elideMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 1) return "…".slice(0, limit);
  const keep = limit - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** Format the page header, with bounded fields and redacted URLs. */
export function formatWebFetchHeader(result: WebFetchResult): string {
  const maxChars = result.maxChars ?? DEFAULT_WEB_FETCH_MAX_CHARS;
  // Provenance must fit inside the output budget, so a long URL cannot take it all.
  const headerBudget = Math.max(0, maxChars - OUTPUT_FOOTER_RESERVE);
  const dropped = new Set<string>();
  const build = (urlLimit: number, titleLimit: number): string[] => {
    const text = (value: string | undefined, limit: number) => sanitizeMetadataText(value, limit);
    const header = [`Title: ${text(result.title, titleLimit) ?? "Untitled page"}`];
    const add = (label: string, value: string | undefined) => {
      if (value === undefined || dropped.has(label)) return;
      header.push(`${label}: ${value}`);
    };
    add("Description", text(result.description, 1_000));
    add("Updated", text(result.updated, 100));
    add("Author", text(result.author, 300));
    add("Published", text(result.published, 100));
    add("Language", text(result.language, 50));
    const url = (value: string) =>
      elideMiddle(sanitizeMetadataText(redactSecrets(value), 4_096) ?? "", urlLimit);
    if (result.representationUrl) header.push(`Representation: ${url(result.representationUrl)}`);
    if (result.attempts && result.attempts.length > 1) {
      const attempts = result.attempts.map(
        (attempt) => `${attempt.source}: ${text(attempt.outcome, 200) ?? ""}`,
      );
      header.push(`Retrieval: ${attempts.join("; ")}`);
    }
    if (result.assessment && result.assessment !== "readable") {
      header.push(
        `Content assessment: ${result.assessment} (heuristic; source completeness does not establish article coverage).`,
      );
    }
    const requestedUrl = url(result.requestedUrl);
    const resolvedUrl = url(result.resolvedUrl);
    if (requestedUrl !== resolvedUrl) header.push(`Requested: ${requestedUrl}`);
    header.push(`Source: ${resolvedUrl} (${result.source === "live" ? "live" : "cache"})`);
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
    return header;
  };
  let urlLimit = Math.max(64, Math.min(2_048, Math.floor(headerBudget / 4)));
  let titleLimit = Math.min(300, Math.max(40, Math.floor(headerBudget / 4)));
  let header = build(urlLimit, titleLimit);
  // Optional metadata must not crowd provenance and the next captured range out.
  for (const label of ["Description", "Updated", "Author", "Published", "Language", "Retrieval"]) {
    if (header.join("\n").length + 7 <= headerBudget) break;
    dropped.add(label);
    header = build(urlLimit, titleLimit);
  }
  // A long URL must not crowd out the page content either.
  while (header.join("\n").length + 7 > headerBudget && urlLimit > 64) {
    urlLimit = Math.max(64, Math.floor(urlLimit / 2));
    titleLimit = Math.max(40, Math.floor(titleLimit / 2));
    header = build(urlLimit, titleLimit);
  }
  return `${header.join("\n")}\n\n---\n\n`;
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
  const provisional: WebFetchResult = {
    requestedUrl,
    resolvedUrl,
    content: "x",
    title: metadata.title,
    description: metadata.description,
    updated: metadata.updated,
    source,
    bytes: 0,
    truncated: false,
    partial,
    assessment: inspection.assessment,
    author: metadata.author,
    published: metadata.published,
    language: metadata.language,
    representationUrl: params.representationUrl,
    attempts: params.attempts,
    maxChars,
  };
  const contentBudget = Math.max(
    1,
    maxChars - formatWebFetchHeader(provisional).length - OUTPUT_FOOTER_RESERVE,
  );
  const truncated = rendered.length > contentBudget;
  const end = truncated ? safeTruncate(rendered, contentBudget) : rendered.length;
  const text = truncated
    ? `${keepFencesClosed(rendered.slice(0, end))}\n\n… [truncated at ${contentBudget} characters; the page is ${rendered.length}]`
    : rendered;
  return {
    ...provisional,
    content: text,
    bytes: new TextEncoder().encode(content).byteLength,
    truncated,
    fullContent: rendered.length <= MAX_SNAPSHOT_CHARS ? rendered : undefined,
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
  offset = safeOffset(text, offset);
  const end = safeTruncate(text, offset + maxChars, offset);
  const fence = unclosedFence(text.slice(0, offset));
  const prefix = fence ? fence.prefix + fence.marker.repeat(fence.length) + "\n" : "";
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
  rejectPdfUrl(requestedUrl);
  const deadline = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const creds = parseApiKey(options.apiKey);
  const headers = antigravityHeaders(creds.token);
  const maxChars = resolveMaxChars(options.maxChars);
  const attempts: NonNullable<WebFetchResult["attempts"]> = [];
  let best: Candidate | undefined;
  let lastError = "no endpoint available";
  const aborted = () => {
    if (options.signal?.aborted) throw new Error("Web fetch aborted");
  };
  const usable = (candidate: Candidate | undefined): boolean =>
    Boolean(
      candidate &&
      (candidate.inspection.rendered.trim() || (options.raw && candidate.content.trim())),
    );
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
    rejectPdfUrl(resolvedUrl);
    let page: Candidate | undefined;
    let alternatePage: Candidate | undefined;
    for (const source of ["cache", "live"] as const) {
      aborted();
      if (deadline.aborted) break;
      const attempt = {
        url: redactSecrets(resolvedUrl),
        source,
        outcome: "transport failed",
      };
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
          // The cache saying "not here" leaves the live fetch to try.
          const cacheMiss =
            source === "cache" &&
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 401 &&
            response.status !== 403 &&
            response.status !== 429;
          if (cacheMiss) continue;
          throw fetchError(response.text, response.status, source);
        }
        const contentType = parseTrawlerContentType(response.data);
        if (isPdfContentType(contentType)) throw pdfError();
        const content = parseTrawlerContent(response.data);
        if (content === undefined) {
          lastError =
            "Google returned no readable article content. The response may be truncated, blocked, or a page shell.";
          continue;
        }
        if (isPdfContent(content, contentType)) throw pdfError();
        const candidate: Candidate = {
          content,
          resolvedUrl,
          source,
          inspection: inspectPage(content, resolvedUrl, contentType),
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
          if (source === "cache" || !usable(best)) throw error;
          if (status === 401 || status === 403)
            attempt.outcome = `HTTP ${status}; retained usable copy`;
          else if (status === 415)
            attempt.outcome = "unsupported PDF content; retained usable copy";
          else if (status === 413) attempt.outcome = "response too large to read safely";
        }
        lastError = safeError(error).slice(0, 400);
      }
    }
    // Raw mode means the requested page source, not a substituted representation.
    const discovery = alternatePage ?? page;
    const mdnUrl = mdnRepresentationUrl(resolvedUrl);
    const alternate = !options.raw
      ? (discovery?.inspection.alternates[0] ??
        (mdnUrl ? { url: mdnUrl, type: "application/json" as const } : undefined))
      : undefined;
    if (alternate && discovery && !deadline.aborted) {
      aborted();
      try {
        const url = validateFetchTarget(alternate.url);
        rejectPdfUrl(url);
        // Resolve explicitly, so advertised links cannot redirect recovery to a different origin.
        const redirected = await resolveRedirect(endpoint, url, headers, signal, true);
        aborted();
        if (deadline.aborted) break;
        if (redirected && new URL(redirected).origin !== new URL(resolvedUrl).origin) {
          attempts.push({
            url: redactSecrets(url),
            source: "live",
            outcome: "cross-origin redirect rejected",
          });
        } else {
          const representationUrl = redirected ?? url;
          rejectPdfUrl(representationUrl);
          const response = await postJson(
            endpoint,
            TRAWLER_FETCH_PATH,
            headers,
            buildTrawlerFetchRequest(representationUrl, true),
            signal,
          );
          aborted();
          attempts.push({
            url: redactSecrets(representationUrl),
            source: "live",
            outcome: `HTTP ${response.status}`,
          });
          if (response.status === 200) {
            const content = parseTrawlerContent(response.data);
            if (
              content !== undefined &&
              isPdfContent(content, parseTrawlerContentType(response.data))
            )
              throw pdfError();
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
              const alternateContentType =
                alternate.type === "text/markdown" ? "text/markdown" : undefined;
              const inspection = inspectPage(body, articleUrl, alternateContentType);
              const representationLanguage =
                inspection.metadata.language ?? mdn?.metadata.language ?? alternate.language;
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
              const alternateLanguage = representationLanguage;
              const pageLanguage = discovery.inspection.metadata.language;
              if (alternateLanguage) inspection.metadata.language = alternateLanguage;
              // The alternate was chosen by base language, so the note compares the same.
              const sameLanguage =
                alternateLanguage?.split("-")[0].toLowerCase() ===
                pageLanguage?.split("-")[0].toLowerCase();
              if (alternateLanguage && pageLanguage && !sameLanguage) {
                attempts[attempts.length - 1].outcome =
                  `${inspection.assessment}; alternate language ${alternateLanguage}`;
              } else {
                attempts[attempts.length - 1].outcome = inspection.assessment;
              }
              const candidate: Candidate = {
                content: content!,
                resolvedUrl: articleUrl,
                representationUrl,
                source: "live",
                inspection,
              };
              retain(candidate);
              if (!needsRecovery(candidate)) return result(candidate);
            }
          } else if (response.status === 401 || response.status === 403) {
            lastError = safeError(fetchError(response.text, response.status, "live")).slice(0, 400);
            attempts[attempts.length - 1].outcome = `HTTP ${response.status}; retained usable copy`;
          }
        }
      } catch (error) {
        aborted();
        if (error instanceof Error && (error as { fatal?: boolean }).fatal) {
          const status = (error as { status?: number }).status;
          // An alternate representation is optional; keep a usable original on any failure.
          if (!usable(best)) throw error;
          if (status === 401 || status === 403) {
            const attempt = attempts[attempts.length - 1];
            if (attempt?.source === "live")
              attempt.outcome = `HTTP ${status}; retained usable copy`;
          }
        }
        lastError = safeError(error).slice(0, 400);
      }
    }
    // A useful partial result beats an error; recovery is bounded to this endpoint.
    if (best && usable(best)) return result(best);
  }
  aborted();
  if (best && usable(best)) return result(best);
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
    redactSecrets(
      `Antigravity web fetch failed: ${lastError}${stages ? ` (Attempts: ${stages})` : ""}`,
    ),
  );
}

/**
 * Render a result as the block a model or the user reads.
 *
 * The requested URL is only printed when it differs from the source, so a redirect is
 * visible without repeating the same URL twice on ordinary pages, and an incomplete
 * crawler copy is called out rather than passed off as the whole page.
 */
export function formatWebFetchResult(result: WebFetchResult, footer = ""): string {
  const prefix = formatWebFetchHeader(result);
  const maxChars = result.maxChars ?? DEFAULT_WEB_FETCH_MAX_CHARS;
  const available = maxChars - prefix.length - footer.length;
  if (available < 1)
    throw new Error(
      "The character budget is too small for page provenance. Increase ANTIGRAVITY_WEB_FETCH_MAX_CHARS.",
    );
  if (result.content.length <= available) return prefix + result.content + footer;

  const note = `\n\n… [output truncated at ${maxChars} characters]`;
  let end = Math.max(0, available - note.length);
  for (;;) {
    if (splitsSurrogate(result.content, end)) end -= 1;
    const boundary = safeTruncate(result.content, end);
    // A delimiter line larger than the budget cannot be included in this output.
    end = boundary > end ? result.content.lastIndexOf("\n", end - 1) + 1 : boundary;
    const body = keepFencesClosed(result.content.slice(0, end)) + note;
    if (body.length <= available) return prefix + body + footer;
    if (end === 0) return prefix + note.slice(0, available) + footer;
    end = Math.max(0, end - (body.length - available));
  }
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
