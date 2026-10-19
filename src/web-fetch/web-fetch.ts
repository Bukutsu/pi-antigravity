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
 *   3. The same RPC with `liveFetch: true` fetches the page now.
 *
 * The response is the page source exactly as crawled (usually raw HTML, never rendered
 * JavaScript), so callers get it converted to Markdown and capped before it reaches a
 * model's context.
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
import { extractPageMetadata, htmlToMarkdown, looksLikeHtml } from "./markdown.js";

export const REWRITE_URI_PATH = "/v1internal:rewriteUri";
export const TRAWLER_FETCH_PATH = "/v1internal:fetchFromTrawlerCache";

/** Output budget for one page, in characters. Roughly 15k tokens of prose. */
export const DEFAULT_WEB_FETCH_MAX_CHARS = 60_000;

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
  truncated: boolean;
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
function fetchError(text: string, status: number): Error {
  const message = jsonOrTextError(text).slice(0, 400) || `HTTP ${status}`;
  return Object.assign(new Error(message), { fatal: status < 500 && status !== 429 });
}

/** Ask the service where a URL really points, ignoring resolver failures. */
async function resolveRedirect(
  endpoint: string,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await postJson(
      endpoint,
      REWRITE_URI_PATH,
      headers,
      buildRewriteUriRequest(url),
      signal,
    );
    if (response.status !== 200) return undefined;
    const redirect = parseRedirectUri(response.data);
    if (!redirect || redirect === url) return undefined;
    return validateFetchTarget(redirect);
  } catch {
    // A redirect that cannot be resolved or validated is simply not followed.
    return undefined;
  }
}

/** Render fetched text the way the caller will read it: Markdown for HTML, trimmed text otherwise. */
function renderContent(value: string, raw: boolean, baseUrl: string): string {
  return !raw && looksLikeHtml(value) ? htmlToMarkdown(value, { baseUrl }) : value.trim();
}

/** Format the rendered page, extract metadata, and apply the character budget. */
function toResult(params: {
  requestedUrl: string;
  resolvedUrl: string;
  content: string;
  rendered: string;
  source: WebFetchSource;
  raw: boolean;
  maxChars: number;
}): WebFetchResult {
  const { requestedUrl, resolvedUrl, content, rendered, source, raw, maxChars } = params;
  const metadata = !raw && looksLikeHtml(content) ? extractPageMetadata(content) : {};
  const truncated = rendered.length > maxChars;
  const text = truncated
    ? `${rendered.slice(0, maxChars)}\n\n… [truncated at ${maxChars} characters; the page is ${rendered.length}]`
    : rendered;
  return {
    requestedUrl,
    resolvedUrl,
    content: text,
    title: metadata.title,
    description: metadata.description,
    updated: metadata.updated,
    source,
    bytes: content.length,
    truncated,
  };
}

/**
 * Read one page through the Antigravity fetch service.
 *
 * Endpoints are tried in order: a page the cache misses is fetched live on the same
 * endpoint, and only transport-level failures move on to the next one. Fatal client
 * errors (bad credentials, a denied URL) surface as they are.
 */
export async function executeAntigravityWebFetch(
  options: WebFetchOptions,
): Promise<WebFetchResult> {
  const requestedUrl = validateFetchTarget(options.url);
  const creds = parseApiKey(options.apiKey);
  const headers = antigravityHeaders(creds.token);
  const maxChars = resolveMaxChars(options.maxChars);
  const raw = options.raw === true;

  let lastError = "no endpoint available";

  for (const endpoint of endpointCandidates()) {
    if (options.signal?.aborted) throw new Error("Web fetch aborted");
    const resolvedUrl =
      (await resolveRedirect(endpoint, requestedUrl, headers, options.signal)) ?? requestedUrl;

    try {
      const cached = await postJson(
        endpoint,
        TRAWLER_FETCH_PATH,
        headers,
        buildTrawlerFetchRequest(resolvedUrl),
        options.signal,
      );
      let content = cached.status === 200 ? parseTrawlerContent(cached.data) : undefined;
      let rendered = content === undefined ? "" : renderContent(content, raw, resolvedUrl);
      let source: WebFetchSource = "cache";

      if (!rendered.trim()) {
        // A 404, an empty 200, and a page that renders to nothing are all cache misses; only
        // other statuses are errors.
        if (cached.status !== 404 && cached.status !== 200) {
          throw fetchError(cached.text, cached.status);
        }
        source = "live";
        const live = await postJson(
          endpoint,
          TRAWLER_FETCH_PATH,
          headers,
          buildTrawlerFetchRequest(resolvedUrl, true),
          options.signal,
        );
        if (live.status !== 200) throw fetchError(live.text, live.status);
        content = parseTrawlerContent(live.data);
        rendered = content === undefined ? "" : renderContent(content, raw, resolvedUrl);
      }

      if (content === undefined || !rendered.trim()) {
        throw new Error("The fetch service returned no content for that URL.");
      }
      return toResult({ requestedUrl, resolvedUrl, content, rendered, source, raw, maxChars });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof Error && (error as { fatal?: boolean }).fatal) throw error;
      lastError = safeError(error).slice(0, 400);
    }
  }

  throw new Error(`Antigravity web fetch failed: ${lastError}`);
}

/**
 * Render a result as the block a model or the user reads.
 *
 * The requested URL is only printed when it differs from the source, so a redirect is
 * visible without repeating the same URL twice on ordinary pages.
 */
export function formatWebFetchResult(result: WebFetchResult): string {
  const header = [`Title: ${result.title ?? "Untitled page"}`];
  if (result.description) header.push(`Description: ${result.description}`);
  if (result.updated) header.push(`Updated: ${result.updated}`);
  if (result.requestedUrl !== result.resolvedUrl) {
    header.push(`Requested: ${result.requestedUrl}`);
  }
  header.push(`Source: ${result.resolvedUrl} (${result.source === "live" ? "live" : "cache"})`);
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
