import { join } from "node:path";
import { SettingsManager, getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
const REWRITE_TIMEOUT_MS = 2_000;
const MIN_SUPPORTED_RTK_MINOR = 23;
const TLH_RTK_EXTENSION_STATE = Symbol.for("tlh.rtkExtensionState");
function parseSemver(raw) {
    const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match)
        return null;
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}
function isRtkSettingDisabled(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return settings.tlh?.rtk?.disabled === true;
    }
    catch {
        return false;
    }
}
function isSupportedRtkVersion(versionOutput) {
    const parsed = parseSemver(versionOutput.replace(/^rtk\s+/, ""));
    if (!parsed)
        return true;
    const [major, minor] = parsed;
    return major !== 0 || minor >= MIN_SUPPORTED_RTK_MINOR;
}
async function probeRtkCommand(pi, command) {
    try {
        const version = await pi.exec(command, ["--version"], { timeout: REWRITE_TIMEOUT_MS });
        if (version.code !== 0) {
            return { ok: false, command, reason: "missing" };
        }
        const versionOutput = version.stdout.trim();
        if (!isSupportedRtkVersion(version.stdout)) {
            return { ok: false, command, reason: "too-old", version: versionOutput };
        }
        return { ok: true, command, version: versionOutput };
    }
    catch {
        return { ok: false, command, reason: "missing" };
    }
}
function describeUnusableRtk(probe, label) {
    if (probe.reason === "too-old") {
        const versionDetail = probe.version ? ` (${probe.version})` : "";
        return `${label}${versionDetail} is too old (need >= 0.23.0)`;
    }
    return `${label} is unavailable`;
}
async function resolveRtkCommand(pi) {
    const pathProbe = await probeRtkCommand(pi, "rtk");
    if (pathProbe.ok) {
        return pathProbe.command;
    }
    const managedCommand = join(getAgentDir(), "bin", "rtk");
    const managedProbe = await probeRtkCommand(pi, managedCommand);
    if (managedProbe.ok) {
        return managedProbe.command;
    }
    console.warn(`[rtk] ${describeUnusableRtk(pathProbe, "rtk in PATH")} and ${describeUnusableRtk(managedProbe, `managed fallback ${managedCommand}`)} — extension disabled`);
    return null;
}
async function rewriteCommand(pi, rtkCommand, cmd, signal) {
    const result = await pi.exec(rtkCommand, ["rewrite", cmd], {
        timeout: REWRITE_TIMEOUT_MS,
        signal,
    });
    if (result.killed)
        return null;
    if (result.code !== 0 && result.code !== 3)
        return null;
    return result.stdout.trim() || null;
}
export default async function rtk(pi) {
    if (process.env.RTK_DISABLED === "1") {
        return;
    }
    const markedPi = pi;
    if (markedPi[TLH_RTK_EXTENSION_STATE]) {
        return;
    }
    markedPi[TLH_RTK_EXTENSION_STATE] = "activating";
    try {
        const rtkCommand = await resolveRtkCommand(pi);
        if (!rtkCommand) {
            delete markedPi[TLH_RTK_EXTENSION_STATE];
            return;
        }
        markedPi[TLH_RTK_EXTENSION_STATE] = "active";
        pi.on("tool_call", async (event, ctx) => {
            try {
                if (!isToolCallEventType("bash", event))
                    return;
                const cmd = event.input.command;
                if (typeof cmd !== "string" || cmd.trim() === "")
                    return;
                if (cmd === "rtk" || cmd.startsWith("rtk "))
                    return;
                if (process.env.RTK_DISABLED === "1")
                    return;
                if (isRtkSettingDisabled(ctx.cwd))
                    return;
                const rewritten = await rewriteCommand(pi, rtkCommand, cmd, ctx.signal);
                if (rewritten && rewritten !== cmd) {
                    event.input.command = rewritten;
                }
            }
            catch (error) {
                console.warn("[rtk] unexpected error in tool_call handler; passing through command", error);
                return;
            }
        });
    }
    catch (error) {
        delete markedPi[TLH_RTK_EXTENSION_STATE];
        throw error;
    }
}
