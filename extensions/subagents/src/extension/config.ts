import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig } from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";

export function getConfigPath(): string {
  return path.join(getAgentDir(), "extensions", "subagent", "config.json");
}

function readConfigForUpdate(configPath = getConfigPath()): ExtensionConfig {
  if (!fs.existsSync(configPath)) return {};
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Subagent config at '${configPath}' must be a JSON object`);
  }
  return parsed as ExtensionConfig;
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
