/**
 * End-to-end test for the `read_url_content` tool.
 *
 * One flow: the real tool is registered, a mocked Google fetch service answers
 * the two RPCs the tool uses, and every scenario is checked through the output
 * the model receives — the header, the page text, the details, or the error.
 *
 * The suite is hermetic: it pins the service base URL, the character budget, and
 * the tool toggles, so an ambient environment cannot change the result.
 */
import strictAssert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFetch from "../src/features/read-url-content.js";
import { isPrivateAddress } from "../src/search/index.js";

const ENV_NAMES = [
  "ANTIGRAVITY_WEB_FETCH_MAX_CHARS",
  "NOAGY_WEB_FETCH_MAX_CHARS",
  "ANTIGRAVITY_BASE_URL",
  "NOAGY_BASE_URL",
  "ANTIGRAVITY_NO_EXTRA_TOOLS",
  "NOAGY_NO_EXTRA_TOOLS",
  "ANTIGRAVITY_NO_FETCH_TOOL",
  "NOAGY_NO_FETCH_TOOL",
];

type ServiceCall = { url: string; body: Record<string, unknown> };
type Handler = (body: Record<string, unknown>, url: string) => Response;

const calls: ServiceCall[] = [];
let handler: Handler = () => json({});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A complete, readable page. */
function article(body: string, extra = "", lang = "en"): string {
  return (
    `<!doctype html><html lang="${lang}"><head><title>Test page</title>${extra}</head>` +
    `<body><main><h1>Test page</h1><p>${body}</p></main></body></html>`
  );
}

/** The same page with its end cut off, so the tool looks for a better copy. */
function cutArticle(body: string, extra = "", lang = "en"): string {
  return (
    `<!doctype html><html lang="${lang}"><head><title>Test page</title>${extra}</head>` +
    `<body><main><h1>Test page</h1><p>${body}</p>`
  );
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ url, body });
  return handler(body, url);
}) as typeof fetch;

// --- the tool under test -----------------------------------------------------

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};

let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
registerFetch({
  registerTool(definition) {
    tool = definition;
  },
  on() {
    // Session hooks only clear captures; the suite drives them directly.
  },
} as unknown as ExtensionAPI);
strictAssert.ok(tool, "the read_url_content tool must register");

const apiKey = JSON.stringify({ token: "ya29.fixture-token", projectId: "fixture-project" });
const context = {
  modelRegistry: {
    async getApiKeyForProvider() {
      return apiKey;
    },
  },
} as unknown as Parameters<NonNullable<typeof tool>["execute"]>[4];

type RunOptions = {
  /** Progress messages the tool emitted. */
  updates?: string[];
  /** Character budget for this call. */
  maxChars?: number;
  /** Read a captured page instead of a URL. */
  snapshot?: string;
  offset?: number;
};

