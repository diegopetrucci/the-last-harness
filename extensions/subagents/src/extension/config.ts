import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig } from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";

function getConfigPath(): string {
  return path.join(getAgentDir(), "extensions", "subagent", "config.json");
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copy a JSON value as an own data property without invoking __proto__ setters. */
function defineOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function readConfigForUpdate(configPath = getConfigPath()): ExtensionConfig {
  if (!fs.existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  if (!isConfigObject(parsed)) {
    throw new Error(`Subagent config at '${configPath}' must be a JSON object`);
  }

  // Keep this settings object intentionally open: existing and future keys are
  // tolerated, while the artifact block is copied into its own boundary type so
  // the shared resolver can validate the only field TLH consumes (`mode`).
  const config: ExtensionConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "artifacts") defineOwnProperty(config, key, value);
  }

  if (Object.hasOwn(parsed, "artifacts")) {
    const rawArtifacts = parsed.artifacts;
    const artifacts: Record<string, unknown> = {};
    if (isConfigObject(rawArtifacts)) {
      if (Object.hasOwn(rawArtifacts, "mode")) {
        defineOwnProperty(artifacts, "mode", rawArtifacts.mode);
      }
    } else {
      // Preserve an invalid block as an invalid mode value for the shared
      // resolver to reject safely, rather than silently changing the config.
      defineOwnProperty(artifacts, "mode", rawArtifacts);
    }
    defineOwnProperty(config, "artifacts", artifacts);
  }
  return config;
}

export function loadConfig(): ExtensionConfig {
  const configPath = getConfigPath();
  try {
    return readConfigForUpdate(configPath);
  } catch (error) {
    console.error(`Failed to load subagent config from '${configPath}':`, error);
  }
  return {};
}
