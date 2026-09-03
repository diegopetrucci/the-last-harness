import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../shared/utils.js";
function getConfigPath() {
    return path.join(getAgentDir(), "extensions", "subagent", "config.json");
}
function isConfigObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function defineOwnProperty(target, key, value) {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    });
}
function readConfigForUpdate(configPath = getConfigPath()) {
    if (!fs.existsSync(configPath))
        return {};
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!isConfigObject(parsed)) {
        throw new Error(`Subagent config at '${configPath}' must be a JSON object`);
    }
    const config = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (key !== "artifacts")
            defineOwnProperty(config, key, value);
    }
    if (Object.hasOwn(parsed, "artifacts")) {
        const rawArtifacts = parsed.artifacts;
        const artifacts = {};
        if (isConfigObject(rawArtifacts)) {
            if (Object.hasOwn(rawArtifacts, "mode")) {
                defineOwnProperty(artifacts, "mode", rawArtifacts.mode);
            }
        }
        else {
            defineOwnProperty(artifacts, "mode", rawArtifacts);
        }
        defineOwnProperty(config, "artifacts", artifacts);
    }
    return config;
}
export function loadConfig() {
    const configPath = getConfigPath();
    try {
        return readConfigForUpdate(configPath);
    }
    catch (error) {
        console.error(`Failed to load subagent config from '${configPath}':`, error);
    }
    return {};
}
