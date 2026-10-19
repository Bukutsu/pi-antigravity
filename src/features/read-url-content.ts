/**
 * Optional model-facing web fetch tool.
 * Disable this extension resource in `pi config` to keep the Antigravity provider
 * and `/antigravity.fetch` without registering `read_url_content`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { isExtraToolEnabled, redactSecrets } from "../utils/index.js";
import { executeAntigravityWebFetch, formatWebFetchResult } from "../web-fetch/index.js";

export default function (pi: ExtensionAPI): void {
  if (!isExtraToolEnabled("FETCH")) return;
  pi.registerTool({
    name: "read_url_content",
    label: "Read URL Content",
    description:
      "Read a public web page through Google's Antigravity crawler and return it as markdown. Use it for documentation, articles, changelogs, and standards pages when search snippets are not enough. The crawl runs on Google's side: no JavaScript execution, no cookies, and no pages behind a login — for those, ask the user to open the page in their browser.",
    promptSnippet: "Read a public web page as markdown via the Antigravity crawler",
    promptGuidelines: [
      "Use read_url_content when you have a specific URL whose contents you need, instead of guessing from a search result summary.",
      "One URL per call, and prefer the page that holds the answer over a site root or a category index.",
      "The page is returned as markdown and can be long; when the result says it was truncated, fetch a more specific URL rather than repeating the call.",
      "It cannot log in, run JavaScript, or read local and private addresses, so do not use it for those.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Public http(s) URL of the page to read." }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) {
        throw new Error("No Antigravity credentials. Run /login antigravity first.");
      }
      onUpdate?.({
        content: [{ type: "text", text: `Reading ${params.url}…` }],
        details: {},
      });
      try {
        const result = await executeAntigravityWebFetch({ apiKey, url: params.url, signal });
        return {
          content: [{ type: "text", text: formatWebFetchResult(result) }],
          details: { source: result.source, bytes: result.bytes, truncated: result.truncated },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(redactSecrets(msg), { cause: error });
      }
    },
  });
}
