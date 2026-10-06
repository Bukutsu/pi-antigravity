import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import {
  ANTIGRAVITY_IMAGE_API,
  ANTIGRAVITY_IMAGE_MODELS,
  assertSafeAspectRatio,
  assertSafeImageModel,
  buildImageGenerateRequest,
  collectImagesFromSse,
  generateAntigravityImages,
  loadImageFromPath,
  parseImageCommandArgs,
  resolveImageSavePath,
  sanitizeImageFileName,
} from "../src/image/index.js";

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): void {
  if (!condition) fail(`FAILED: ${message}`);
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i += 1;
    },
  });
  return new Response(body);
}

async function main() {
  const parsed = parseImageCommandArgs("--ratio 16:9 --model gemini-3-pro-image a sunset over mountains");
  assert(parsed.prompt === "a sunset over mountains", "prompt parsed");
  assert(parsed.aspectRatio === "16:9", "ratio parsed");
  assert(parsed.model === "gemini-3-pro-image", "model parsed");

  const withPath = parseImageCommandArgs("--path out/cat.png --ratio 1:1 a cat");
  assert(withPath.path === "out/cat.png", "path parsed");
  assert(withPath.prompt === "a cat", "prompt after flags");

  const withAgyFlags = parseImageCommandArgs("--name my_koi --image ref.png --image ref2.jpg a koi pond");
  assert(withAgyFlags.imageName === "my_koi", "imageName parsed");
  assert(withAgyFlags.imagePaths?.length === 2, "2 image paths parsed");
  assert(withAgyFlags.imagePaths[0] === "ref.png", "first image path");
  assert(withAgyFlags.imagePaths[1] === "ref2.jpg", "second image path");
  assert(withAgyFlags.prompt === "a koi pond", "prompt after agy flags");

  assert(sanitizeImageFileName("My Cool Login!") === "my_cool_login", "sanitize filename");

  assert(parseImageCommandArgs("").prompt === "", "empty args");
  assert(assertSafeImageModel("gemini-3-pro-image") === "gemini-3-pro-image", "allow gemini image model");
  assert(assertSafeImageModel("imagen-3.0-generate-002") === "imagen-3.0-generate-002", "allow imagen");
  try {
    assertSafeImageModel("claude-opus-4-6");
    fail("expected unsafe model to throw");
  } catch (error) {
    assert(error instanceof Error && /Unsupported image model/.test(error.message), "reject chat model");
  }
  try {
    assertSafeImageModel("https://evil.example/x");
    fail("expected url model to throw");
  } catch {
    // expected
  }

  assert(assertSafeAspectRatio("16:9") === "16:9", "allow 16:9");
  try {
    assertSafeAspectRatio("99:1");
    fail("expected bad ratio to throw");
  } catch (error) {
    assert(error instanceof Error && /Unsupported aspect ratio/.test(error.message), "reject ratio");
  }

  const req = buildImageGenerateRequest("a lighthouse", "gemini-3.1-flash-image", "proj-1", "16:9", [
    { mimeType: "image/png", data: "AQID" },
  ]);
  assert(req.model === "gemini-3.1-flash-image", "request model");
  assert(req.project === "proj-1", "request project");
  assert(req.request.generationConfig.imageConfig.aspectRatio === "16:9", "aspect ratio");
  assert(req.request.contents[0]?.parts[0]?.text === "a lighthouse", "prompt text");
  assert(req.request.contents[0]?.parts[1]?.inlineData?.data === "AQID", "inlineData image part");
  assert(req.requestType === "image_gen", "requestType is image_gen");
  assert(
    /^image_gen\/\d+\/[0-9a-f-]{36}\/1$/.test(req.requestId),
    `image_gen request id with single timestamp and UUID: ${req.requestId}`,
  );

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const body =
    sse({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }) +
    sse({
      response: {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }],
      },
    }) +
    "data: [DONE]\n";
  const parsedSse = await collectImagesFromSse(responseFromChunks([body.slice(0, 40), body.slice(40)]));
  assert(parsedSse.images.length === 1, "one image");
  assert(parsedSse.images[0]?.mimeType === "image/png", "png mime");
  assert(parsedSse.images[0]?.data === png, "png data");
  assert(parsedSse.text.join("") === "ok", "sse text");

  const tmp = await mkdtemp(join(tmpdir(), "pi-antigravity-image-"));
  try {
    const saved = resolveImageSavePath(tmp, "out/cat.png");
    assert(saved === join(tmp, "out/cat.png"), `save path ${saved}`);
    const agySaved = resolveImageSavePath(tmp, undefined, "red_square", "image/jpeg");
    assert(agySaved === join(tmp, "red_square.jpg"), `agy naming save path ${agySaved}`);
    const dirSaved = resolveImageSavePath(tmp, "images", undefined, "image/jpeg", 0);
    assert(dirSaved.endsWith("-1.jpg"), `dir save ${dirSaved}`);
    assert(dirSaved.startsWith(join(tmp, "images")), "dir stays in cwd");
    try {
      resolveImageSavePath(tmp, "../escape.png");
      fail("expected path traversal to throw");
    } catch (error) {
      assert(
        error instanceof Error && /inside the working directory/.test(error.message),
        "reject traversal",
      );
    }

    // Reference image loading security checks
    const samplePngPath = join(tmp, "sample.png");
    await writeFile(samplePngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const loaded = await loadImageFromPath(tmp, "sample.png");
    assert(loaded.mimeType === "image/png", "sample png loaded");

    try {
      await loadImageFromPath(tmp, "../escape.png");
      fail("expected reference image traversal to throw");
    } catch (error) {
      assert(
        error instanceof Error && /Reference image path must be inside/.test(error.message),
        "reject reference image traversal",
      );
    }

    try {
      const badExtPath = join(tmp, "secret.key");
      await writeFile(badExtPath, "secret");
      await loadImageFromPath(tmp, "secret.key");
      fail("expected unsupported image format to throw");
    } catch (error) {
      assert(
        error instanceof Error && /Reference image must be/.test(error.message),
        "reject non-image reference file",
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  assert(ANTIGRAVITY_IMAGE_API === "antigravity-images", "image api identifier");
  assert(ANTIGRAVITY_IMAGE_MODELS.length >= 3, "at least 3 image models");
  assert(ANTIGRAVITY_IMAGE_MODELS.every((m) => m.type === "image"), "models typed as image");
  assert(
    ANTIGRAVITY_IMAGE_MODELS.some((m) => m.id === "gemini-3-pro-image"),
    "includes gemini-3-pro-image",
  );
  assert(
    ANTIGRAVITY_IMAGE_MODELS.some((m) => m.id === "gemini-3.1-flash-image"),
    "includes gemini-3.1-flash-image",
  );

  // Test generateAntigravityImages with no apiKey
  const noAuthRes = await generateAntigravityImages(
    {
      id: "gemini-3-pro-image",
      api: ANTIGRAVITY_IMAGE_API,
      provider: "antigravity",
    },
    { input: [{ type: "text", text: "A test prompt" }] },
  );
  assert(noAuthRes.stopReason === "error", "no auth returns error");
  assert(/No Antigravity credentials/.test(noAuthRes.errorMessage || ""), "credentials message");

  // Test generateAntigravityImages with empty prompt
  const emptyRes = await generateAntigravityImages(
    {
      id: "gemini-3-pro-image",
      api: ANTIGRAVITY_IMAGE_API,
      provider: "antigravity",
    },
    { input: [{ type: "text", text: "   " }] },
    { apiKey: JSON.stringify({ token: "fake", projectId: "fake" }) },
  );
  assert(emptyRes.stopReason === "error", "empty prompt returns error");

  console.log("image gen: command parsing, model/path guards, request shape, codemode integration, and SSE parse passed");
}

void main();
