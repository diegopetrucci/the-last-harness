import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { readDefaultExtensions } from "../../scripts/lib/default-extensions.mjs";

export const repoRoot = resolve(import.meta.dirname, "../..");
const mergeScript = join(repoRoot, "scripts", "merge-settings.mjs");
const defaultsScript = join(repoRoot, "scripts", "tlh-defaults.mjs");

export const harnessPackage = "git:github.com/diegopetrucci/the-last-harness";
export const retiredPlannotatorPackage = "npm:@plannotator/pi-extension";
export const bundledExtensionsPath = join(repoRoot, "config", "default-extensions.json");
export const previousMcporterSource = "git:github.com/diegopetrucci/pi-mcp-adapter@tlh-v2.10.0-1";
export const previousBundledMcporterSource = "npm:@diegopetrucci/pi-mcp-adapter@2.10.1";
export const previousBundledDirtyRepoGuardSource = "npm:@diegopetrucci/pi-dirty-repo-guard@0.1.5";
export const previousPiWebAccessSource = "git:github.com/diegopetrucci/pi-web-access@tlh-v0.10.7-1";
export const piTranscribeGitSource =
  "git:github.com/earendil-works/pi-transcribe@e4c1b04c9a383a0b95c2ef7bbd8d39cf90437ec1";
export const piTranscribeNpmSource = "npm:@earendil-works/pi-transcribe@0.0.1";

export function tempFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tlh-defaults-test-"));
  const defaults = join(dir, "settings.defaults.json");
  const extensions = join(dir, "default-extensions.json");
  const settings = join(dir, "settings.json");
  writeFileSync(defaults, JSON.stringify({ packages: [] }, null, 2));
  return { dir, defaults, extensions, settings };
}

export function runNode(script, args, env = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function packageSourceOf(entry) {
  return typeof entry === "string" ? entry : entry?.source;
}

export function backupFiles(settingsPath) {
  return readdirSync(dirname(settingsPath))
    .filter((name) => name.startsWith("settings.json.backup-tlh-defaults-"))
    .sort();
}

export function symlinkFile(target, path) {
  if (process.platform === "win32") {
    symlinkSync(target, path, "file");
    return;
  }
  symlinkSync(target, path);
}

export function bundledExtension(id) {
  return readDefaultExtensions(bundledExtensionsPath).find((extension) => extension.id === id);
}

export function bundledSource(id) {
  return bundledExtension(id)?.source;
}

export const disablingExtensionFilterCases = Object.freeze([
  Object.freeze({ name: "empty extensions list", extensions: Object.freeze([]) }),
  Object.freeze({ name: "dash wildcard exclusion", extensions: Object.freeze(["-*"]) }),
  Object.freeze({ name: "bang wildcard exclusion", extensions: Object.freeze(["!*"]) }),
  Object.freeze({
    name: "real subagents entrypoint exclusion",
    extensions: Object.freeze(["-src/extension/index.ts"]),
  }),
  Object.freeze({ name: "bang src tree exclusion", extensions: Object.freeze(["!src/**"]) }),
  Object.freeze({
    name: "allowlist excluding hard-coded entrypoint",
    extensions: Object.freeze(["other.ts"]),
  }),
  Object.freeze({
    name: "allowlist excluding real subagents entrypoint",
    extensions: Object.freeze(["index.ts"]),
  }),
]);

export { defaultsScript, mergeScript };
