import strictAssert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
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
import { extractPageMetadata, htmlToMarkdown, isPartialCopy, looksLikeHtml } from "../src/web-fetch/index.js";

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

/** Read one saved page copy; see scripts/fixtures/web-fetch/README.md. */
function sample(name: string): string {
  const path = new URL(`./fixtures/web-fetch/${name}`, import.meta.url);
  return gunzipSync(readFileSync(path)).toString("utf8");
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

  // Navigation and footers leave even when they are nested, and a truncated copy ends
  // inside one rather than after it.
  const nested = htmlToMarkdown(
    "<html><body><nav>outer<nav>inner</nav>tail</nav><div>Keep this</div></body></html>",
  );
  assert(
    !nested.includes("outer") && !nested.includes("inner") && !nested.includes("tail"),
    `nested navigation dropped whole (got ${nested})`,
  );
  assert(nested.includes("Keep this"), "content after navigation kept");
  const cutOff = htmlToMarkdown("<html><body><nav>menu<a href='/a'>A</a>", {
    baseUrl: "https://example.com/",
  });
  assert(
    !cutOff.includes("menu") && !cutOff.includes("[A]"),
    `copy cut inside chrome drops that chrome (got ${cutOff})`,
  );

  // The page's own content region wins over the masthead and footer around it.
  const region = htmlToMarkdown(
    "<html><body><header>Site name</header><main><h1>Article</h1><p>Body text</p></main><footer>Contact</footer></body></html>",
  );
  assert(region.includes("# Article") && region.includes("Body text"), "main content kept");
  assert(
    !region.includes("Site name") && !region.includes("Contact"),
    `chrome outside main dropped (got ${region})`,
  );
  const noRegion = htmlToMarkdown(
    "<html><body><p>Plain page</p><footer>Footer text</footer></body></html>",
  );
  assert(
    noRegion.includes("Plain page") && !noRegion.includes("Footer text"),
    `pages without main still lose their chrome (got ${noRegion})`,
  );

  // Links that only wrap an image stay images, and URL labels are not repeated.
  const linkedImage = htmlToMarkdown('<a href="/page"><img src="/pic.png" alt="Pic"></a>', {
    baseUrl: "https://example.com/",
  });
  assert(linkedImage === "![Pic](https://example.com/pic.png)", `image link unwrapped (got ${linkedImage})`);
  const urlLabel = htmlToMarkdown('<a href="https://example.com/x">https://example.com/x</a>');
  assert(urlLabel === "https://example.com/x", `URL label not repeated (got ${urlLabel})`);

  // List items sit on consecutive lines instead of every other line.
  const items = htmlToMarkdown("<ul>\n<li>one</li>\n<li>two</li>\n</ul>");
  assert(items === "- one\n- two", `list items joined (got ${JSON.stringify(items)})`);

  // A table that labels its rows further down gets an empty header instead of
  // promoting a data row, and a plain table keeps its first row as the header.
  const labels = htmlToMarkdown(
    "<table><tr><td>Names</td><td>Artemis II</td></tr><tr><th>Mission type</th><td>Flyby</td></tr></table>",
  );
  assert(
    labels.includes("|  |  |") && labels.includes("| Names | Artemis II |"),
    `label tables get an empty header (got ${JSON.stringify(labels)})`,
  );
  const plainTable = htmlToMarkdown(
    "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>",
  );
  assert(
    plainTable.includes("| a | b |\n| --- | --- |\n| c | d |"),
    `plain tables keep their first row as the header (got ${JSON.stringify(plainTable)})`,
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
    assert(message.includes("holds no readable text"), `empty response explained (got ${message})`);
  }

  // 13. Content that renders to nothing is a cache miss too, and a blank live page is reported
  {
    const creds = JSON.stringify({ token: "tok", projectId: "proj" });
    const htmlOnly = "<html><body><script>nav()</script>  </body></html>";

    const blankCache = mockFetch((url, init) => {
      if (url.endsWith(":rewriteUri")) return jsonResponse(200, {});
      if (String(init.body ?? "").includes("liveFetch")) {
        return jsonResponse(200, { content: "<html><body><h1>Recovered</h1></body></html>" });
      }
      return jsonResponse(200, { content: "  \n\t " });
    });
    const recovered = await executeAntigravityWebFetch({
      apiKey: creds,
      url: "https://example.com/blank-cache",
    });
    assert(recovered.source === "live", "whitespace-only cached content falls through to live");
    assert(recovered.content.includes("# Recovered"), "live content used after blank cached content");
    assert(
      blankCache.calls.filter((call) => call.body.includes("liveFetch")).length === 1,
      "exactly one live fetch after blank cached content",
    );

    const blankEverywhere = mockFetch((url) =>
      url.endsWith(":rewriteUri")
        ? jsonResponse(200, {})
        : jsonResponse(200, { content: htmlOnly }),
    );
    let message = "";
    try {
      await executeAntigravityWebFetch({ apiKey: creds, url: "https://example.com/blank-html" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message.includes("holds no readable text"),
      `HTML that renders to nothing reported (got ${message})`,
    );
    assert(
      blankEverywhere.calls.some((call) => call.body.includes("liveFetch")),
      "HTML that renders to nothing still tries the live fetch",
    );

    const raw = await executeAntigravityWebFetch({
      apiKey: creds,
      url: "https://example.com/raw-blank-html",
      raw: true,
    });
    assert(raw.content.includes("<script>"), "raw mode still returns HTML that renders to nothing");
  }

  // 14. Representative saved pages (see scripts/fixtures/web-fetch/README.md)
  {
    // IANA registry: the table is the page, so no row may be lost or flattened.
    const ianaUrl = "https://www.iana.org/assignments/http-status-codes/http-status-codes.xhtml";
    const iana = sample("iana-http-status-codes.xhtml.gz");
    const ianaMd = htmlToMarkdown(iana, { baseUrl: ianaUrl });
    const ianaMeta = extractPageMetadata(iana);
    assert(
      ianaMeta.title === "Hypertext Transfer Protocol (HTTP) Status Code Registry",
      `IANA registry title (got ${ianaMeta.title})`,
    );
    assert(ianaMeta.updated === undefined, "no update date is invented for the IANA registry");
    assert(ianaMd.includes("| Value | Description | Reference |"), "IANA header row kept");
    assert(ianaMd.includes("| --- | --- | --- |"), "IANA table has a separator row");
    assert(ianaMd.includes("| 404 | Not Found |"), "IANA entry row kept");
    assert(ianaMd.includes("| 512-599 | Unassigned |"), "IANA trailing entry kept");
    const ianaRows = ianaMd.split("\n").filter((line) => line.startsWith("| ")).length;
    assert(ianaRows >= 76, `every IANA registry row kept (got ${ianaRows})`);
    assert(!ianaMd.includes("Domain Names"), "IANA footer navigation dropped");
    assert(!/<\/(?:td|th|tr|table|div|a)>/i.test(ianaMd), "no tags leak into the registry table");
    assert(
      ianaMd.includes("Last Updated") && ianaMd.includes("2025-09-15"),
      "IANA page date kept as content",
    );

    // Wikipedia: headings, body, and the infobox survive; site chrome does not.
    const wiki = sample("wikipedia-artemis-ii.html.gz");
    const wikiMd = htmlToMarkdown(wiki, { baseUrl: "https://en.wikipedia.org/wiki/Artemis_II" });
    const wikiMeta = extractPageMetadata(wiki);
    assert(wikiMeta.title === "Artemis II - Wikipedia", `Wikipedia title (got ${wikiMeta.title})`);
    assert(wikiMeta.updated === undefined, "no update date is invented for Wikipedia");
    assert(wikiMd.startsWith("# Artemis II"), "Wikipedia article title kept");
    assert(/^## History$/m.test(wikiMd), "Wikipedia section heading kept");
    assert(/^### Heat shield concerns$/m.test(wikiMd), "Wikipedia subsection heading kept");
    assert(
      wikiMd.includes("Post-flight inspections found areas of char loss"),
      "Wikipedia article body kept",
    );
    assert(wikiMd.includes("| Names | Artemis II"), "Wikipedia infobox label rows kept");
    assert(wikiMd.includes("| Mission type | Crewed lunar"), "Wikipedia infobox values kept");
    assert(!wikiMd.includes("Jump to content"), "Wikipedia site chrome dropped");
    assert(!wikiMd.includes("Random article"), "Wikipedia sidebar navigation dropped");
    assert(!wikiMd.includes("Toggle the table of contents"), "Wikipedia table of contents dropped");

    // MDN as the crawler stores it: a JavaScript shell with no article in it, so the
    // conversion must not invent one.
    const mdnUrl = "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status";
    const mdnShell = sample("mdn-status-shell.html.gz");
    const shellMd = htmlToMarkdown(mdnShell, { baseUrl: mdnUrl });
    const shellMeta = extractPageMetadata(mdnShell);
    assert(
      shellMeta.title === "HTTP response status codes - HTTP | MDN",
      `MDN shell title (got ${shellMeta.title})`,
    );
    assert(!/^#{1,6} /m.test(shellMd), "no article headings are invented for MDN's JavaScript shell");
    assert(
      shellMd.length < 200,
      `MDN shell carries no article text, so little is left (got ${shellMd.length} chars)`,
    );

    // MDN article HTML as a browser receives it: headings and prose convert in full.
    const mdnPage = sample("mdn-status-page.html.gz");
    const pageMd = htmlToMarkdown(mdnPage, { baseUrl: mdnUrl });
    assert(pageMd.startsWith("# HTTP response status codes"), "MDN article heading kept");
    assert(/^## Informational responses$/m.test(pageMd), "MDN section heading kept");
    assert(/^## Browser compatibility$/m.test(pageMd), "MDN late section heading kept");
    assert(pageMd.includes("100 Continue"), "MDN status code entries kept");
    assert(
      pageMd.includes("This interim response indicates that the client should continue"),
      "MDN article prose kept",
    );
    assert(!pageMd.includes("Skip to main content"), "MDN page chrome dropped");
    assert(!pageMd.includes("See all"), "MDN sidebar menus dropped");

    // NASA: navigation and footer text leave, the article stays, and the page states
    // its update date.
    const nasaUrl =
      "https://www.nasa.gov/missions/artemis/artemis-2/rigorous-analysis-confirms-nasas-artemis-ii-heat-shield-performance/";
    const nasa = sample("nasa-artemis-heat-shield.html.gz");
    const nasaMd = htmlToMarkdown(nasa, { baseUrl: nasaUrl });
    const nasaMeta = extractPageMetadata(nasa);
    assert(
      nasaMeta.title?.startsWith("Rigorous Analysis Confirms NASA") === true,
      `NASA article title (got ${nasaMeta.title})`,
    );
    assert(
      nasaMeta.updated === "2026-10-15T10:57:24-04:00",
      `NASA update date read from article metadata (got ${nasaMeta.updated})`,
    );
    assert(nasaMd.includes("# Rigorous Analysis Confirms NASA"), "NASA article heading kept");
    assert(
      nasaMd.includes("maximum velocity of 39 times the speed of sound"),
      "NASA article body kept",
    );
    assert(!nasaMd.includes("News Releases"), "NASA news menu dropped");
    assert(!nasaMd.includes("Page Last Updated"), "NASA footer meta dropped");
    assert(
      !nasaMd.includes("NASA Demonstrates Next-Generation Heat Shield Technologies"),
      "NASA related-article cards dropped",
    );
    assert(nasaMd.length < 15000, `NASA output is article content only (got ${nasaMd.length})`);
  }

  // 15. The result header shows redirects, the update date, and nothing it cannot know
  {
    const base = {
      requestedUrl: "https://example.com/start",
      resolvedUrl: "https://example.com/start",
      content: "Body",
      title: "A page",
      source: "cache" as const,
      bytes: 4,
      truncated: false,
    };
    const plain = formatWebFetchResult(base);
    assert(!plain.includes("Requested:"), "no redirect line when the URL did not change");
    assert(!plain.includes("Updated:"), "no update line when the page states no date");
    assert(
      plain.startsWith("Title: A page\nSource: https://example.com/start (cache)"),
      "plain header unchanged",
    );

    const redirected = formatWebFetchResult({
      ...base,
      resolvedUrl: "https://example.com/final",
      updated: "2026-10-15T10:57:24-04:00",
      source: "live",
    });
    assert(
      redirected.startsWith(
        "Title: A page\nUpdated: 2026-10-15T10:57:24-04:00\nRequested: https://example.com/start\nSource: https://example.com/final (live)",
      ),
      `header reports the requested and final URL (got ${redirected.split("\n").slice(0, 4).join(" | ")})`,
    );
  }

  // 16. An oversized page is cut at the cap, and the cut is stated in the result
  {
    mockFetch((url) =>
      url.endsWith(":rewriteUri")
        ? jsonResponse(200, {})
        : jsonResponse(200, { content: sample("wikipedia-artemis-ii.html.gz") }),
    );
    const result = await executeAntigravityWebFetch({
      apiKey: JSON.stringify({ token: "tok", projectId: "proj" }),
      url: "https://en.wikipedia.org/wiki/Artemis_II",
      maxChars: 4000,
    });
    assert(result.truncated, "truncation flagged");
    assert(result.content.includes("[truncated at 4000 characters;"), "note names the cap");
    assert(
      result.content.length < 4200,
      `content stays close to the cap (got ${result.content.length})`,
    );
    assert(
      result.content.startsWith("# Artemis II"),
      "the start of the page is what is kept",
    );
  }

  // 17. Chrome rules on a page written to exercise each one in isolation
  {
    const chrome = `<!doctype html>
<html lang="en"><head><title>Rules</title></head><body>
<div role="banner"><p>Banner text</p></div>
<div role="navigation"><p>Navigating text</p></div>
<aside><p>Aside text</p></aside>
<main><h1>Kept heading</h1><p>Kept body text.</p></main>
<div role="contentinfo"><p>Footer text</p></div>
</body></html>`;
    const chromeMd = htmlToMarkdown(chrome);
    assert(chromeMd.includes("Kept heading") && chromeMd.includes("Kept body text."), `the main region is kept (${JSON.stringify(chromeMd.slice(0, 120))})`);
    for (const gone of ["Banner text", "Navigating text", "Aside text", "Footer text"]) {
      assert(!chromeMd.includes(gone), `${gone} dropped as chrome`);
    }

    const hidden = '<html lang="en"><body><p aria-hidden="true">Hidden text</p><p>Visible text</p></body></html>';
    const hiddenMd = htmlToMarkdown(hidden);
    assert(hiddenMd.includes("Visible text"), "marked text kept");
    assert(!hiddenMd.includes("Hidden text"), "aria-hidden text dropped");

    const skip = htmlToMarkdown(
      '<html lang="en"><body>' +
        '<a href="#main-content" class="visually-hidden skip-button">Skip to main content</a>' +
        '<h1>Doc<a class="headerlink" href="#doc" title="Link to this heading">¶</a></h1>' +
        "<p>Body.</p></body></html>",
      { baseUrl: "https://example.com/page" },
    );
    assert(skip.includes("Doc") && skip.includes("Body."), `content kept around in-page links (${JSON.stringify(skip)})`);
    assert(!skip.includes("Skip to main content"), "skip link dropped");
    assert(/¶( |$)/m.test(skip) === false, "permalink-only label dropped");

    const language = htmlToMarkdown(
      '<html lang="en"><body><p>' +
        '<a href="/simple-en/" hreflang="en-simple">Simple English</a> ' +
        '<a href="/en/" lang="en">English</a></p></body></html>',
      { baseUrl: "https://en.wikipedia.org/wiki/Doc" },
    );
    assert(language.includes("English"), "same-language link kept");
    assert(!language.includes("Simple English"), "simple-English interlanguage link dropped");

    const roleMain = htmlToMarkdown(
      '<html lang="en"><body>' +
        "<nav><p>Menu text</p></nav>" +
        '<div role="main"><h1>Region heading</h1>' +
        '<p>Region body.</p><div role="complementary"><p>Related sidebar.</p></div></div>' +
        "<footer><p>Footer text</p></footer>" +
        "</body></html>",
    );
    assert(
      roleMain.includes("Region heading") && roleMain.includes("Region body."),
      `role=main region selected (got ${JSON.stringify(roleMain.slice(0, 120))})`,
    );
    assert(roleMain.includes("Related sidebar."), "complementary kept as content, unlike the landmarks");
    assert(!roleMain.includes("Menu text") && !roleMain.includes("Footer text"), "landmark chrome around the region dropped");
  }

  // 18. Old and niche pages: 1991 markup, SGML close tags, script strings, head-only copies
  {
    const first = sample("first-website.html.gz");
    const firstMeta = extractPageMetadata(first);
    assert(firstMeta.title === "The World Wide Web project", `first-website title (got ${firstMeta.title})`);
    assert(isPartialCopy(first) === false, "a copy that ends with </html> is not partial");
    const firstMd = htmlToMarkdown(first, { baseUrl: "http://info.cern.ch/hypertext/WWW/TheProject.html" });
    assert(/^# World Wide Web$/m.test(firstMd), `1991 H1 heading kept (${firstMd.length} chars)`);
    assert(firstMd.length > 1500, `1991 page body kept (${firstMd.length} chars)`);
    assert(
      firstMd.includes("[anonymous FTP](") || firstMd.includes("anonymous FTP"),
      "1991 page inline links kept",
    );
    assert(
      firstMd.includes("(http://info.cern.ch/hypertext/WWW/WhatIs.html)") ||
        firstMd.includes("(//info.cern.ch/hypertext/WWW/WhatIs.html)"),
      "1991 relative href resolved against the page URL",
    );

    const tldpMd = htmlToMarkdown(sample("tldp-howto.html.gz"), {
      baseUrl: "https://tldp.org/HOWTO/Unix-and-Internet-Fundamentals-HOWTO/",
    });
    assert(/^# The Unix and Internet Fundamentals HOWTO$/m.test(tldpMd), "TLDP title heading kept");
    assert(tldpMd.includes("| Revision 2.14 |"), `SGML close tags (<TD >) kept rows as a table (${tldpMd.split("\n").length} lines)`);
    assert(tldpMd.includes("| --- | --- | --- |"), "revision table separator written");
    assert(!/Revision 2\.14 Revised by/i.test(tldpMd), "revision table not left as pipe text");
    assert(tldpMd.includes("This document des"), "the truncated tail keeps its partial text");

    const javadoc = sample("javadoc-string.html.gz");
    const javadocMd = htmlToMarkdown(javadoc, {
      baseUrl: "https://docs.oracle.com/javase/8/docs/api/java/lang/String.html",
    });
    assert(javadocMd.includes("represents character strings"), "javadoc class prose kept");
    assert(javadocMd.includes("Class String"), "javadoc class docs kept");
    assert(javadocMd.includes("[Overview]("), "javadoc navigation list kept");
    assert(!/var (?:methods|tabs|allClassesLink)/.test(javadocMd), "javadoc script contents dropped");
    assert(!javadocMd.includes("Skip navigation links"), "javadoc skip link dropped");
    assert(javadocMd.length > 5000, `javadoc conversion keeps the page (got ${javadocMd.length} chars)`);
    assert(isPartialCopy(javadoc), "javadoc copy ends mid-page");

    const jam = sample("spacejam.html.gz");
    const jamMd = htmlToMarkdown(jam, { baseUrl: "https://www.spacejam.com/1996/" });
    assert(jamMd.length < 100, `a head-only layout-table fragment yields nearly nothing (got ${jamMd.length})`);
    assert(isPartialCopy(jam), "the 1996 copy cut inside a tag is partial");
    assert(extractPageMetadata(jam).title === "Space Jam", "a head-only copy still exposes its title");
  }

  // 19. Docs pages the converter previously failed outright, with copy extremes
  {
    // GitHub Docs as the crawler serves it: a body-less JS shell; report honestly.
    const gh = sample("github-docs-hello-world.html.gz");
    const ghMeta = extractPageMetadata(gh);
    assert(ghMeta.title === "Hello World - GitHub Docs", `GitHub Docs title (got ${ghMeta.title})`);
    assert(ghMeta.description?.includes("Follow this Hello World exercise") === true, "GitHub Docs description kept");
    const ghMd = htmlToMarkdown(gh);
    assert(!/^#{1,6} /m.test(ghMd), "no article headings invented for the GitHub Docs shell");
    assert(ghMd.length < 100, `GitHub Docs shell keeps only crumbs (${ghMd.length} chars)`);
    assert(isPartialCopy(gh), "GitHub Docs shell is partial");

    // RFC 9110: big standards copy; structure survives and the copy ends mid-document.
    const rfc = sample("rfc9110-excerpt.html.gz");
    const rfcMd = htmlToMarkdown(rfc, { baseUrl: "https://www.rfc-editor.org/rfc/rfc9110.html" });
    const rfcMeta = extractPageMetadata(rfc);
    assert(rfcMeta.title === "RFC 9110: HTTP Semantics", `RFC title (got ${rfcMeta.title})`);
    assert(rfcMeta.description?.startsWith("The Hypertext Transfer Protocol (HTTP) is a stateless") === true, "RFC description kept");
    assert(rfcMd.length > 50000, `RFC pages keep their bulk (${rfcMd.length} chars)`);
    assert(rfcMd.includes("Internet Engineering Task Force (IETF)"), "RFC header kept");
    assert((rfcMd.match(/^```/gm) ?? []).length % 2 === 0, "RFC code fences stay balanced");
    assert(!/^#{1,6}$/m.test(rfcMd), "no empty RFC headings");
    assert(isPartialCopy(rfc), "the RFC excerpt ends mid-document");

    // Python docs: role="main" bounds the article, navigation leaves.
    const pyUrl = "https://docs.python.org/3/library/urllib.request.html";
    const py = sample("python-urllib-request.html.gz");
    const pyMeta = extractPageMetadata(py);
    assert(pyMeta.title === "urllib.request — Extensible library for opening URLs", `Python title (got ${pyMeta.title})`);
    assert(pyMeta.description?.includes("Source code: Lib/urllib/request.py") === true, "Python description kept");
    const pyMd = htmlToMarkdown(py, { baseUrl: pyUrl });
    assert(pyMd.startsWith("# ` urllib.request `"), "Python article title kept");
    assert(pyMd.includes("module defines functions and classes which help in"), "Python article prose kept");
    assert(pyMd.includes("Changed in version 3.13"), "Python version notes kept");
    assert(!pyMd.includes("py-modindex.html"), "Python navigation links dropped");
    assert(!/<[a-z/][^>\n]*$/im.test(pyMd), "no raw tag fragment ends the Python page");
    assert(isPartialCopy(py), "the Python copy ends mid-page");

    // NIST: a Windows CMS puts carriage returns and an empty heading in the copy.
    const nist = sample("nist-sp800-53r5.html.gz");
    const nistMd = htmlToMarkdown(nist, { baseUrl: "https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final" });
    const nistMeta = extractPageMetadata(nist);
    assert(nistMeta.title === "SP 800-53 Rev. 5, Security and Privacy Controls for Information Systems and Organizations | CSRC", `NIST title (got ${nistMeta.title})`);
    assert(!nistMd.includes("\r"), "NIST carriage returns removed");
    assert(!nistMd.includes("\n\n\n"), "NIST runs of blank lines collapsed");
    assert(nistMd.length > 8000, `NIST abstract and metadata kept (${nistMd.length} chars)`);
    assert(isPartialCopy(nist) === false, "the NIST copy ran to its own close tag");
  }

  // 20. Failure messages say which stage failed, and a partial copy is a result, not an error
  {
    const creds = JSON.stringify({ token: "tok", projectId: "proj" });
    const messages: Record<string, string> = {};

    // Cache answers, then the live fetch fails.
    mockFetch((url, init) => {
      if (url.endsWith(":rewriteUri")) return jsonResponse(200, {});
      if (String(init.body ?? "").includes("liveFetch")) {
        return jsonResponse(503, { error: { message: "Internal error" } });
      }
      return jsonResponse(200, { content: "" });
    });
    try {
      await executeAntigravityWebFetch({ apiKey: creds, url: "https://example.com/live-fails" });
    } catch (error) {
      messages.live = error instanceof Error ? error.message : String(error);
    }
    assert(
      messages.live.includes("not in the crawl cache, and the live fetch failed (HTTP 503"),
      `the live failure names its stage (${messages.live})`,
    );
    assert(messages.live.includes("Try again later"), "the live failure suggests a next step");

    // The cache itself fails: a different message, and no live retry wastes time.
    mockFetch((url) =>
      url.endsWith(":rewriteUri") ? jsonResponse(200, {}) : jsonResponse(500, { error: { message: "upstream" } }),
    );
    try {
      await executeAntigravityWebFetch({ apiKey: creds, url: "https://example.com/cache-fails" });
    } catch (error) {
      messages.cache = error instanceof Error ? error.message : String(error);
    }
    assert(messages.cache.includes("cache could not answer"), `the cache failure names its stage (${messages.cache})`);
    assert(messages.cache !== messages.live, "the two failures are told apart");

    // A partial copy the cache knows: still a result, still with the note.
    mockFetch((url, init) => {
      if (url.endsWith(":rewriteUri")) return jsonResponse(200, {});
      if (String(init.body ?? "").includes("liveFetch")) {
        return jsonResponse(200, { content: sample("github-docs-hello-world.html.gz") });
      }
      return jsonResponse(404, { error: { message: "NOT_FOUND" } });
    });
    const partial = await executeAntigravityWebFetch({ apiKey: creds, url: "https://docs.github.com/" });
    assert(partial.partial === true, "result flags the partial copy");
    const partialBlock = formatWebFetchResult(partial);
    assert(
      partialBlock.includes("Note: the crawler's copy ends mid-page and holds no readable content."),
      "partial copy noted in the block",
    );

    // A partial copy with no readable content at all.
    mockFetch((url, init) => {
      if (url.endsWith(":rewriteUri")) return jsonResponse(200, {});
      if (String(init.body ?? "").includes("liveFetch")) {
        return jsonResponse(200, {
          content:
            '<html><head><title>Untitled</title><style>body{color:#000}</style></head><body bgcolor="#000" background="bg.gif" ',
        });
      }
      return jsonResponse(404, { error: { message: "NOT_FOUND" } });
    });
    const emptyPartial = await executeAntigravityWebFetch({ apiKey: creds, url: "https://example.com/bare" });
    assert(emptyPartial.partial === true, "an empty partial copy is still partial");
    assert(emptyPartial.content.trim().length === 0, `an empty partial copy has no body (got ${JSON.stringify(emptyPartial.content)})`);
    assert(
      formatWebFetchResult(emptyPartial).includes(
        "Note: the crawler's copy ends mid-page and holds no readable content.",
      ),
      "header says the copy ended before any content",
    );
  }

  // 21. Truncation closes the code fence it cuts through
  {
    const fenced = `<!doctype html>
<html lang="en"><head><title>Fences</title></head><body>
<h1>Fences</h1>
<pre>${"x".repeat(9000)}</pre>
</body></html>`;
    const rendered = htmlToMarkdown(fenced, { baseUrl: "https://example.com/fences" });
    const open = rendered.indexOf("```");
    const close = rendered.indexOf("```", open + 3);
    assert(open >= 0 && close > open + 20, `the fixture has a long fence (${open}/${close})`);
    mockFetch((url) =>
      url.endsWith(":rewriteUri") ? jsonResponse(200, {}) : jsonResponse(200, { content: fenced }),
    );
    const cut = await executeAntigravityWebFetch({
      apiKey: JSON.stringify({ token: "tok", projectId: "proj" }),
      url: "https://example.com/fences",
      maxChars: open + 10,
    });
    assert(cut.truncated, "fence fixture truncated");
    assert(
      /\n```\n\n… \[truncated at \d+ characters/.test(cut.content),
      `the cut re-closed the fence before the note (${JSON.stringify(cut.content.slice(-80))})`,
    );
  }

  console.log("web fetch: URL guards, RPC shapes, cache/live flow, markdown conversion, and caps passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
