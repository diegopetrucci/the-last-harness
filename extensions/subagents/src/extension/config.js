import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../shared/utils.js";
export function getConfigPath() {
    return path.join(getAgentDir(), "extensions", "subagent", "config.json");
}
function readConfigForUpdate(configPath = getConfigPath()) {
    if (!fs.existsSync(configPath))
        return {};
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Subagent config at '${configPath}' must be a JSON object`);
    }
    return parsed;
}
export function saveConfig(config, configPath = getConfigPath()) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
}
export function updateConfig(updater) {
    const configPath = getConfigPath();
    const next = updater(readConfigForUpdate(configPath));
    saveConfig(next, configPath);
    return next;
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
