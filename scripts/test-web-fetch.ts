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
import { isRecord } from "../src/utils/util.js";

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

const saved = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
for (const name of ENV_NAMES) delete process.env[name];
process.env.ANTIGRAVITY_BASE_URL = "https://mock.googleapis.com";

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ url, body });
  return handler(body, url);
};

// --- the tool under test -----------------------------------------------------

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};

let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
const sessionHooks = new Map<string, () => void>();
let credentialReads = 0;
registerFetch({
  registerTool(definition) {
    // Only execute is exercised; renderer generic types are irrelevant to this host.
    tool = definition as typeof tool;
  },
  on(event, callback) {
    sessionHooks.set(event, () => {
      Reflect.apply(callback, undefined, []);
    });
    return () => {};
  },
});
strictAssert.ok(tool, "the read_url_content tool must register");
strictAssert.equal(tool.name, "read_url_content");
const schema: unknown = tool.parameters;
strictAssert.ok(isRecord(schema) && isRecord(schema.properties));
strictAssert.deepEqual(Object.keys(schema.properties).sort(), ["offset", "snapshot", "url"]);
strictAssert.ok(isRecord(schema.properties.offset));
strictAssert.equal(schema.properties.offset.type, "integer");
strictAssert.match(tool.description, /no JavaScript execution/);
strictAssert.ok(tool.promptGuidelines?.some((line) => line.includes("ten minutes")));

