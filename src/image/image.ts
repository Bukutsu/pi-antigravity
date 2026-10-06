import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AssistantImages, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  antigravityHeaders,
  endpointCandidates,
  jsonOrTextError,
  parseApiKey,
} from "../client/client.js";
import { AntigravityRequestType, AntigravityUserAgent, GeminiRole } from "../types/enums.js";
import { antigravityFetch } from "../utils/http.js";
import { safeError } from "../utils/security.js";
import { antigravityRequestEnvelope, sanitizeText } from "../utils/util.js";

export const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";
export const ANTIGRAVITY_IMAGE_API = "antigravity-images";

export const IMAGE_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

export const IMAGE_MODEL_FALLBACKS = [
  DEFAULT_IMAGE_MODEL,
  "gemini-3-pro-image",
  "gemini-3-pro-image-preview",
] as const;

export type AntigravityImageModelConfig = ProviderModelConfig & {
  type: "image";
  output: ("text" | "image")[];
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const ANTIGRAVITY_IMAGE_MODELS: AntigravityImageModelConfig[] = [
  {
    type: "image",
    id: "gemini-3.1-flash-image",
    name: "Gemini 3.1 Flash Image (Antigravity)",
    api: ANTIGRAVITY_IMAGE_API,
    reasoning: false,
    input: ["text", "image"],
    output: ["image", "text"],
    cost: ZERO_COST,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    type: "image",
    id: "gemini-3-pro-image",
    name: "Gemini 3 Pro Image (Antigravity)",
    api: ANTIGRAVITY_IMAGE_API,
    reasoning: false,
    input: ["text", "image"],
    output: ["image", "text"],
    cost: ZERO_COST,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    type: "image",
    id: "gemini-3-pro-image-preview",
    name: "Gemini 3 Pro Image Preview (Antigravity)",
    api: ANTIGRAVITY_IMAGE_API,
    reasoning: false,
    input: ["text", "image"],
    output: ["image", "text"],
    cost: ZERO_COST,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
];

export const IMAGE_SYSTEM_INSTRUCTION =
  "You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";
const DEFAULT_IMAGE_DIR = join(".pi", "generated-images");
const MAX_PROMPT_CHARS = 8000;

export type GeneratedImage = { data: string; mimeType: string };

export type ImageGenerateRequest = {
  project: string;
  model: string;
  request: {
    contents: Array<{
      role: "user";
      parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
    }>;
    systemInstruction?: { role: "user"; parts: Array<{ text: string }> };
    generationConfig: {
      imageConfig: { aspectRatio: string };
      candidateCount: number;
    };
  };
  requestType: AntigravityRequestType;
  userAgent: "antigravity";
  requestId: string;
};

export type ImageCommandArgs = {
  prompt: string;
  aspectRatio?: string;
  model?: string;
  path?: string;
  imageName?: string;
  imagePaths?: string[];
};

export type GenerateImageOptions = ImageCommandArgs & {
  apiKey: string;
  cwd: string;
  signal?: AbortSignal;
};

export type GenerateImageResult = {
  images: GeneratedImage[];
  savedPaths: string[];
  text: string[];
  model: string;
};

export type AntigravityImageModelLike = {
  id: string;
  api: string;
  provider: string;
  name?: string;
  baseUrl?: string;
  [key: string]: unknown;
};

type ImageStreamChunk = {
  error?: { message?: string };
  response?: {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
      };
    }>;
  };
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
    };
  }>;
};

function imageExtension(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  return "png";
}

export function sanitizeImageFileName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "image";
}

export async function loadImageFromPath(
  cwd: string,
  rawPath: string,
): Promise<{ mimeType: string; data: string }> {
  const root = resolve(cwd);
  const fullPath = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
  const bytes = await readFile(fullPath);
  const ext = extname(fullPath).toLowerCase();
  let mimeType = "image/jpeg";
  if (ext === ".png") mimeType = "image/png";
  else if (ext === ".webp") mimeType = "image/webp";
  else if (ext === ".gif") mimeType = "image/gif";
  return {
    mimeType,
    data: bytes.toString("base64"),
  };
}

export function assertSafeImageModel(modelId: string): string {
  const id = modelId.trim();
  if (id.length === 0 || id.length > 80) {
    throw new Error("Unsupported image model id.");
  }
  if (!/^(gemini-[a-z0-9.+-]*image[a-z0-9.+-]*|imagen-[a-z0-9.+-]+)$/i.test(id)) {
    throw new Error(`Unsupported image model: ${id}`);
  }
  return id;
}

