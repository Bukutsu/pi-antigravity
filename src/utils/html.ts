/**
 * Shared HTML text helpers.
 *
 * Search titles and fetched pages both come out of Google's services as markup, so
 * entity decoding lives here rather than in either feature.
 */

/** Replace HTML entities with their characters, leaving whitespace exactly as written. */
export function decodeEntityText(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Entity decoding for one line of prose: collapsed to single spaces and trimmed. */
export function decodeHtmlEntities(text: string): string {
  return decodeEntityText(text).replace(/\s+/g, " ").trim();
}
