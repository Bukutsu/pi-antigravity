import { randomUUID } from "node:crypto";
import { MAX_SNAPSHOT_CHARS, type WebFetchResult } from "./web-fetch.js";

/** Small, session-local capture store. Reads never refetch a changing document. */
export function createSnapshotStore() {
  const entries = new Map<string, { result: WebFetchResult; expires: number }>();
  const prune = () => {
    for (const [id, entry] of entries) if (entry.expires <= Date.now()) entries.delete(id);
  };
  return {
    clear() {
      entries.clear();
    },
    put(result: WebFetchResult): string | undefined {
      prune();
      // Bound both entries and document size; oversized results remain ordinary fetch results.
      if (!result.fullContent || result.fullContent.length > MAX_SNAPSHOT_CHARS) return undefined;
      while (entries.size >= 4) entries.delete(entries.keys().next().value!);
      const id = randomUUID();
      entries.set(id, { result, expires: Date.now() + 10 * 60_000 });
      return id;
    },
    get(id: string): WebFetchResult {
      prune();
      const entry = entries.get(id);
      if (!entry) throw new Error("Unknown or expired page snapshot. Fetch the URL again.");
      return entry.result;
    },
  };
}
