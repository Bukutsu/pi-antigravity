import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerImage from "../src/features/generate-image.js";
import registerFetch from "../src/features/read-url-content.js";
import registerSearch from "../src/features/google-search.js";
import register from "../src/index.js";

const TOGGLES = ["NO_EXTRA_TOOLS", "NO_SEARCH_TOOL", "NO_IMAGE_TOOL", "NO_FETCH_TOOL", "DEFER_TOOLS"];

function withEnv<T>(env: Record<string, string>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const name of TOGGLES) {
    for (const key of [`ANTIGRAVITY_${name}`, `NOAGY_${name}`]) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function registeredTools(env: Record<string, string>): { tools: string[]; commands: string[] } {
  const tools: string[] = [];
  const commands: string[] = [];
  const pi = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "registerTool") return (tool: { name: string }) => tools.push(tool.name);
        if (prop === "registerCommand") return (name: string) => commands.push(name);
        return () => undefined;
      },
    },
  );
  withEnv(env, () => {
    const api = pi as Parameters<typeof register>[0];
    register(api);
    registerSearch(api);
    registerImage(api);
    registerFetch(api);
  });
  return { tools: tools.sort(), commands };
}

type ToolDefinition = {
  name: string;
  exposure?: string;
};

function featureDefinitions(env: Record<string, string>): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  const pi = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "registerTool") {
          return (tool: ToolDefinition) => definitions.push(tool);
        }
        throw new Error(`Unexpected feature API: ${String(prop)}`);
      },
    },
  );
  withEnv(env, () => {
    registerSearch(pi as ExtensionAPI);
    registerImage(pi as ExtensionAPI);
    registerFetch(pi as ExtensionAPI);
  });
  return definitions;
}

const allTools = ["generate_image", "google_search", "read_url_content"];
assert.deepEqual(registeredTools({}).tools, allTools, "all tools are registered by default");
assert.deepEqual(registeredTools({ ANTIGRAVITY_NO_EXTRA_TOOLS: "1" }).tools, [], "umbrella toggle");
assert.deepEqual(
  registeredTools({ ANTIGRAVITY_NO_SEARCH_TOOL: "1" }).tools,
  ["generate_image", "read_url_content"],
  "search toggle keeps image and fetch tools",
);
assert.deepEqual(
  registeredTools({ ANTIGRAVITY_NO_IMAGE_TOOL: "1" }).tools,
  ["google_search", "read_url_content"],
  "image toggle keeps search and fetch tools",
);
assert.deepEqual(
  registeredTools({ ANTIGRAVITY_NO_FETCH_TOOL: "1" }).tools,
  ["generate_image", "google_search"],
  "fetch toggle keeps image and search tools",
);
assert.deepEqual(
  registeredTools({ NOAGY_NO_SEARCH_TOOL: "1" }).tools,
  ["generate_image", "read_url_content"],
  "legacy NOAGY_ prefix is honoured",
);
assert.deepEqual(
  registeredTools({ NOAGY_NO_FETCH_TOOL: "1" }).tools,
  ["generate_image", "google_search"],
  "legacy fetch toggle is honoured",
);
assert.deepEqual(
  registeredTools({ ANTIGRAVITY_NO_SEARCH_TOOL: "0" }).tools,
  allTools,
  "only 1 disables",
);

// Slash commands are explicit user actions and stay available when the tools are off.
const { commands } = registeredTools({ ANTIGRAVITY_NO_EXTRA_TOOLS: "1" });
assert.ok(
  commands.includes("antigravity.search") &&
    commands.includes("antigravity.image") &&
    commands.includes("antigravity.fetch"),
);

for (const env of [{}, { ANTIGRAVITY_DEFER_TOOLS: "0" }]) {
  const definitions = featureDefinitions(env);
  assert.equal(definitions.length, 3);
  assert.ok(definitions.every((tool) => !("exposure" in tool)));
}

for (const env of [
  { ANTIGRAVITY_DEFER_TOOLS: "1" },
  { NOAGY_DEFER_TOOLS: "1" },
]) {
  const definitions = featureDefinitions(env);
  assert.deepEqual(
    definitions.map((tool) => ({ name: tool.name, exposure: tool.exposure })),
    [
      { name: "google_search", exposure: "deferred" },
      { name: "generate_image", exposure: "deferred" },
      { name: "read_url_content", exposure: "deferred" },
    ],
  );
}

for (const [toggle, expectedNames] of [
  ["NO_SEARCH_TOOL", ["generate_image", "read_url_content"]],
  ["NO_IMAGE_TOOL", ["google_search", "read_url_content"]],
  ["NO_FETCH_TOOL", ["google_search", "generate_image"]],
] as const) {
  const definitions = featureDefinitions({
    ANTIGRAVITY_DEFER_TOOLS: "1",
    [`ANTIGRAVITY_${toggle}`]: "1",
  });
  assert.deepEqual(definitions.map((tool) => tool.name), expectedNames);
}

console.log("extra tools toggle: disables, deferred exposure passed");
