import assert from "node:assert/strict";
import register from "../src/index.js";
import { ANTIGRAVITY_IMAGE_API, ANTIGRAVITY_IMAGE_MODELS, generateAntigravityImages } from "../src/image/native.js";

const model = { ...ANTIGRAVITY_IMAGE_MODELS[0]!, provider: "antigravity" };
const context = { input: [{ type: "text" as const, text: "a square" }] };
assert.equal((await generateAntigravityImages(model, context)).stopReason, "error");
assert.match((await generateAntigravityImages(model, context, { apiKey: "bad" })).errorMessage!, /Invalid Antigravity credentials/);
const abort = new AbortController();
abort.abort();
assert.equal((await generateAntigravityImages(model, context, { signal: abort.signal })).stopReason, "aborted");

let provider: any;
const schemas: Record<string, string[]> = {};
register(new Proxy({}, {
  get(_target, key) {
    if (key === "registerProvider") return (_name: string, config: unknown) => { provider = config; };
    if (key === "registerTool") return (tool: any) => {
      schemas[tool.name] = Object.keys(tool.parameters.properties).sort();
    };
    return () => undefined;
  },
}) as Parameters<typeof register>[0]);
assert.equal(provider.images[ANTIGRAVITY_IMAGE_API].generateImages, generateAntigravityImages);
assert.equal(provider.models.filter((m: any) => m.type === "image").length, 1);
assert.deepEqual(schemas.generate_image, ["aspectRatio", "model", "path", "prompt"]);
assert.deepEqual(schemas.google_search, ["instruction", "query", "thinking", "urls"]);

const originalFetch = globalThis.fetch;
const saved = new Map(["ANTIGRAVITY_BASE_URL", "ANTIGRAVITY_NO_KEEPALIVE"].map(k => [k, process.env[k]]));
process.env.ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
process.env.ANTIGRAVITY_NO_KEEPALIVE = "1";
const apiKey = JSON.stringify({ token: "test-token", projectId: "test-project" });
try {
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, model.id);
    assert.equal(body.request.generationConfig.imageConfig.aspectRatio, "16:9");
    assert.deepEqual(body.request.contents[0].parts[1], { inlineData: { data: "AQID", mimeType: "image/png" } });
    return new Response(JSON.stringify({ response: { candidates: [{ content: { parts: [
      { text: "done" }, { inlineData: { data: "AQID", mimeType: "image/jpeg" } },
    ] } }] } }));
  }) as typeof fetch;
  const result = await generateAntigravityImages(model, { input: [
    ...context.input, { type: "image", data: "AQID", mimeType: "image/png" },
  ] }, { apiKey, metadata: { aspectRatio: "16:9" } });
  assert.equal(result.stopReason, "stop");
  assert.equal(result.model, model.id);
  assert.deepEqual(result.output, [
    { type: "text", text: "done" }, { type: "image", data: "AQID", mimeType: "image/jpeg" },
  ]);
  assert.equal(calls, 1);
  assert.equal("savedPaths" in result, false);

  const invalid = await generateAntigravityImages(model, context, { apiKey, metadata: { aspectRatio: "99:1" } });
  assert.equal(invalid.stopReason, "error");
  assert.equal(calls, 1, "invalid ratio does not make a request");
  assert.equal((await generateAntigravityImages(model, { input: [] }, { apiKey })).stopReason, "error");

  globalThis.fetch = (async () => {
    const requestAbort = new Error("aborted");
    throw requestAbort;
  }) as typeof fetch;
  const controller = new AbortController();
  globalThis.fetch = (async () => { controller.abort(); throw new Error("aborted"); }) as typeof fetch;
  assert.equal((await generateAntigravityImages(model, context, { apiKey, signal: controller.signal })).stopReason, "aborted");

  // Refresh publishes the same image model without requiring network access.
  const refreshed = await provider.refreshModels({ allowNetwork: false });
  assert.equal(refreshed.filter((m: any) => m.type === "image").length, 1);
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
console.log("native images: registration, unchanged schemas, inputs, errors, abort, and refresh passed");