const apiKey = JSON.stringify({ token: "ya29.fixture-token", projectId: "fixture-project" });
const context = {
  modelRegistry: {
    async getApiKeyForProvider() {
      credentialReads += 1;
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
  const beforeCredentials = credentialReads;
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
  strictAssert.equal(
    credentialReads,
    beforeCredentials,
    "invalid targets must not consult credentials",
  );
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
  strictAssert.ok(
    text.length + JSON.stringify(first.details).length <= 1_000,
    "text and details share the budget",
  );
  strictAssert.equal(first.details.source, "cache");
  strictAssert.equal(first.details.truncated, true);
  strictAssert.ok(first.details.snapshot, "a long page is captured for continuation");
  strictAssert.deepEqual(Object.keys(first.details).sort(), [
    "assessment",
    "attempts",
    "bytes",
    "nextOffset",
    "omittedAttempts",
    "partial",
    "representationUrl",
    "snapshot",
    "source",
    "truncated",
  ]);

  // The captured page continues without another request or another credential read.
  const requestCount = calls.length;
  const credentialsBeforeContinuation = credentialReads;
  let combined = bodyOf(first);
  let offset = first.details.nextOffset as number | undefined;
  while (offset !== undefined) {
    const next = await read("", { snapshot: first.details.snapshot as string, offset });
    strictAssert.ok(
      textOf(next).length + JSON.stringify(next.details).length <= 1_000,
      "each range shares the text and details budget",
    );
    combined += bodyOf(next);
    offset = next.details.nextOffset as number | undefined;
  }
  strictAssert.equal(combined, `# Test page\n\n${body}`, "the ranges must reassemble the page");
  strictAssert.equal(calls.length, requestCount, "a continuation must not refetch");
  strictAssert.equal(
    credentialReads,
    credentialsBeforeContinuation,
    "a continuation must not consult credentials",
  );
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
  for (const redirectUri of ["https://exa mple.com/page"]) {
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
    '<!doctype html><html><head><title>App</title></head><body><div id="root"></div>' +
    '<script src="/app.js"></script><p>Loading…</p></body></html>';
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
    () => json({ content: "preamble\n%PDF-1.7\nbinary" }),
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

/** A decoded article field is not the JSON envelope's media type. */
async function scenarioJsonRepresentation(): Promise<void> {
  const links = '<link rel="alternate" type="application/json" href="/article.json">';
  const encoded = JSON.stringify({
    id: 1,
    link: "https://example.com/article",
    content: { rendered: "<p>Verified article body.</p>" },
  });
  for (const contentType of [undefined, "application/json"]) {
    calls.length = 0;
    handler = (body, url) => {
      if (url.endsWith(":rewriteUri")) return json({});
      if (body.url === "https://example.com/article.json")
        return json({ content: encoded, contentType });
      return json({ content: cutArticle("Original article.", links) });
    };
    const result = await read("https://example.com/article", { maxChars: 4000 });
    strictAssert.ok(bodyOf(result).includes("Verified article body."));
    strictAssert.ok(!bodyOf(result).includes("<p>"));
    strictAssert.ok(calls.length <= 5, "one publisher representation only");
  }
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
    // Only transport failure triggers endpoint failover.
    if (url.includes("daily-cloudcode-pa.googleapis.com")) throw new TypeError("fetch failed");
    if (body.url === "https://example.com/a.md") {
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

/** Transport failure on the representation does not repeat the original page. */
async function scenarioRepresentationTransport(): Promise<void> {
  delete process.env.ANTIGRAVITY_BASE_URL;
  const links = '<link rel="alternate" type="text/markdown" href="/body.md">';
  calls.length = 0;
  handler = (body, url) => {
    if (url.endsWith(":rewriteUri")) return json({});
    if (body.url === "https://example.com/body.md") {
      if (url.includes("daily-cloudcode-pa.googleapis.com")) throw new TypeError("fetch failed");
      return json({ content: "# Recovered\n\nRepresentation transport recovered." });
    }
    return json({ content: cutArticle("Original partial.", links) });
  };
  try {
    const result = await read("https://example.com/page", { maxChars: 4000 });
    strictAssert.ok(bodyOf(result).includes("Representation transport recovered."));
    strictAssert.equal(
      calls.filter((call) => call.body.url === "https://example.com/page").length,
      2,
    );
    strictAssert.ok(calls.length <= 10);
    const keys = calls.map((call) => JSON.stringify([call.url, call.body]));
    strictAssert.equal(new Set(keys).size, keys.length, "no endpoint/stage/URL is requested twice");
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

/** Caller URLs are redacted on rendered surfaces, including a page echo. */
async function scenarioSecrets(): Promise<void> {
  calls.length = 0;
  handler = (body, url) =>
    url.endsWith(":rewriteUri") ? json({}) : json({ content: article("Echo " + String(body.url)) });
  const updates: string[] = [];
  const result = await read(
    "https://example.com/page?code=AUTHCODE&foo=ya29.TOKENSECRET#code=FRAGSECRET",
    { updates, maxChars: 4000 },
  );
  const visible = `${updates.join("")}\n${textOf(result)}\n${JSON.stringify(result.details)}`;
  strictAssert.ok(!visible.includes("AUTHCODE"), "an authorization code must be redacted");
  strictAssert.ok(!visible.includes("ya29.TOKENSECRET"), "a token must be redacted");
  strictAssert.ok(!visible.includes("FRAGSECRET"), "a fragment secret must be redacted");
  const sourceUrl = /^Source: (.+) \((?:cache|live)\)$/m.exec(textOf(result))?.[1];
  strictAssert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  strictAssert.ok(source.searchParams.has("code"));
  strictAssert.ok(source.searchParams.has("foo"));
  strictAssert.notEqual(source.searchParams.get("code"), "AUTHCODE");
  strictAssert.ok(new URLSearchParams(source.hash.slice(1)).has("code"));
  strictAssert.ok(
    calls.some((call) => String(call.body.url).includes("AUTHCODE")),
    "the actual Google request is not redacted",
  );
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
    url.endsWith(":rewriteUri") ? json({}) : json({ content: '<img src="/i.png">A caption.' });
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
  strictAssert.ok(
    attemptsOf(truncated).some((outcome) => /empty; source incomplete/.test(outcome)),
  );
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

async function scenarioFailedCapture(): Promise<void> {
  handler = (_body, url) =>
    url.endsWith(":rewriteUri") ? json({}) : json({ content: article("Keep this capture.") });
  const captures: string[] = [];
  for (let index = 0; index < 4; index += 1)
    captures.push(
      (await read("https://example.com/kept-" + index, { maxChars: 1000 })).details
        .snapshot as string,
    );
  await strictAssert.rejects(
    read("https://example.com/budget-failure", { maxChars: 1 }),
    /budget is too small/,
  );
  const kept = await read("", { snapshot: captures[0], maxChars: 1000 });
  strictAssert.ok(bodyOf(kept).includes("Keep this capture."));
}

async function scenarioLifecycle(): Promise<void> {
  for (const hook of sessionHooks.values()) {
    handler = (_body, url) =>
      url.endsWith(":rewriteUri") ? json({}) : json({ content: article("Captured page.") });
    const result = await read("https://example.com/lifecycle", { maxChars: 1000 });
    hook();
    const before = { calls: calls.length, credentials: credentialReads };
    await strictAssert.rejects(
      read("", { snapshot: result.details.snapshot as string }),
      /Unknown or expired/,
    );
    strictAssert.equal(calls.length, before.calls);
    strictAssert.equal(credentialReads, before.credentials);
  }
  const controller = new AbortController();
  controller.abort();
  const before = { calls: calls.length, credentials: credentialReads };
  await strictAssert.rejects(
    tool!.execute(
      "aborted",
      { url: "https://example.com/" },
      controller.signal,
      undefined,
      context,
    ),
    /aborted/,
  );
  strictAssert.equal(calls.length, before.calls);
  strictAssert.equal(credentialReads, before.credentials);
  const delayedAbort = new AbortController();
  let progress = 0;
  const originalGetKey = context.modelRegistry.getApiKeyForProvider.bind(context.modelRegistry);
  context.modelRegistry.getApiKeyForProvider = async () => {
    delayedAbort.abort();
    return apiKey;
  };
  await strictAssert.rejects(
    tool!.execute(
      "cancel-during-auth",
      { url: "https://example.com/" },
      delayedAbort.signal,
      () => {
        progress += 1;
      },
      context,
    ),
    /aborted/,
  );
  context.modelRegistry.getApiKeyForProvider = originalGetKey;
  strictAssert.equal(
    progress,
    0,
    "a canceled read must not announce progress after credential lookup",
  );
}

// --- run ----------------------------------------------------------------------

try {
  await scenarioGuards();
  await scenarioReadablePage();
  await scenarioRedirects();
  await scenarioRecovery();
  await scenarioStatusArticle();
  await scenarioPdf();
  await scenarioAlternate();
  await scenarioJsonRepresentation();
  await scenarioAlternateOnSecondEndpoint();
  await scenarioRepresentationTransport();
  await scenarioCacheMiss();
  await scenarioSecrets();
  await scenarioBudget();
  await scenarioLongFence();
  await scenarioDetection();
  await scenarioTruncatedCopy();
  await scenarioCaptureCap();
  await scenarioOversized();
  await scenarioFailedCapture();
  await scenarioLifecycle();
  console.log("read_url_content: end-to-end fetch, recovery, redaction and capture checks passed");
} finally {
  globalThis.fetch = originalFetch;
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