async function read(url: string, options: RunOptions = {}): Promise<ToolResult> {
  const updates = options.updates ?? [];
  // The budget stays as the scenario set it, so a continuation matches its first range.
  if (options.maxChars !== undefined)
    process.env.ANTIGRAVITY_WEB_FETCH_MAX_CHARS = String(options.maxChars);
  const params = options.snapshot
    ? { snapshot: options.snapshot, offset: options.offset }
    : { url };
  const result = await tool!.execute(
    "call",
    params,
    undefined,
    (update) => updates.push(JSON.stringify(update)),
    context,
  );
  return result as unknown as ToolResult;
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** The page body, without the provenance header and the continuation footer. */
function bodyOf(result: ToolResult): string {
  const text = textOf(result);
  const separator = text.indexOf("\n\n---\n\n");
  const body = separator < 0 ? text : text.slice(separator + 7);
  const trailer = body.lastIndexOf("\n\nSnapshot:");
  return trailer < 0 ? body : body.slice(0, trailer);
}

function attemptsOf(result: ToolResult): string[] {
  return ((result.details.attempts as Array<{ outcome: string }>) ?? []).map(
    (attempt) => attempt.outcome,
  );
}

// --- scenarios ----------------------------------------------------------------

/** The tool refuses unsafe targets before it asks the service for anything. */
async function scenarioGuards(): Promise<void> {
  calls.length = 0;
  for (const url of [
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://[::1]/",
    "http://localhost/",
    "ftp://example.com/x",
    "https://user:supersecret@example.com/",
  ]) {
    await strictAssert.rejects(read(url), /private or local|Only http and https|credentials/);
  }
  strictAssert.equal(calls.length, 0, "a refused target must not reach the service");
  // A zone-scoped address is a local address; the scope does not make it public.
  strictAssert.equal(isPrivateAddress("fe80::1%eth0"), true);
  strictAssert.equal(isPrivateAddress("2606:4700::1111%eth0"), false);
}

/** A readable page arrives as markdown, with provenance, and continues offline. */
async function scenarioReadablePage(): Promise<void> {
  const body = "The quick brown fox jumps over the lazy dog. ".repeat(200).trim();
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri") ? json({}) : json({ content: article(body) });
  const updates: string[] = [];
  const first = await read("https://example.com/page", { updates, maxChars: 1_000 });
  const text = textOf(first);
  strictAssert.ok(text.includes("Title: Test page"), "the header names the page");
  strictAssert.ok(
    text.includes("Source: https://example.com/page (cache)"),
    "the header cites the source",
  );
  strictAssert.equal(
    text.split("\n").filter((line) => line.startsWith("Source: ")).length,
    1,
    "metadata must not forge a second source line",
  );
  strictAssert.ok(text.length <= 1_000, `output length ${text.length}`);
  strictAssert.equal(first.details.source, "cache");
  strictAssert.equal(first.details.truncated, true);
  strictAssert.ok(first.details.snapshot, "a long page is captured for continuation");

  // The captured page continues without another request or another credential read.
  const requestCount = calls.length;
  let combined = bodyOf(first);
  let offset = first.details.nextOffset as number | undefined;
  while (offset !== undefined) {
    const next = await read("", { snapshot: first.details.snapshot as string, offset });
    strictAssert.ok(textOf(next).length <= 1_000, "each range shares the budget");
    combined += bodyOf(next);
    offset = next.details.nextOffset as number | undefined;
  }
  strictAssert.equal(combined, `# Test page\n\n${body}`, "the ranges must reassemble the page");
  strictAssert.equal(calls.length, requestCount, "a continuation must not refetch");
}

/** A redirect is followed when it is usable, and refused when it is not. */
async function scenarioRedirects(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({ redirectUri: "/moved" })
      : json({ content: article("Moved content.") });
  const moved = await read("https://example.com/page");
  strictAssert.ok(textOf(moved).includes("Source: https://example.com/moved (cache)"));

  // A malformed or unsupported destination says nothing about the requested page.
  for (const redirectUri of ["https://exa mple.com/page", "ftp://example.com/page"]) {
    calls.length = 0;
    handler = (_body, url) =>
      url.endsWith(":rewriteUri") ? json({ redirectUri }) : json({ content: article("Readable.") });
    const kept = await read("https://example.com/page");
    strictAssert.ok(bodyOf(kept).includes("Readable."));
    strictAssert.ok(textOf(kept).includes("Source: https://example.com/page (cache)"));
  }

  // A private destination fails closed, before the page is requested.
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri") ? json({ redirectUri: "http://127.0.0.1/" }) : json({});
  await strictAssert.rejects(read("https://example.com/page"), /private or local/);
  strictAssert.equal(calls.length, 1, "only the redirect lookup may happen");
}

/** A wall or a script shell is recovered live instead of being handed over. */
async function scenarioRecovery(): Promise<void> {
  const wall =
    "<!doctype html><html><head><title>Example</title></head><body><main>" +
    "<h1>Please enable JavaScript to continue</h1>" +
    "<p>Checking your browser before accessing example.com.</p></main></body></html>";
  calls.length = 0;
  handler = (body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({ content: body.liveFetch ? article("The real article.") : wall });
  const recovered = await read("https://example.com/page");
  strictAssert.ok(bodyOf(recovered).includes("The real article."));
  strictAssert.equal(recovered.details.source, "live");

  const shell =
    "<!doctype html><html><head><title>App</title></head><body><div id=\"root\"></div>" +
    "<script src=\"/app.js\"></script><p>Loading…</p></body></html>";
  calls.length = 0;
  handler = (body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({ content: body.liveFetch ? article("The real article.") : shell });
  const recoveredShell = await read("https://example.com/app");
  strictAssert.ok(bodyOf(recoveredShell).includes("The real article."));
  strictAssert.equal(recoveredShell.details.source, "live");
}

/** A page about a status code is an article, not an access wall. */
async function scenarioStatusArticle(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({
          content:
            "<!doctype html><html><head><title>429 Too Many Requests - HTTP | MDN</title></head>" +
            "<body><main><h1>429 Too Many Requests</h1>" +
            "<p>The client has sent too many requests in a given amount of time.</p>" +
            "</main></body></html>",
        });
  const article = await read("https://example.com/429");
  strictAssert.equal(article.details.assessment, "readable");
  strictAssert.ok(bodyOf(article).includes("too many requests in a given amount of time"));
}

/** A PDF is refused with guidance, however the service presents it. */
async function scenarioPdf(): Promise<void> {
  for (const respond of [
    () => json({ content: "preamble%PDF-1.7\nbinary" }),
    () => json({ content: "", contentType: "application/pdf" }),
  ]) {
    calls.length = 0;
    handler = (_body, url) => (url.endsWith(":rewriteUri") ? json({}) : respond());
    await strictAssert.rejects(
      read("https://example.com/download"),
      /does not support PDF content/,
    );
  }
  await strictAssert.rejects(read("https://example.com/paper.pdf"), /does not support PDF content/);

  // A live PDF behind a usable cached copy keeps the copy and says what happened.
  calls.length = 0;
  handler = (body, url) => {
    if (url.endsWith(":rewriteUri")) return json({});
    if (body.liveFetch) return json({ content: "%PDF-1.7\nbinary" });
    return json({ content: cutArticle("Cached article.") });
  };
  const retained = await read("https://example.com/download");
  strictAssert.ok(bodyOf(retained).includes("Cached article."));
  strictAssert.ok(
    attemptsOf(retained).some((outcome) => /unsupported PDF/.test(outcome)),
    "the attempt must not claim a plain HTTP 200",
  );
}

/** The advertised representation is used, and only the supported ones. */
async function scenarioAlternate(): Promise<void> {
  const links =
    '<link rel="alternate" type="text/markdown" href="/paper.pdf">' +
    '<link rel="alternate" type="text/markdown" href="/a.md" hreflang="en">';
  calls.length = 0;
  handler = (body, url) => {
    if (url.endsWith(":rewriteUri")) return json({});
    if (body.url === "https://example.com/a.md")
      return json({ content: "# Alternate\n\nThe alternate article." });
    return json({ content: cutArticle("Original article.", links, "en-US") });
  };
  const alternate = await read("https://example.com/page");
  strictAssert.ok(bodyOf(alternate).includes("The alternate article."));
  strictAssert.equal(alternate.details.representationUrl, "https://example.com/a.md");
  strictAssert.ok(
    !calls.some((call) => call.body.url === "https://example.com/paper.pdf"),
    "a PDF alternate is not fetched",
  );
  strictAssert.ok(
    !attemptsOf(alternate).some((outcome) => /alternate language/.test(outcome)),
    "a same-language representation is not a language mismatch",
  );
}

/** A later endpoint may still use the advertised representation. */
async function scenarioAlternateOnSecondEndpoint(): Promise<void> {
  delete process.env.ANTIGRAVITY_BASE_URL;
  const links = '<link rel="alternate" type="text/markdown" href="/a.md">';
  // The page itself holds no text, so the tool has to use the representation.
  const empty = `<!doctype html><html lang="en"><head><title>Test page</title>${links}</head><body><main>`;
  calls.length = 0;
  handler = (body, url) => {
    if (url.endsWith(":rewriteUri")) return json({});
    if (body.url === "https://example.com/a.md") {
      // The first endpoint cannot serve it; a later one can.
      if (url.includes("daily-cloudcode-pa.googleapis.com")) return json({ error: {} }, 500);
      return json({ content: "# Alternate\n\nRecovered on a later endpoint." });
    }
    return json({ content: empty });
  };
  try {
    const result = await read("https://example.com/page");
    strictAssert.ok(bodyOf(result).includes("Recovered on a later endpoint."));
  } finally {
    process.env.ANTIGRAVITY_BASE_URL = "https://mock.googleapis.com";
  }
}

/** The cache saying "not here" leaves the live fetch to try. */
async function scenarioCacheMiss(): Promise<void> {
  calls.length = 0;
  handler = (body, url) => {
    if (url.endsWith(":rewriteUri")) return json({});
    if (body.liveFetch) return json({ content: article("Live article.") });
    return json({ error: { message: "gone" } }, 410);
  };
  const live = await read("https://example.com/page");
  strictAssert.ok(bodyOf(live).includes("Live article."));
  strictAssert.equal(live.details.source, "live");
}

/** Secrets in the URL never reach the model. */
async function scenarioSecrets(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri") ? json({}) : json({ content: article("ok") });
  const updates: string[] = [];
  const result = await read(
    "https://example.com/page?code=AUTHCODE&foo=ya29.TOKENSECRET#code=FRAGSECRET",
    { updates },
  );
  const visible = `${updates.join("")}\n${textOf(result)}\n${JSON.stringify(result.details)}`;
  strictAssert.ok(!visible.includes("AUTHCODE"), "an authorization code must be redacted");
  strictAssert.ok(!visible.includes("ya29.TOKENSECRET"), "a token must be redacted");
  strictAssert.ok(!visible.includes("FRAGSECRET"), "a fragment secret must be redacted");
  strictAssert.ok(visible.includes("[redacted]"));
}

/** A long URL cannot take the whole budget away from the page. */
async function scenarioBudget(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri") ? json({}) : json({ content: article("Body.") });
  const long = `https://example.com/page?${"q=abcdefghij".repeat(150)}`;
  const result = await read(long, { maxChars: 1_000 });
  const text = textOf(result);
  strictAssert.ok(text.length <= 1_000, `output length ${text.length}`);
  strictAssert.ok(text.includes("Source: https://example.com/page"), "the source stays readable");
  strictAssert.ok(bodyOf(result).includes("Body."), "the page still reaches the model");
}

/** A code fence longer than the range cannot push the output over the budget. */
async function scenarioLongFence(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({ content: "```js " + "y".repeat(3_000) + "\nThe rest of the page.\n" });
  const result = await read("https://example.com/code", { maxChars: 1_000 });
  strictAssert.ok(textOf(result).length <= 1_000, "a long fence stays inside the budget");
}

/** Markup that is a page is read as a page; prose that mentions a tag is not. */
async function scenarioDetection(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({ content: '<a href="/a">A</a> <img src="/i.png"> <span>x</span> <b>y</b>' });
  const fragment = await read("https://example.com/fragment");
  strictAssert.ok(!bodyOf(fragment).includes("<a href"), "an inline fragment is markup, not text");
  strictAssert.ok(bodyOf(fragment).includes("A"));

  // A fragment that starts with an image is markup too.
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({ content: '<img src="/i.png">A caption.' });
  const image = await read("https://example.com/image");
  strictAssert.ok(!bodyOf(image).includes("<img"), "a fragment with an image is markup, not text");
  strictAssert.ok(bodyOf(image).includes("A caption."));

  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({ content: "<p> is the paragraph element, closed by </p>." });
  const prose = await read("https://example.com/prose");
  strictAssert.ok(
    bodyOf(prose).includes("<p> is the paragraph element"),
    "prose that starts with a tag is not markup",
  );

  // A comment in a style attribute must not hide the declaration behind it.
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({
          content:
            "<!doctype html><html><body><main>" +
            "<p>Visible text</p>" +
            '<p style="/*x*/display:none">Hidden text</p>' +
            '<p style="display:none">Also hidden</p>' +
            "</main></body></html>",
        });
  const hidden = await read("https://example.com/hidden");
  strictAssert.ok(bodyOf(hidden).includes("Visible text"));
  strictAssert.ok(!bodyOf(hidden).includes("Hidden text"));
  strictAssert.ok(!bodyOf(hidden).includes("Also hidden"));
}

/** A copy that ends before the content is cut off, not an application shell. */
async function scenarioTruncatedCopy(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({
          content:
            '<!doctype html><html><head><title>App</title></head><body><main><script src="/app.js"></script>',
        });
  const truncated = await read("https://example.com/truncated");
  strictAssert.equal(
    truncated.details.assessment,
    "empty",
    "a copy that ends early is empty, not an application shell",
  );
  strictAssert.ok(attemptsOf(truncated).some((outcome) => /empty; source incomplete/.test(outcome)));
}

/** Only four captures are kept, so the oldest one is dropped. */
async function scenarioCaptureCap(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri") ? json({}) : json({ content: article("Body.") });
  const ids: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const result = await read(`https://example.com/page-${index}`);
    ids.push(result.details.snapshot as string);
  }
  await strictAssert.rejects(
    read("", { snapshot: ids[0] }),
    /Unknown or expired/,
    "the fifth capture evicts the first",
  );
  const kept = await read("", { snapshot: ids[4] });
  strictAssert.ok(textOf(kept).includes("Body."));
}

/** An oversized response is refused once, not retried across every endpoint. */
async function scenarioOversized(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(5_000_001));
            },
          }),
        );
  await strictAssert.rejects(read("https://example.com/large"), /too large/);
  strictAssert.ok(calls.length <= 2, `expected at most two requests, saw ${calls.length}`);
}

// --- run ----------------------------------------------------------------------

const saved = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
try {
  for (const name of ENV_NAMES) delete process.env[name];
  process.env.ANTIGRAVITY_BASE_URL = "https://mock.googleapis.com";
  await scenarioGuards();
  await scenarioReadablePage();
  await scenarioRedirects();
  await scenarioRecovery();
  await scenarioStatusArticle();
  await scenarioPdf();
  await scenarioAlternate();
  await scenarioAlternateOnSecondEndpoint();
  await scenarioCacheMiss();
  await scenarioSecrets();
  await scenarioBudget();
  await scenarioLongFence();
  await scenarioDetection();
await scenarioTruncatedCopy();
  await scenarioCaptureCap();
  await scenarioOversized();
  console.log("read_url_content: end-to-end fetch, recovery, redaction and capture checks passed");
} finally {
  globalThis.fetch = originalFetch;
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
