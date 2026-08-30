import { expect } from "bun:test";
import { antigravityFetch } from "../src/utils/http.js";

const original = Bun.env.ANTIGRAVITY_NO_KEEPALIVE;
const originalFetch = globalThis.fetch;
let requestInit: RequestInit | undefined;

Bun.env.ANTIGRAVITY_NO_KEEPALIVE = "1";
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  requestInit = init;
  return new Response(null, { status: 204 });
}) as typeof fetch;

try {
  const response = await antigravityFetch("https://cloudcode-pa.googleapis.com", { method: "HEAD" });
  expect(response.status).toBe(204);
  expect(new Headers(requestInit?.headers).get("Connection")).toBe("close");
} finally {
  globalThis.fetch = originalFetch;
  if (original === undefined) delete Bun.env.ANTIGRAVITY_NO_KEEPALIVE;
  else Bun.env.ANTIGRAVITY_NO_KEEPALIVE = original;
}

console.log("http no-keepalive Connection: close test passed");
