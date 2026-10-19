import strictAssert from "node:assert/strict";
import {
  buildRewriteUriRequest,
  buildTrawlerFetchRequest,
  DEFAULT_WEB_FETCH_MAX_CHARS,
  executeAntigravityWebFetch,
  formatWebFetchResult,
  parseFetchCommandArgs,
  parseRedirectUri,
  parseTrawlerContent,
  resolveMaxChars,
  validateFetchTarget,
} from "../src/web-fetch/index.js";
import { extractPageMetadata, htmlToMarkdown, looksLikeHtml } from "../src/web-fetch/index.js";

/** Abort the run with a message. */
function fail(message: string): never {
  throw new Error(message);
}

/** Fail the run when an assertion does not hold. */
function assert(condition: unknown, message: string): void {
  if (!condition) fail(`FAILED: ${message}`);
}

const ARTICLE = `<!doctype html>
<html><head>
<title>Fallback title</title>
<meta property="og:title" content="Real Title">
<meta name="description" content="A page about crawlers &amp; caches">
<script>window.evil = "</scr" + "ipt>";</script>
<style>body { color: red }</style>
</head>
<body>
<h1>Heading One</h1>
<p>Intro paragraph with a <a href="/docs/guide.html">relative link</a> and <strong>bold</strong> text.</p>
<pre><code>const x = 1;
if (a &lt; b) { go(); }</code></pre>
<ul><li>first item</li><li>second item</li></ul>
<table><tr><th>Name</th><th>Value</th></tr><tr><td>alpha</td><td>1</td></tr></table>
<img src="https://cdn.example.com/pic.png" alt="A picture">
</body></html>`;

/** Response helper for the mocked transport. */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Install a fetch double, returning the recorded request log. */
function mockFetch(
  handler: (url: string, init: RequestInit) => Response,
): { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { calls };
}

