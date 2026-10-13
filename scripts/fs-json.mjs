import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function authPath() {
  return (
    process.env.PI_AUTH_PATH ||
    join(process.env.HOME || process.env.USERPROFILE || homedir(), ".pi", "agent", "auth.json")
  );
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function scriptDir(metaUrl) {
  return dirname(fileURLToPath(metaUrl));
}
