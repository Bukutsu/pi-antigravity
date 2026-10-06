import { relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
// Namespace import: Oh My Pi rewrites this specifier onto bundled pi-ai, which
// does not export registerApiProvider. A static named import fails plugin load.
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import {
  activateAccount,
  getApiKey,
  listAccounts,
  loginAntigravity,
  rememberAccount,
  refreshAntigravityToken,
  removeAccount,
  updateRememberedAccount,
} from "./auth/index.js";
import { DEFAULT_ENDPOINT } from "./client/index.js";
import { getLastDiagnostics, runWithDiagnostics } from "./diagnostics/index.js";
import {
  ANTIGRAVITY_IMAGE_API,
  ANTIGRAVITY_IMAGE_MODELS,
  DEFAULT_IMAGE_MODEL,
  generateAntigravityImage,
  generateAntigravityImages,
  IMAGE_ASPECT_RATIOS,
  parseImageCommandArgs,
} from "./image/index.js";
import { executeAntigravitySearch, parseSearchCommandArgs } from "./search/index.js";
import {
  applyAntigravityCatalog,
  discoverAntigravityModels,
  getCurrentAntigravityCatalog,
  PROVIDER_ID,
  PROVIDER_NAME,
  refreshAntigravityModels,
  resolvedCatalog,
} from "./models/index.js";
import { ANTIGRAVITY_API, streamAntigravity } from "./stream/index.js";
import {
  fetchAccountUsage,
  formatModelsList,
  formatUsageSummary,
  resolveApiKeyFromContext,
} from "./usage/index.js";
import { isExtraToolEnabled, redactSecrets, maskEmail } from "./utils/index.js";

/**
 * Pi's interactive `notify` writes into the chat transcript. `console.log` in that
 * mode prints to the raw terminal and paints over the TUI. Use one channel only.
 */
function emitCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") console.error(text);
  else console.log(text);
}

async function loginAndRemember(
  callbacks: Parameters<typeof loginAntigravity>[0],
): ReturnType<typeof loginAntigravity> {
  const credentials = await loginAntigravity(callbacks);
  rememberAccount(credentials);
  return credentials;
}

async function refreshAndRemember(
  credentials: Parameters<typeof refreshAntigravityToken>[0],
): ReturnType<typeof refreshAntigravityToken> {
  const refreshed = await refreshAntigravityToken(credentials);
  updateRememberedAccount(credentials, refreshed);
  return refreshed;
}

async function withUsage(
  ctx: ExtensionCommandContext,
  fn: (usage: Awaited<ReturnType<typeof fetchAccountUsage>>) => string,
): Promise<void> {
  try {
    const apiKey = await resolveApiKeyFromContext(ctx);
    if (!apiKey) {
      emitCommandOutput(
        ctx,
        "No Antigravity credentials. Run /login antigravity first.",
        "warning",
      );
      return;
    }
    if (ctx.hasUI) ctx.ui.notify("Fetching Antigravity usage…", "info");
    const usage = await runWithDiagnostics(() => fetchAccountUsage(apiKey));
    emitCommandOutput(ctx, fn(usage));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emitCommandOutput(ctx, `Antigravity usage failed: ${msg}`, "warning");
  }
}

type CompatApiProviderRegistrar = (provider: {
  api: typeof ANTIGRAVITY_API;
  stream: typeof streamAntigravity;
  streamSimple: typeof streamAntigravity;
}) => void;

type CompatImagesProviderRegistrar = (provider: {
  api: typeof ANTIGRAVITY_IMAGE_API;
  generateImages: typeof generateAntigravityImages;
}) => void;

interface AntigravityProviderRegistrationConfig {
  name: string;
  baseUrl: string;
  api: typeof ANTIGRAVITY_API;
  models: ProviderModelConfig[];
  refreshModels: (
    context: Parameters<typeof refreshAntigravityModels>[0],
  ) => Promise<ProviderModelConfig[]>;
  oauth: {
    name: string;
    login: typeof loginAndRemember;
    refreshToken: typeof refreshAndRemember;
    getApiKey: typeof getApiKey;
  };
  streamSimple: typeof streamAntigravity;
  images?: Record<
    string,
    {
      generateImages: typeof generateAntigravityImages;
    }
  >;
}

/**
 * Pi dispatches custom APIs through the compat registry. Oh My Pi does not
 * export `registerApiProvider` and registers the stream inside `registerProvider`.
 */
function registerCompatApiProvider(): void {
  const register = (piAiCompat as { registerApiProvider?: CompatApiProviderRegistrar })
    .registerApiProvider;
  if (typeof register === "function") {
    register({
      api: ANTIGRAVITY_API,
      stream: streamAntigravity,
      streamSimple: streamAntigravity,
    });
  }
  const registerImages = (
    piAiCompat as unknown as {
      registerImagesApiProvider?: CompatImagesProviderRegistrar;
    }
  ).registerImagesApiProvider;
  if (typeof registerImages === "function") {
    registerImages({
      api: ANTIGRAVITY_IMAGE_API,
      generateImages: generateAntigravityImages,
    });
  }
}

