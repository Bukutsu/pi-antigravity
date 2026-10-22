/**
 * Keep a page too long for one answer on disk, the way Pi's own tools keep long output:
 * the caller shows the beginning and points to the file for the rest.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Write text to a new private temp directory and return the file path. */
export async function savePageFile(text: string, extension: "md" | "html"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-url-"));
  const path = join(directory, `page.${extension}`);
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  return path;
}

/** Footer naming the saved page; the agent continues with its file tools. */
export function savedPageNote(path: string, chars: number): string {
  return `\n\n[Full page saved to: ${path} (${chars.toLocaleString("en-US")} characters). Read the rest with your file tools.]`;
}

/** Error whose message points to Google's unconverted copy, saved for searching. */
export async function withSavedCopy(error: unknown): Promise<unknown> {
  const copy = (error as { unconvertedCopy?: string } | undefined)?.unconvertedCopy;
  if (!(error instanceof Error) || !copy) return error;
  const path = await savePageFile(copy, "html");
  return new Error(
    `${error.message} Google's unconverted HTML (${copy.length.toLocaleString("en-US")} characters) was saved to: ${path}. Search it with your file tools.`,
  );
}