export function assertSafeAspectRatio(ratio: string): ImageAspectRatio {
  const value = ratio.trim();
  for (const allowed of IMAGE_ASPECT_RATIOS) {
    if (allowed === value) return allowed;
  }
  throw new Error(
    `Unsupported aspect ratio: ${value}. Use one of ${IMAGE_ASPECT_RATIOS.join(", ")}.`,
  );
}

export function parseImageCommandArgs(args: string): ImageCommandArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const out: ImageCommandArgs = { prompt: "" };
  const rest: string[] = [];
  const imagePaths: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    const next = tokens[i + 1];
    if ((token === "--ratio" || token === "--aspect-ratio" || token === "--aspect_ratio") && next) {
      out.aspectRatio = next;
      i += 1;
      continue;
    }
    if ((token === "--name" || token === "--image-name" || token === "--image_name") && next) {
      out.imageName = next;
      i += 1;
      continue;
    }
    if ((token === "--image" || token === "--image-path" || token === "--image_path") && next) {
      imagePaths.push(next);
      i += 1;
      continue;
    }
    if (token === "--model" && next) {
      out.model = next;
      i += 1;
      continue;
    }
    if (token === "--path" && next) {
      out.path = next;
      i += 1;
      continue;
    }
    rest.push(token);
  }
  out.prompt = rest.join(" ");
  if (imagePaths.length > 0) {
    out.imagePaths = imagePaths;
  }
  return out;
}

export function resolveImageSavePath(
  cwd: string,
  requested?: string,
  imageName?: string,
  mimeType = "image/jpeg",
  index?: number,
): string {
  if (imageName && imageName.includes("/")) {
    index = typeof mimeType === "number" ? mimeType : index;
    mimeType = imageName;
    imageName = undefined;
  }
  const ext = imageExtension(mimeType);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = index === undefined ? "" : `-${index + 1}`;
  const root = resolve(cwd);

  let target: string;
  if (requested?.trim()) {
    target = resolve(root, requested.trim());
  } else if (imageName?.trim()) {
    const clean = sanitizeImageFileName(imageName);
    target = resolve(root, `${clean}${suffix}.${ext}`);
  } else {
    target = resolve(root, DEFAULT_IMAGE_DIR, `image-${stamp}${suffix}.${ext}`);
  }

  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Image save path must be inside the working directory.");
  }
  if (!extname(target)) {
    const defaultName = imageName?.trim()
      ? `${sanitizeImageFileName(imageName)}${suffix}.${ext}`
      : `image-${stamp}${suffix}.${ext}`;
    return join(target, defaultName);
  }
  if (index === undefined) return target;
  const currentExt = extname(target);
  return `${target.slice(0, -currentExt.length)}${suffix}${currentExt}`;
}

export function buildImageGenerateRequest(
  prompt: string,
  model: string,
  projectId: string,
  aspectRatio: string,
  inputImages?: Array<{ mimeType: string; data: string }>,
): ImageGenerateRequest {
  const envelope = antigravityRequestEnvelope(model, false);
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  if (prompt) {
    parts.push({ text: sanitizeText(prompt) });
  }
  for (const img of inputImages || []) {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.data,
      },
    });
  }
  return {
    project: projectId,
    model,
    request: {
      contents: [{ role: GeminiRole.User, parts }],
      generationConfig: {
        imageConfig: { aspectRatio },
        candidateCount: 1,
      },
    },
    requestType: AntigravityRequestType.ImageGen,
    userAgent: AntigravityUserAgent.Antigravity,
    requestId: `image_gen/${Date.now()}/${envelope.requestId.slice(6)}/1`,
  };
}

function collectImagesFromParts(
  parts: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> | undefined,
  images: GeneratedImage[],
  text: string[],
): void {
  for (const part of parts || []) {
    if (part.text) text.push(part.text);
    if (part.inlineData?.data) {
      images.push({
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType || "image/png",
      });
    }
  }
}

