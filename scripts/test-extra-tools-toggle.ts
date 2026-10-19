import assert from "node:assert/strict";
import registerImage from "../src/features/generate-image.js";
import registerFetch from "../src/features/read-url-content.js";
import registerSearch from "../src/features/google-search.js";
import register from "../src/index.js";

const TOGGLES = ["NO_EXTRA_TOOLS", "NO_SEARCH_TOOL", "NO_IMAGE_TOOL", "NO_FETCH_TOOL"];

function registeredTools(env: Record<string, string>): { tools: string[]; commands: string[] } {
  const saved = new Map<string, string | undefined>();
  for (const name of TOGGLES) {
    for (const key of [`ANTIGRAVITY_${name}`, `NOAGY_${name}`]) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
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
  try {
    const api = pi as Parameters<typeof register>[0];
    register(api);
    registerSearch(api);
    registerImage(api);
    registerFetch(api);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { tools: tools.sort(), commands };
}

const all = ["generate_image", "google_search", "read_url_content"];
assert.deepEqual(registeredTools({}).tools, all, "all extra tools are registered by default");
assert.deepEqual(registeredTools({ ANTIGRAVITY_NO_EXTRA_TOOLS: "1" }).tools, [], "umbrella toggle");
assert.deepEqual(
  registeredTools({ ANTIGRAVITY_NO_SEARCH_TOOL: "1" }).tools,
  ["generate_image", "read_url_content"],
  "search toggle keeps the other tools",
);
assert.deepEqual(
  registeredTools({ ANTIGRAVITY_NO_IMAGE_TOOL: "1" }).tools,
  ["google_search", "read_url_content"],
  "image toggle keeps the other tools",
);
assert.deepEqual(
  registeredTools({ ANTIGRAVITY_NO_FETCH_TOOL: "1" }).tools,
  ["generate_image", "google_search"],
  "fetch toggle keeps the other tools",
);
assert.deepEqual(
  registeredTools({ NOAGY_NO_SEARCH_TOOL: "1" }).tools,
  ["generate_image", "read_url_content"],
  "legacy NOAGY_ prefix is honoured",
);
assert.deepEqual(registeredTools({ ANTIGRAVITY_NO_SEARCH_TOOL: "0" }).tools, all, "only 1 disables");

// Slash commands are explicit user actions and stay available when the tools are off.
const { commands } = registeredTools({ ANTIGRAVITY_NO_EXTRA_TOOLS: "1" });
assert.ok(
  commands.includes("antigravity.search") &&
    commands.includes("antigravity.image") &&
    commands.includes("antigravity.fetch"),
);

console.log(
  "extra tools toggle: default, umbrella, per-tool, legacy prefix, commands kept passed",
);
