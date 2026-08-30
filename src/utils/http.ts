import { antigravityEnv } from "./util.js";

/**
 * Bun's fetch already pools TLS connections, so consecutive turns reuse a socket
 * without a private dispatcher. `ANTIGRAVITY_NO_KEEPALIVE=1` sends `Connection: close`
 * to force a fresh connection per request. HTTP_PROXY / HTTPS_PROXY / ALL_PROXY are
 * honoured by Bun's fetch natively.
 */
const PREWARM_TIMEOUT_MS = 5_000;

/** fetch() using Bun's connection pool. */
export async function antigravityFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (antigravityEnv("NO_KEEPALIVE") === "1") {
    const headers = new Headers(init.headers);
    headers.set("Connection", "close");
    return fetch(input, { ...init, headers });
  }
  return fetch(input, init);
}

/**
 * Open the TLS connection when the extension loads so the first message of a session
 * does not pay the handshake either. Best-effort: failures are ignored.
 */
export function prewarmConnection(url: string): void {
  if (antigravityEnv("NO_PREWARM") === "1") return;
  void (async () => {
    try {
      const res = await antigravityFetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
      });
      // Release the socket back to the pool even though HEAD carries no body.
      await res.arrayBuffer();
    } catch {
      // Warm-up only; the real request will establish the connection instead.
    }
  })();
}