export async function collectImagesFromSse(
  response: Response,
  signal?: AbortSignal,
): Promise<{ images: GeneratedImage[]; text: string[] }> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const images: GeneratedImage[] = [];
  const text: string[] = [];
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request was aborted");
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) continue;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (!json || json === "[DONE]") continue;
        let chunk: ImageStreamChunk;
        try {
          chunk = JSON.parse(json) as ImageStreamChunk;
        } catch {
          continue;
        }
        if (chunk.error?.message) throw new Error(chunk.error.message);
        const responseData = chunk.response || chunk;
        for (const candidate of responseData.candidates || []) {
          collectImagesFromParts(candidate.content?.parts, images, text);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { images, text };
}

async function writeImage(filePath: string, image: GeneratedImage): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(image.data, "base64"));
  return filePath;
}

/**
 * Uniform image generation contract for Pi models.generateImages().
 * Never throws; returns AssistantImages with stopReason "stop" or "error" / "aborted".
 */
export async function generateAntigravityImages(
  model: AntigravityImageModelLike,
  context: ImagesContext,
  options?: ImagesOptions,
): Promise<AssistantImages> {
  const timestamp = Date.now();
  const apiKey = options?.apiKey;
  if (!apiKey) {
    return {
      api: model.api,
      provider: model.provider,
      model: model.id,
      output: [],
      stopReason: "error",
      errorMessage: "No Antigravity credentials.",
      timestamp,
    };
  }

  const textBlocks: string[] = [];
  const inputImages: Array<{ mimeType: string; data: string }> = [];
  for (const item of context.input) {
    if (item.type === "text") {
      if (item.text.trim()) textBlocks.push(item.text.trim());
    } else if (item.type === "image") {
      inputImages.push({ mimeType: item.mimeType, data: item.data });
    }
  }

  const prompt = textBlocks.join("\n\n");
  if (!prompt && inputImages.length === 0) {
    return {
      api: model.api,
      provider: model.provider,
      model: model.id,
      output: [],
      stopReason: "error",
      errorMessage: "Image prompt or input image is required.",
      timestamp,
    };
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      api: model.api,
      provider: model.provider,
      model: model.id,
      output: [],
      stopReason: "error",
      errorMessage: `Image prompt is too long (max ${MAX_PROMPT_CHARS} characters).`,
      timestamp,
    };
  }

  let aspectRatio = "1:1";
  const rawRatio = options?.metadata?.aspectRatio ?? options?.metadata?.ratio;
  if (typeof rawRatio === "string") {
    try {
      aspectRatio = assertSafeAspectRatio(rawRatio);
    } catch {
      // Keep default 1:1 if unrecognized
    }
  }

  let preferred = DEFAULT_IMAGE_MODEL;
  try {
    preferred = assertSafeImageModel(model.id || DEFAULT_IMAGE_MODEL);
  } catch {
    // Keep DEFAULT_IMAGE_MODEL if model.id is not recognized
  }
  const candidateModels = [preferred, ...IMAGE_MODEL_FALLBACKS.filter((id) => id !== preferred)];
  const creds = parseApiKey(apiKey);
  const headers = antigravityHeaders(creds.token);

  let lastError = "no endpoint available";
  for (const candidateModel of candidateModels) {
    const body = JSON.stringify(
      buildImageGenerateRequest(prompt, candidateModel, creds.projectId, aspectRatio, inputImages),
    );
    for (const endpoint of endpointCandidates()) {
      if (options?.signal?.aborted) {
        return {
          api: model.api,
          provider: model.provider,
          model: model.id,
          output: [],
          stopReason: "aborted",
          errorMessage: "Request was aborted",
          timestamp: Date.now(),
        };
      }
      try {
        // Try direct generateContent (standard official agy image endpoint)
        const response = await antigravityFetch(`${endpoint}/v1internal:generateContent`, {
          method: "POST",
          headers,
          body,
          signal: options?.signal,
        });
        if (response.ok) {
          const data: unknown = await response.json();
          const images: GeneratedImage[] = [];
          const text: string[] = [];
          const record =
            typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
          const resp =
            typeof record.response === "object" && record.response !== null
              ? (record.response as Record<string, unknown>)
              : record;
          const candidates = Array.isArray(resp.candidates) ? resp.candidates : [];
          for (const cand of candidates) {
            if (typeof cand === "object" && cand !== null) {
              const c = cand as Record<string, unknown>;
              const content =
                typeof c.content === "object" && c.content !== null
                  ? (c.content as Record<string, unknown>)
                  : undefined;
              const parts = Array.isArray(content?.parts)
                ? (content?.parts as Array<{
                    text?: string;
                    inlineData?: { mimeType?: string; data?: string };
                  }>)
                : undefined;
              collectImagesFromParts(parts, images, text);
            }
          }
          if (images.length > 0) {
            const output: Array<
              { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
            > = [];
            for (const t of text) {
              output.push({ type: "text", text: t });
            }
            for (const img of images) {
              output.push({ type: "image", data: img.data, mimeType: img.mimeType });
            }
            return {
              api: model.api,
              provider: model.provider,
              model: candidateModel,
              output,
              stopReason: "stop",
              timestamp: Date.now(),
            };
          }
        }

        // Fallback: try streamGenerateContent if direct endpoint returned 404 or empty
        const streamResponse = await antigravityFetch(
          `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
          {
            method: "POST",
            headers,
            body,
            signal: options?.signal,
          },
        );
        if (!streamResponse.ok) {
          lastError = jsonOrTextError(await streamResponse.text()).slice(0, 400);
          if (
            streamResponse.status === 404 ||
            [403, 429, 500, 502, 503, 504].includes(streamResponse.status)
          ) {
            continue;
          }
          return {
            api: model.api,
            provider: model.provider,
            model: model.id,
            output: [],
            stopReason: "error",
            errorMessage: `Antigravity image request failed (${streamResponse.status}): ${safeError(lastError)}`,
            timestamp: Date.now(),
          };
        }
        const parsed = await collectImagesFromSse(streamResponse, options?.signal);
        if (!parsed.images.length) {
          lastError = parsed.text.join(" ").trim() || "No image data returned.";
          continue;
        }

        const output: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        > = [];
        for (const t of parsed.text) {
          output.push({ type: "text", text: t });
        }
        for (const image of parsed.images) {
          output.push({ type: "image", data: image.data, mimeType: image.mimeType });
        }

        return {
          api: model.api,
          provider: model.provider,
          model: candidateModel,
          output,
          stopReason: "stop",
          timestamp: Date.now(),
        };
      } catch (error) {
        lastError = safeError(error);
        if (options?.signal?.aborted) {
          return {
            api: model.api,
            provider: model.provider,
            model: model.id,
            output: [],
            stopReason: "aborted",
            errorMessage: "Request was aborted",
            timestamp: Date.now(),
          };
        }
      }
    }
  }

  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "error",
    errorMessage: `Antigravity image generation failed: ${safeError(lastError)}`,
    timestamp: Date.now(),
  };
}

export async function generateAntigravityImage(
  options: GenerateImageOptions,
): Promise<GenerateImageResult> {
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error("Image prompt is required.");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Image prompt is too long (max ${MAX_PROMPT_CHARS} characters).`);
  }
  const aspectRatio = assertSafeAspectRatio(options.aspectRatio || "1:1");
  const preferred = assertSafeImageModel(options.model || DEFAULT_IMAGE_MODEL);

  const inputImages: Array<{ mimeType: string; data: string }> = [];
  for (const p of (options.imagePaths || []).slice(0, 3)) {
    try {
      const img = await loadImageFromPath(options.cwd, p);
      inputImages.push(img);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to load reference image "${p}": ${msg}`, { cause: e });
    }
  }

  const contextInput: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text", text: prompt }];
  for (const img of inputImages) {
    contextInput.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }

  const res = await generateAntigravityImages(
    {
      id: preferred,
      api: ANTIGRAVITY_IMAGE_API,
      provider: "antigravity",
    },
    { input: contextInput },
    {
      apiKey: options.apiKey,
      signal: options.signal,
      metadata: { aspectRatio },
    },
  );

  if (res.stopReason !== "stop") {
    throw new Error(res.errorMessage || "Antigravity image generation failed.");
  }

  const images: GeneratedImage[] = [];
  const text: string[] = [];
  for (const block of res.output) {
    if (block.type === "image") {
      images.push({ data: block.data, mimeType: block.mimeType });
    } else if (block.type === "text") {
      text.push(block.text);
    }
  }

  const savedPaths: string[] = [];
  const many = images.length > 1;
  for (const [index, image] of images.entries()) {
    savedPaths.push(
      await writeImage(
        resolveImageSavePath(
          options.cwd,
          options.path,
          options.imageName,
          image.mimeType,
          many ? index : undefined,
        ),
        image,
      ),
    );
  }

  return { images, savedPaths, text, model: res.model };
}