export default function (pi: ExtensionAPI): void {
  registerCompatApiProvider();

  const initialCatalog = getCurrentAntigravityCatalog();

  const providerConfig: AntigravityProviderRegistrationConfig = {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: ANTIGRAVITY_API,
    models: [...initialCatalog.models, ...ANTIGRAVITY_IMAGE_MODELS],
    refreshModels: async (context) => {
      const refreshed = await refreshAntigravityModels(context);
      return [...refreshed, ...ANTIGRAVITY_IMAGE_MODELS];
    },
    oauth: {
      name: PROVIDER_NAME,
      login: loginAndRemember,
      refreshToken: refreshAndRemember,
      getApiKey,
    },
    streamSimple: streamAntigravity,
    images: {
      [ANTIGRAVITY_IMAGE_API]: {
        generateImages: generateAntigravityImages,
      },
    },
  };

  pi.registerProvider(
    PROVIDER_ID,
    providerConfig as unknown as Parameters<typeof pi.registerProvider>[1],
  );

  pi.registerCommand("antigravity.usage", {
    description: "Show Antigravity shared quota pools (Gemini / Claude+GPT, 5h + weekly)",
    handler: async (_args, ctx) => {
      await withUsage(ctx, formatUsageSummary);
    },
  });

  pi.registerCommand("antigravity.models", {
    description: "List Antigravity runtime models + remaining pool fraction",
    handler: async (args, ctx) => {
      const all = /\ball\b/i.test(args || "");
      await withUsage(ctx, (usage) => formatModelsList(usage, { all }));
    },
  });

  pi.registerCommand("antigravity.accounts", {
    description: "List, switch, or remove linked Antigravity Google accounts",
    handler: async (args, ctx) => {
      const command = args.trim();
      try {
        if (command.startsWith("switch ")) {
          const account = await activateAccount(command.slice("switch ".length));
          emitCommandOutput(
            ctx,
            `Active Antigravity account: ${account.email || account.accountId}`,
          );
          return;
        }
        if (command.startsWith("remove ")) {
          const remaining = await removeAccount(command.slice("remove ".length));
          const next = remaining
            ? ` Active account is now ${remaining.email || remaining.accountId}.`
            : "";
          emitCommandOutput(ctx, `Antigravity account removed.${next}`);
          return;
        }
        const accounts = listAccounts();
        if (accounts.length === 0) {
          emitCommandOutput(
            ctx,
            "No linked Antigravity accounts. Run /login antigravity to add one.",
            "warning",
          );
          return;
        }
        const lines = accounts.map(
          (account, index) =>
            `${account.active ? "* " : "  "}${index + 1}. ${account.email || account.accountId}`,
        );
        emitCommandOutput(
          ctx,
          `${lines.join("\n")}\nUse /antigravity.accounts switch <index|email> or /antigravity.accounts remove <index|email>.`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, msg, "error");
      }
    },
  });

  pi.registerCommand("antigravity.refresh", {
    description: "Force refresh Antigravity dynamic model catalog",
    handler: async (_args, ctx) => {
      const apiKey = await resolveApiKeyFromContext(ctx);
      if (!apiKey) {
        emitCommandOutput(
          ctx,
          "No Antigravity credentials. Run /login antigravity first.",
          "warning",
        );
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Refreshing Antigravity models…", "info");
      try {
        if (typeof ctx.modelRegistry?.refresh === "function") {
          const result = await ctx.modelRegistry.refresh({
            force: true,
            providers: [PROVIDER_ID],
          });
          if (result?.errors?.has(PROVIDER_ID)) {
            throw result.errors.get(PROVIDER_ID)!;
          }
        } else {
          const discovered = await discoverAntigravityModels(apiKey);
          const next = resolvedCatalog(discovered, getCurrentAntigravityCatalog());
          if (discovered.models.length > 0) {
            applyAntigravityCatalog(next);
          }
        }
        const catalog = getCurrentAntigravityCatalog();
        const count = catalog.models.length;
        const sample = catalog.models
          .slice(0, 4)
          .map((m) => m.name || m.id)
          .join(", ");
        emitCommandOutput(
          ctx,
          `Antigravity models refreshed (${count} available: ${sample}${count > 4 ? ", …" : ""})`,
          "info",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Antigravity model refresh failed: ${redactSecrets(msg)}`, "error");
      }
    },
  });

  pi.registerCommand("antigravity.doctor", {
    description: "Show sanitized Antigravity provider diagnostics",
    handler: async (_args, ctx) => {
      const d = getLastDiagnostics();
      const accounts = listAccounts();
      const active = accounts.find((account) => account.active);
      const activeLabel = active
        ? maskEmail(active.email) ||
          (active.accountId.includes("@") ? maskEmail(active.accountId) : active.accountId)
        : "none";
      const lines = [
        `provider=${PROVIDER_ID}`,
        `lastResolvedRuntimeModel=${d.resolvedRuntimeModel || "none"}`,
        `availableModels=${d.availableModels || "none"}`,
        `matchedModel=${d.matchedModelDebug || "none"}`,
        `lastEndpoint=${d.endpoint || "none"}`,
        `lastStatus=${d.status ?? "none"}`,
        `lastProjectId=${d.projectId || "none"}`,
        `linkedAccounts=${accounts.length || "none"}`,
        `activeAccount=${activeLabel || "none"}`,
        ...(d.latencyMs !== undefined ? [`lastLatencyMs=${d.latencyMs}`] : []),
        `toolSchemaWarnings=${d.toolSchemaWarnings || "none"}`,
        `lastError=${d.error ? redactSecrets(d.error) : "none"}`,
        "transport=native-streamSimple",
        "runtimeCli=not-used",
        "commands=/antigravity.usage /antigravity.models /antigravity.accounts /antigravity.refresh /antigravity.doctor /antigravity.image /antigravity.search",
      ];
      emitCommandOutput(ctx, `Antigravity doctor\n${lines.join("\n")}`);
    },
  });

  pi.registerCommand("antigravity.image", {
    description:
      "Generate or edit an image via Antigravity (usage: /antigravity.image [--name <image_name>] [--ratio 16:9] [--image <ref.png>] <prompt>)",
    handler: async (args, ctx) => {
      const parsed = parseImageCommandArgs(args || "");
      if (!parsed.prompt) {
        emitCommandOutput(
          ctx,
          "Usage: /antigravity.image [--name <image_name>] [--ratio 16:9] [--image <path>] [--model gemini-3.1-flash-image] [--path file.png] <prompt>",
          "warning",
        );
        return;
      }
      try {
        const apiKey = await resolveApiKeyFromContext(ctx);
        if (!apiKey) {
          emitCommandOutput(
            ctx,
            "No Antigravity credentials. Run /login antigravity first.",
            "warning",
          );
          return;
        }
        if (ctx.hasUI) ctx.ui.notify("Generating Antigravity image…", "info");
        const result = await generateAntigravityImage({
          apiKey,
          cwd: ctx.cwd,
          prompt: parsed.prompt,
          aspectRatio: parsed.aspectRatio,
          imageName: parsed.imageName,
          imagePaths: parsed.imagePaths,
          model: parsed.model,
          path: parsed.path,
        });
        emitCommandOutput(ctx, `Saved image to ${result.savedPaths.join(", ")}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Antigravity image failed: ${redactSecrets(msg)}`, "warning");
      }
    },
  });

  pi.registerCommand("antigravity.search", {
    description:
      "Search the web via Antigravity Grounding (usage: /antigravity.search [--thinking] [--url <url>] <query>)",
    handler: async (args, ctx) => {
      const parsed = parseSearchCommandArgs(args || "");
      if (!parsed.query) {
        emitCommandOutput(
          ctx,
          "Usage: /antigravity.search [--thinking] [--url <url>] <query>",
          "warning",
        );
        return;
      }
      try {
        const apiKey = await resolveApiKeyFromContext(ctx);
        if (!apiKey) {
          emitCommandOutput(
            ctx,
            "No Antigravity credentials. Run /login antigravity first.",
            "warning",
          );
          return;
        }
        if (ctx.hasUI) ctx.ui.notify("Searching Google via Antigravity Grounding…", "info");
        const result = await executeAntigravitySearch({
          apiKey,
          query: parsed.query,
          urls: parsed.urls,
          thinking: parsed.thinking,
        });
        emitCommandOutput(ctx, result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Antigravity search failed: ${redactSecrets(msg)}`, "warning");
      }
    },
  });

  if (isExtraToolEnabled("IMAGE")) {
    pi.registerTool({
      name: "generate_image",
      label: "Generate image",
      description:
        "Generate and edit images via Antigravity (Gemini 3.1 Flash Image). Supports detailed prompts, aspect ratios, image naming, and reference images for image-to-image editing.",
      promptSnippet:
        "Generate and edit images via Antigravity (Gemini 3.1 Flash Image / Nano Banana 2)",
      promptGuidelines: [
        "Use generate_image when the user asks to create, draw, edit, or generate an image.",
        "Write a detailed prompt: subject, style, composition, lighting, and any exact text in quotes.",
        "Provide a short descriptive image_name in lowercase with underscores (e.g. 'login_mockup', 'cyber_koi'). Maximum 3 words.",
        "Pass source or reference images via image_paths when editing, combining, or using existing images as reference (maximum 3 images).",
        "Check each result against the brief. If it clearly misses, fix the prompt; at most 3 attempts per image.",
      ],
      parameters: Type.Object({
        prompt: Type.String({
          description:
            "The text prompt describing the image to generate or the edit instructions. Be detailed: subject, style, composition, lighting, and any exact text in quotes.",
        }),
        image_name: Type.Optional(
          Type.String({
            description:
              "Short descriptive filename for the saved image. Should be all lowercase with underscores, describing what the image contains (e.g. 'login_mockup', 'cyber_koi'). Maximum 3 words.",
          }),
        ),
        imageName: Type.Optional(
          Type.String({
            description: "Alias for image_name.",
          }),
        ),
        image_paths: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Optional paths to existing images on disk to edit, combine, or use as visual reference (maximum 3 images).",
          }),
        ),
        imagePaths: Type.Optional(
          Type.Array(Type.String(), {
            description: "Alias for image_paths.",
          }),
        ),
        aspect_ratio: Type.Optional(
          StringEnum(IMAGE_ASPECT_RATIOS, {
            description:
              "Optional aspect ratio for the generated image. Supported values: '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'. Default is '1:1'.",
          }),
        ),
        aspectRatio: Type.Optional(
          StringEnum(IMAGE_ASPECT_RATIOS, {
            description: "Alias for aspect_ratio.",
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: `Image model id. Default: ${DEFAULT_IMAGE_MODEL}.`,
          }),
        ),
        path: Type.Optional(
          Type.String({
            description:
              "Project-relative file or directory to save the image (overrides default naming).",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
        if (!apiKey) {
          throw new Error("No Antigravity credentials. Run /login antigravity first.");
        }
        onUpdate?.({ content: [{ type: "text", text: "Generating image…" }], details: {} });
        const result = await generateAntigravityImage({
          apiKey,
          cwd: ctx.cwd,
          prompt: params.prompt,
          aspectRatio: params.aspect_ratio || params.aspectRatio,
          imageName: params.image_name || params.imageName,
          imagePaths: params.image_paths || params.imagePaths,
          model: params.model,
          path: params.path,
          signal,
        });
        const savedList = result.savedPaths
          .map((p) => {
            const rel = relative(ctx.cwd, p);
            return `- **File**: [${rel}](${rel})`;
          })
          .join("\n");
        const notes = result.text.join(" ").trim();
        return {
          content: [
            {
              type: "text" as const,
              text: `The image has been generated:\n\n${savedList}${notes ? `\n\n${notes}` : ""}`,
            },
            ...result.images.map((image) => ({
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            })),
          ],
          details: { model: result.model, savedPaths: result.savedPaths },
        };
      },
    });
  }

  if (isExtraToolEnabled("SEARCH")) {
    pi.registerTool({
      name: "google_search",
      label: "Google Search",
      description:
        "Search the web using Google Search via Antigravity Grounding powered by Gemini 3 Flash. Returns real-time web results with multi-angle deep search and source citations. Use this whenever current, real-time information or web research is needed.",
      promptSnippet: "Real-time Google Search grounding via Antigravity (Gemini 3 Flash)",
      promptGuidelines: [
        "Use google_search when you need real-time, up-to-date web information, latest news, documentation, or fact checking.",
        "Pass specific URLs into the urls array if you want the search engine to fetch and analyze specific pages.",
        "Set instruction to provide special research directives from the lead agent (e.g. focus on issues, compare benchmarks, restrict time range).",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "Search query or question." }),
        instruction: Type.Optional(
          Type.String({
            description:
              "Specific directive or focus from the lead agent (e.g., '重点关注英文社区近七天的讨论', 'focus on GitHub issues and benchmarks', 'ignore marketing announcements').",
          }),
        ),
        urls: Type.Optional(
          Type.Array(Type.String(), {
            description: "Optional specific URLs to fetch and analyze alongside the search.",
          }),
        ),
        thinking: Type.Optional(
          Type.Boolean({
            description: "Enable deeper thinking for complex analysis (default: false).",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
        if (!apiKey) {
          throw new Error("No Antigravity credentials. Run /login antigravity first.");
        }
        onUpdate?.({
          content: [{ type: "text", text: `Searching Google for: "${params.query}"…` }],
          details: {},
        });
        try {
          const result = await executeAntigravitySearch({
            apiKey,
            query: params.query,
            instruction: params.instruction,
            urls: params.urls,
            thinking: params.thinking,
            signal,
          });
          return {
            content: [{ type: "text", text: result }],
            details: {},
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          throw new Error(redactSecrets(msg), { cause: error });
        }
      },
    });
  }
}
