import * as os from "node:os";
import * as path from "node:path";
import { getConfigDirName } from "./config-dir.js";
function defaultAgentDir() {
    return path.join(os.homedir(), getConfigDirName(), "agent");
}
export function expandTildePath(value) {
    if (value === "~")
        return os.homedir();
    return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}
export function hasCustomPiAgentDir() {
    return Boolean(process.env.PI_CODING_AGENT_DIR?.trim());
}
export function getPiAgentDir() {
    const configured = process.env.PI_CODING_AGENT_DIR?.trim();
    if (!configured)
        return defaultAgentDir();
    return path.resolve(expandTildePath(configured));
}
function getGlobalAgentsDir() {
    return path.join(os.homedir(), ".agents");
}
export function getLegacyGlobalAgentsDir() {
    return hasCustomPiAgentDir() ? undefined : getGlobalAgentsDir();
}
export function isGlobalAgentsDir(value) {
    return path.resolve(value) === path.resolve(getGlobalAgentsDir());
}
