/**
 * Optional model-facing web fetch tool.
 * Disable this extension resource in `pi config` to keep the Antigravity provider
 * and `/antigravity.fetch` without registering `read_url_content`.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { isExtraToolEnabled, redactSecrets } from "../utils/index.js";
import {
  executeAntigravityWebFetch,
  formatWebFetchHeader,
  formatWebFetchResult,
  readCapturedPage,
  resolveMaxChars,
  validateFetchTarget,
} from "../web-fetch/index.js";
import { createSnapshotStore } from "../web-fetch/snapshots.js";

export default function (pi: Pick<ExtensionAPI, "on" | "registerTool">): void {
  if (!isExtraToolEnabled("FETCH")) return;
  const snapshots = createSnapshotStore();
  let generation = 0;
  const clear = () => {
    snapshots.clear();
    generation += 1;
  };
  pi.on("session_start", clear);
  pi.on("session_before_switch", clear);
  pi.on("session_before_fork", clear);
  pi.on("session_tree", clear);
  pi.on("session_shutdown", clear);
  pi.registerTool({
    name: "read_url_content",
    label: "Read URL Content",
    description:
      "Read a public web page through Google's Antigravity crawler and return it as markdown. Use it for documentation, articles, changelogs, and standards pages when search snippets are not enough. The crawl runs on Google's side: no JavaScript execution, no cookies, and no pages behind a login — for those, ask the user to open the page in their browser.",
    promptSnippet: "Read a public web page as markdown via the Antigravity crawler",
    promptGuidelines: [
      "Use read_url_content when you have a specific URL whose contents you need, instead of guessing from a search result summary.",
      "One URL per call, and prefer the page that holds the answer over a site root or a category index.",
      "For long results, read the next range using the returned snapshot and nextOffset. Snapshot reads use the same captured document, without another network request. Snapshots expire after ten minutes and are session-local.",
      "It cannot log in, run JavaScript, or read local and private addresses, so do not use it for those.",
    ],
    parameters: Type.Object({
      url: Type.Optional(
        Type.String({ description: "Public http(s) URL to fetch. Supply either url or snapshot." }),
      ),
      snapshot: Type.Optional(
        Type.String({
          description: "Snapshot ID returned by an earlier fetch; omit url when reading it.",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Character offset in the snapshot. Use nextOffset from the preceding result.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if ((!params.url && !params.snapshot) || (params.url && params.snapshot)) {
        throw new Error("Supply exactly one of url or snapshot.");
      }
      if (params.offset !== undefined && !params.snapshot)
        throw new Error("Offset requires a snapshot.");
      if (signal?.aborted) throw new Error("Web fetch aborted");
      const started = generation;
      const maxChars = resolveMaxChars();
      try {
        const url = params.url ? validateFetchTarget(params.url) : undefined;
        const apiKey = params.snapshot
          ? undefined
          : await ctx.modelRegistry.getApiKeyForProvider("antigravity");
        if (!params.snapshot && !apiKey) {
          throw new Error("No Antigravity credentials. Run /login antigravity first.");
        }
        if (signal?.aborted) throw new Error("Web fetch aborted");
        onUpdate?.({
          content: [
            {
              type: "text",
              text: params.snapshot ? "Reading captured page…" : `Reading ${redactSecrets(url!)}…`,
            },
          ],
          details: {},
        });
        if (started !== generation) throw new Error("Session changed during web fetch.");
        const result = params.snapshot
          ? snapshots.get(params.snapshot)
          : await executeAntigravityWebFetch({ apiKey, url: url!, signal });
        if (signal?.aborted) throw new Error("Web fetch aborted");
        if (started !== generation) throw new Error("Session changed during web fetch.");
        const snapshot = params.snapshot ?? (result.fullContent ? randomUUID() : undefined);
        const attempts: Array<{
          source: string;
          outcome: string;
          url?: string;
          stage?: string;
          endpoint?: string;
        }> = [...(result.attempts ?? [])];
        const details = {
          source: result.source,
          bytes: result.bytes,
          truncated: false,
          partial: result.partial,
          assessment: result.assessment,
          representationUrl: result.representationUrl
            ? redactSecrets(result.representationUrl)
            : undefined,
          attempts,
          omittedAttempts: 0,
          snapshot,
          // Reserve the largest cursor before formatting; the real cursor only shrinks it.
          nextOffset: snapshot ? result.fullContent!.length : undefined,
        };
        const detailsBudget = Math.floor(maxChars * 0.4);
        const size = () => JSON.stringify(details).length;
        while (size() > detailsBudget && details.attempts.length > 1) {
          details.attempts.shift();
          details.omittedAttempts += 1;
        }
        if (size() > detailsBudget && details.attempts.length === 1) {
          const last = details.attempts[0];
          details.attempts = [{ source: last.source, stage: last.stage, outcome: last.outcome }];
        }
        if (size() > detailsBudget) details.representationUrl = undefined;
        if (size() > detailsBudget && details.attempts.length) {
          details.attempts = [];
          details.omittedAttempts += 1;
        }
        const textBudget = maxChars - size();
        const captured = { ...result, maxChars: textBudget };
        let page: ReturnType<typeof readCapturedPage> | undefined;
        let continuation = "";
        if (snapshot) {
          let budget = Math.max(1, textBudget - formatWebFetchHeader(captured).length);
          for (;;) {
            page = readCapturedPage(captured, params.offset ?? 0, budget);
            continuation =
              `\n\nSnapshot: ${snapshot}\nRange: ${page.offset}–${page.nextOffset ?? page.totalChars} of ${page.totalChars} characters.` +
              (page.nextOffset !== undefined
                ? `\nNext offset: ${page.nextOffset} (use the same snapshot).`
                : "\nEnd of captured content (not proof of full article coverage).");
            const excess =
              formatWebFetchHeader(page.result).length +
              page.result.content.length +
              continuation.length -
              textBudget;
            if (excess <= 0) break;
            budget -= excess;
            if (budget < 1)
              throw new Error(
                "The character budget is too small for page provenance or a code-fence delimiter. Open the page in a browser or ask the user to increase ANTIGRAVITY_WEB_FETCH_MAX_CHARS.",
              );
          }
        }
        const displayed = page?.result ?? captured;
        const text = formatWebFetchResult(displayed, continuation);
        details.truncated = displayed.truncated;
        details.nextOffset = page?.nextOffset;
        // Commit a new capture only after the complete output has been formatted.
        if (!params.snapshot && snapshot) snapshots.put(result, snapshot);
        return {
          content: [{ type: "text", text }],
          details,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Error causes can retain request objects and response text; keep only a redacted message.
        const safe = redactSecrets(msg);
        // eslint-disable-next-line preserve-caught-error -- the raw cause can retain request/response bodies
        throw new Error(safe, { cause: new Error(safe) });
      }
    },
  });
}