/** Cover URL guards, the two RPC shapes, cache and live paths, and HTML conversion. */
async function main() {
  // 1. URL validation
  assert(
    validateFetchTarget("  https://example.com/a?b=1#c  ") === "https://example.com/a?b=1#c",
    "public https URL normalized",
  );
  assert(validateFetchTarget("http://example.com") === "http://example.com/", "http URL allowed");
  for (const bad of ["", "   ", "not a url", "ftp://example.com", "file:///etc/passwd"]) {
    let threw = false;
    try {
      validateFetchTarget(bad);
    } catch {
      threw = true;
    }
    assert(threw, `rejects ${JSON.stringify(bad)}`);
  }
  for (const local of [
    "http://localhost:3000/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.0.1/",
    "http://10.0.0.5/admin",
    "http://printer.local/",
    "http://service.internal/",
    "https://user:pass@example.com/",
  ]) {
    let message = "";
    try {
      validateFetchTarget(local);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.length > 0, `rejects ${local} (${message})`);
  }

  // 2. Request shapes match the official CLI wire traffic
  strictAssert.deepEqual(buildRewriteUriRequest("https://example.com/"), {
    originalUri: "https://example.com/",
  });
  strictAssert.deepEqual(buildTrawlerFetchRequest("https://example.com/"), {
    url: "https://example.com/",
  });
  strictAssert.deepEqual(buildTrawlerFetchRequest("https://example.com/", true), {
    url: "https://example.com/",
    liveFetch: true,
  });

  // 3. Response parsing
  assert(parseRedirectUri({ redirectUri: "https://example.com/real" }) === "https://example.com/real", "redirectUri");
  assert(
    parseRedirectUri({ response: { redirect_uri: "https://example.com/snake" } }) ===
      "https://example.com/snake",
    "snake_case redirect under response wrapper",
  );
  assert(parseRedirectUri({}) === undefined, "empty rewrite response means no redirect");
  assert(parseTrawlerContent({ content: "<p>hi</p>" }) === "<p>hi</p>", "content parsed");
  assert(parseTrawlerContent({ content: "" }) === undefined, "empty content is a miss");
  assert(parseTrawlerContent({ error: { code: 404 } }) === undefined, "error body has no content");

  // 4. Budget
  assert(resolveMaxChars(undefined) === DEFAULT_WEB_FETCH_MAX_CHARS, "default budget");
  assert(resolveMaxChars(120) === 120, "explicit budget wins");
  process.env.ANTIGRAVITY_WEB_FETCH_MAX_CHARS = "4321";
  assert(resolveMaxChars() === 4321, "env budget honoured");
  assert(resolveMaxChars(99) === 99, "explicit budget beats env");
  process.env.ANTIGRAVITY_WEB_FETCH_MAX_CHARS = "nonsense";
  assert(resolveMaxChars() === DEFAULT_WEB_FETCH_MAX_CHARS, "bad env falls back");
  delete process.env.ANTIGRAVITY_WEB_FETCH_MAX_CHARS;

  // 5. Command parsing
  strictAssert.deepEqual(parseFetchCommandArgs("--raw https://example.com/x"), {
    url: "https://example.com/x",
    raw: true,
  });
  strictAssert.deepEqual(parseFetchCommandArgs("https://example.com/x"), {
    url: "https://example.com/x",
    raw: false,
  });
  strictAssert.deepEqual(parseFetchCommandArgs(""), { url: "", raw: false });

  // 6. HTML to markdown
  assert(looksLikeHtml(ARTICLE), "document detected as HTML");
  assert(!looksLikeHtml("plain text with <angle> brackets"), "plain text is not HTML");
  const meta = extractPageMetadata(ARTICLE);
  assert(meta.title === "Real Title", `og:title wins (got ${meta.title})`);
  assert(meta.description === "A page about crawlers & caches", "entities decoded in description");
  const markdown = htmlToMarkdown(ARTICLE, { baseUrl: "https://example.com/post/" });
  assert(markdown.includes("# Heading One"), "heading converted");
  assert(!markdown.includes("window.evil"), "scripts dropped");
  assert(!markdown.includes("color: red"), "styles dropped");
  assert(
    markdown.includes("[relative link](https://example.com/docs/guide.html)"),
    `relative link made absolute (in: ${markdown.slice(0, 400)})`,
  );
  assert(markdown.includes("**bold**"), "strong converted");
  assert(markdown.includes("```\nconst x = 1;"), "pre converted to a fence");
  assert(markdown.includes("if (a < b) { go(); }"), "code entities decoded inside the fence");
  assert(markdown.includes("- first item"), "list items converted");
  assert(markdown.includes("| Name | Value |"), "table header row converted");
  assert(markdown.includes("![A picture](https://cdn.example.com/pic.png)"), "image kept");
  assert(!markdown.includes("<p>") && !markdown.includes("</"), "no tags survive");
  assert(
    extractPageMetadata("<html><head><title>Only title</title></head></html>").title === "Only title",
    "title tag is the fallback",
  );

  // Entities outside the Unicode range must survive instead of throwing.
  const malformed = htmlToMarkdown("<p>kept &#999999999; and &#x110000; but &#65; decodes</p>");
  assert(malformed.includes("&#999999999;"), `huge decimal entity kept (got ${malformed})`);
  assert(malformed.includes("&#x110000;"), `huge hex entity kept (got ${malformed})`);
  assert(malformed.includes("A decodes"), "valid entity still decoded");
  assert(
    extractPageMetadata("<title>Weird &#99999999; title</title>").title === "Weird &#99999999; title",
    "malformed entity in metadata does not throw",
  );

  // Dollar patterns in code must stay literal when the fence is restored.
  const dollars = htmlToMarkdown("<pre>echo $$ and $& and $' end</pre>");
  assert(dollars.includes("echo $$ and $& and $' end"), `dollar patterns survive (got ${dollars})`);

  // Images escape their label and encode their destination like links do.
  const image = htmlToMarkdown(
    '<img src="/img/logo (1).png" alt="Logo [v2] &amp; more">',
    { baseUrl: "https://example.com/page/" },
  );
  assert(
    image.includes("![Logo \\[v2\\] & more](https://example.com/img/logo%20(1%29.png)"),
    `image label and destination escaped (got ${image})`,
  );

  // 7. Cache hit: one RPC, no live fetch
  {
    const { calls } = mockFetch((url) =>
      url.endsWith(":rewriteUri")
        ? jsonResponse(200, {})
        : jsonResponse(200, { content: ARTICLE }),
    );
    const result = await executeAntigravityWebFetch({
      apiKey: JSON.stringify({ token: "tok", projectId: "proj" }),
      url: "https://example.com/post/",
    });
    assert(result.source === "cache", "cache hit reported");
    assert(result.resolvedUrl === "https://example.com/post/", "resolved URL kept");
    assert(result.title === "Real Title", "title from metadata");
    assert(result.content.includes("# Heading One"), "markdown returned");
    const trawlerCalls = calls.filter((call) => call.url.includes("fetchFromTrawlerCache"));
    assert(trawlerCalls.length === 1, "cache miss path does not run a live fetch");
    assert(
      trawlerCalls[0]?.body === '{"url":"https://example.com/post/"}',
      `trawler request body shape (got ${trawlerCalls[0]?.body})`,
    );
    assert(
      calls.some((call) => call.url.endsWith("/v1internal:rewriteUri") && call.body === '{"originalUri":"https://example.com/post/"}'),
      "redirect resolver called first",
    );
    const rendered = formatWebFetchResult(result);
    assert(rendered.startsWith("Title: Real Title\nDescription: A page about crawlers & caches\nSource: https://example.com/post/ (cache)"), "header order");
  }

  // 8. Redirect then cache miss then live fetch
  {
    const { calls } = mockFetch((url, init) => {
      if (url.endsWith(":rewriteUri")) return jsonResponse(200, { redirectUri: "https://example.com/final" });
      const body = String(init.body ?? "");
      if (body.includes("liveFetch")) return jsonResponse(200, { content: "<html><body><h1>Live</h1></body></html>" });
      return jsonResponse(404, { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } });
    });
    const result = await executeAntigravityWebFetch({
      apiKey: JSON.stringify({ token: "tok", projectId: "proj" }),
      url: "https://example.com/start",
    });
    assert(result.source === "live", "live fetch used after the cache 404");
    assert(result.resolvedUrl === "https://example.com/final", "redirect followed");
    assert(result.requestedUrl === "https://example.com/start", "original URL kept for the caller");
    assert(result.content.includes("# Live"), "live content converted");
    const liveCalls = calls.filter((call) => call.body.includes("liveFetch"));
    assert(liveCalls.length === 1, "exactly one live fetch");
    assert(liveCalls[0]?.body.includes('"url":"https://example.com/final"'), "live fetch targets the redirect");
  }

  // 9. Fatal client errors are not retried across endpoints
  {
    const { calls } = mockFetch(() =>
      jsonResponse(403, { error: { code: 403, message: "PERMISSION_DENIED: no access" } }),
    );
    let message = "";
    try {
      await executeAntigravityWebFetch({
        apiKey: JSON.stringify({ token: "tok", projectId: "proj" }),
        url: "https://example.com/denied",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("PERMISSION_DENIED"), `backend message surfaced (got ${message})`);
    assert(calls.length === 2, "no endpoint retry after a fatal error");
  }

  // 10. Truncation, and raw mode keeping the crawled source
  {
    const long = `<html><head><title>Long</title></head><body><p>${"x".repeat(500)}</p></body></html>`;
    mockFetch((url) => (url.endsWith(":rewriteUri") ? jsonResponse(200, {}) : jsonResponse(200, { content: long })));
    const result = await executeAntigravityWebFetch({
      apiKey: JSON.stringify({ token: "tok", projectId: "proj" }),
      url: "https://example.com/long",
      maxChars: 120,
    });
    assert(result.truncated, "truncation flagged");
    assert(result.content.includes("[truncated at 120 characters"), "truncation note present");
    assert(result.content.length < 300, "content capped");

    const raw = await executeAntigravityWebFetch({
      apiKey: JSON.stringify({ token: "tok", projectId: "proj" }),
      url: "https://example.com/long",
      raw: true,
    });
    assert(raw.content.startsWith("<html>"), "raw mode returns the crawled source");

    // A page the crawler already served as markdown is passed through untouched.
    mockFetch((url) =>
      url.endsWith(":rewriteUri") ? jsonResponse(200, {}) : jsonResponse(200, { content: "# Docs\n\nText" }),
    );
    const markdownPage = await executeAntigravityWebFetch({
      apiKey: JSON.stringify({ token: "tok", projectId: "proj" }),
      url: "https://example.com/docs",
    });
    assert(markdownPage.content === "# Docs\n\nText", "already-markdown content preserved");
    assert(markdownPage.bytes === 12, "byte count reported");
  }

  // 11. Credentials are required
  {
    let message = "";
    try {
      await executeAntigravityWebFetch({ url: "https://example.com/" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("/login antigravity"), `missing credentials rejected (${message})`);
  }

  // 12. A 200 with no content is a cache miss, and a live fetch that is also empty reports why
  {
    const { calls } = mockFetch((url, init) => {
      if (url.endsWith(":rewriteUri")) return jsonResponse(200, {});
      if (String(init.body ?? "").includes("liveFetch")) {
        return jsonResponse(200, { content: "<html><body><h1>Recovered</h1></body></html>" });
      }
      return jsonResponse(200, { content: "" });
    });
    const result = await executeAntigravityWebFetch({
      apiKey: JSON.stringify({ token: "tok", projectId: "proj" }),
      url: "https://example.com/empty-cache",
    });
    assert(result.source === "live", "empty cached content falls through to the live fetch");
    assert(result.content.includes("# Recovered"), "live content used after the empty cache entry");
    assert(
      calls.filter((call) => call.body.includes("liveFetch")).length === 1,
      "exactly one live fetch after an empty cache entry",
    );

    mockFetch((url) =>
      url.endsWith(":rewriteUri") ? jsonResponse(200, {}) : jsonResponse(200, { content: "" }),
    );
    let message = "";
    try {
      await executeAntigravityWebFetch({
        apiKey: JSON.stringify({ token: "tok", projectId: "proj" }),
        url: "https://example.com/nothing",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("returned no content"), `empty response explained (got ${message})`);
  }

  console.log("web fetch: URL guards, RPC shapes, cache/live flow, markdown conversion, and caps passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
