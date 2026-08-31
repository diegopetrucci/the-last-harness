import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "../shared/utils.js";
export const NATIVE_INTERCOM_EXTENSION_DIR = "native:pi-subagents-supervisor-channel";
function defaultAgentDir() {
    return getAgentDir();
}
function defaultSubagentConfigDir(agentDir = defaultAgentDir()) {
    return path.join(agentDir, "extensions", "subagent");
}
const DEFAULT_INTERCOM_TARGET_PREFIX = "subagent-chat";
export const INTERCOM_BRIDGE_MARKER = "Intercom orchestration channel:";
const DEFAULT_INTERCOM_BRIDGE_TEMPLATE = `The inherited thread is reference-only. Do not continue that conversation or send questions, status updates, or completion handoffs to the supervisor in normal assistant text.

- An agent with supervisorBridge: false opts out of this generic bridge guidance and runtime contact_supervisor support.

Use contact_supervisor. It resolves the supervisor session "{orchestratorTarget}" and run metadata automatically.
- Need a decision, blocked, approval, or product/API/scope ambiguity: contact_supervisor({ reason: "need_decision", message: "<question>" })
- Blocking supervisor requests durably pause the child. Once that blocking tool call starts, this OS process will stop; no child process keeps running during the pause.
- The parent must explicitly resume the paused child unchanged, resume it with guidance, or cancel it. Do not retry the blocking request or assume the same child process will still be live.
- Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions. Review-only/no-edit wins; leave files unchanged and mention the conflict in your final result only if it matters.
- Meaningful progress or unexpected discoveries that change the plan: contact_supervisor({ reason: "progress_update", message: "UPDATE: <summary>" })

Do not use contact_supervisor for routine completion handoffs. If no coordination is needed, return a focused task result.`;
const BRIDGED_AGENT_CONFIGS = new WeakMap();
export function resolveIntercomSessionTarget(sessionName, sessionId) {
    const trimmedName = sessionName?.trim();
    if (trimmedName)
        return trimmedName;
    const normalizedSessionId = sessionId.startsWith("session-")
        ? sessionId.slice("session-".length)
        : sessionId;
    return `${DEFAULT_INTERCOM_TARGET_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}
function sanitizeIntercomTargetPart(value) {
    return (value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "agent");
}
export function resolveSubagentIntercomTarget(runId, agent, index) {
    const stepSuffix = index !== undefined ? `-${index + 1}` : "";
    return `subagent-${sanitizeIntercomTargetPart(agent)}-${sanitizeIntercomTargetPart(runId)}${stepSuffix}`;
}
export function resolveIntercomBridgeMode(value) {
    if (value === "off" || value === "always" || value === "fork-only")
        return value;
    return "always";
}
function resolveIntercomBridgeConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { mode: "always", instructionFile: "" };
    }
    return {
        mode: resolveIntercomBridgeMode(value.mode),
        instructionFile: typeof value.instructionFile === "string" ? value.instructionFile : "",
    };
}
function expandTilde(filePath) {
    return filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
}
function resolveInstructionTemplate(instructionFile, settingsDir) {
    if (!instructionFile)
        return DEFAULT_INTERCOM_BRIDGE_TEMPLATE;
    const expandedPath = expandTilde(instructionFile);
    const resolvedPath = path.isAbsolute(expandedPath)
        ? expandedPath
        : path.resolve(settingsDir, expandedPath);
    try {
        return fs.readFileSync(resolvedPath, "utf-8");
    }
    catch (error) {
        console.warn(`Failed to read intercom bridge instructionFile at '${resolvedPath}'. Using default instructions.`, error);
        return DEFAULT_INTERCOM_BRIDGE_TEMPLATE;
    }
}
function buildIntercomBridgeInstruction(orchestratorTarget, template) {
    const instruction = template.replaceAll("{orchestratorTarget}", orchestratorTarget).trim();
    return `${INTERCOM_BRIDGE_MARKER}\n${instruction}`;
}
function inactiveReason(mode, context, orchestratorTarget) {
    if (mode === "off")
        return "bridge mode is off";
    if (mode === "fork-only" && context !== "fork")
        return "bridge mode is fork-only and context is not fork";
    if (!orchestratorTarget)
        return "orchestrator target is not available";
    return undefined;
}
export function diagnoseIntercomBridge(input) {
    const config = resolveIntercomBridgeConfig(input.config);
    const mode = config.mode;
    const orchestratorTarget = input.orchestratorTarget?.trim();
    const wantsIntercom = mode !== "off" && !(mode === "fork-only" && input.context !== "fork");
    const reason = inactiveReason(mode, input.context, orchestratorTarget);
    return {
        active: reason === undefined,
        mode,
        wantsIntercom,
        supervisorChannelAvailable: true,
        extensionDir: NATIVE_INTERCOM_EXTENSION_DIR,
        ...(orchestratorTarget ? { orchestratorTarget } : {}),
        ...(reason ? { reason } : {}),
    };
}
export function resolveIntercomBridge(input) {
    const config = resolveIntercomBridgeConfig(input.config);
    const mode = config.mode;
    const orchestratorTarget = input.orchestratorTarget?.trim();
    const agentDir = path.resolve(input.agentDir ?? defaultAgentDir());
    const settingsDir = path.resolve(input.settingsDir ?? defaultSubagentConfigDir(agentDir));
    const defaultInstruction = buildIntercomBridgeInstruction(orchestratorTarget || "{orchestratorTarget}", DEFAULT_INTERCOM_BRIDGE_TEMPLATE);
    const reason = inactiveReason(mode, input.context, orchestratorTarget);
    if (reason || !orchestratorTarget) {
        return {
            active: false,
            mode,
            extensionDir: NATIVE_INTERCOM_EXTENSION_DIR,
            instruction: defaultInstruction,
        };
    }
    return {
        active: true,
        mode,
        orchestratorTarget,
        extensionDir: NATIVE_INTERCOM_EXTENSION_DIR,
        instruction: buildIntercomBridgeInstruction(orchestratorTarget, resolveInstructionTemplate(config.instructionFile, settingsDir)),
    };
}
export function applyIntercomBridgeToAgent(agent, bridge) {
    if (!bridge.active || !bridge.orchestratorTarget)
        return agent;
    if (agent.supervisorBridge === false)
        return agent;
    const instruction = bridge.instruction;
    const metadata = BRIDGED_AGENT_CONFIGS.get(agent);
    if (metadata?.instruction === instruction)
        return agent;
    const source = metadata?.source ?? agent;
    const trimmedPrompt = source.systemPrompt?.trim() || "";
    const systemPrompt = trimmedPrompt ? `${trimmedPrompt}\n\n${instruction}` : instruction;
    const bridgedAgent = {
        ...source,
        systemPrompt,
    };
    BRIDGED_AGENT_CONFIGS.set(bridgedAgent, { source, instruction });
    return bridgedAgent;
}
