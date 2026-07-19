/** @typedef {import("@earendil-works/pi-coding-agent").ExtensionAPI} ExtensionAPI */

/**
 * @typedef {object} TlhStartupModeOptions
 * @property {Record<string, string | undefined>=} env
 * @property {(() => string)=} buildChildSubagentSystemPrompt
 * @property {(() => void)=} registerChild
 * @property {(() => void)=} registerParent
 */

export const ALLOWED_SUBAGENTS = Object.freeze(["developer", "code-reviewer", "repo-scout", "diff-summarizer", "librarian", "web-scout", "oracle", "contrarian"]);
export const SAFE_SUBAGENT_ACTIONS = Object.freeze(["list", "get", "models", "status", "interrupt", "doctor", "resume"]);
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

const DEFAULT_ALLOWED_SUBAGENTS = ALLOWED_SUBAGENTS;
const ALLOWED_SUBAGENTS_BY_ID = new Map(ALLOWED_SUBAGENTS.map((agent) => [agent.toLowerCase(), agent]));

const SAFE_SUBAGENT_ACTION_SET = new Set(SAFE_SUBAGENT_ACTIONS);

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeExperimentalFeatureId(featureId) {
	return stringField(featureId)?.toLowerCase();
}

export function normalizeEnabledExperimentalFeatures(enabledFeatures) {
	if (!Array.isArray(enabledFeatures) || enabledFeatures.some((feature) => typeof feature !== "string")) {
		return [];
	}

	return [...new Set(enabledFeatures.map((feature) => normalizeExperimentalFeatureId(feature)).filter(Boolean))].sort();
}

export function readEnabledExperimentalFeatures(config) {
	if (!isRecord(config)) {
		return [];
	}

	return normalizeEnabledExperimentalFeatures(config.enabledFeatures);
}

export function isExperimentalFeatureEnabled(config, featureId) {
	const normalizedFeatureId = normalizeExperimentalFeatureId(featureId);
	return Boolean(normalizedFeatureId) && readEnabledExperimentalFeatures(config).includes(normalizedFeatureId);
}

export function allowedSubagentsForExperimentalConfig(_config) {
	return DEFAULT_ALLOWED_SUBAGENTS;
}

function normalizeAllowedSubagent(agent) {
	const normalizedAgent = stringField(agent)?.toLowerCase();
	return normalizedAgent ? ALLOWED_SUBAGENTS_BY_ID.get(normalizedAgent) : undefined;
}

function normalizeAllowedSubagents(allowedSubagents) {
	if (!Array.isArray(allowedSubagents)) {
		return DEFAULT_ALLOWED_SUBAGENTS;
	}

	const normalized = [...new Set(allowedSubagents.map((agent) => normalizeAllowedSubagent(agent)).filter(Boolean))];
	return normalized.length > 0 ? normalized : DEFAULT_ALLOWED_SUBAGENTS;
}

function collectSubagentTargets(input) {
	if (!isRecord(input)) {
		return [];
	}

	const targets = [];
	const topLevelAgent = stringField(input.agent);
	if (topLevelAgent) {
		targets.push(topLevelAgent);
	}

	if (Array.isArray(input.tasks)) {
		for (const task of input.tasks) {
			if (!isRecord(task)) continue;
			const agent = stringField(task.agent);
			if (agent) targets.push(agent);
		}
	}


	return [...new Set(targets)];
}

function forceUserAgentScope(input, mode, { allowBoth = false } = {}) {
	const rawScope = input.agentScope;
	if (rawScope !== undefined) {
		if (typeof rawScope !== "string") {
			return `TLH primary-agent subagent ${mode} calls must use agentScope: "user" or omit agentScope.`;
		}
		const agentScope = rawScope.trim();
		const scopeIsAllowed = !agentScope || agentScope === "user" || (allowBoth && agentScope === "both");
		if (!scopeIsAllowed) {
			return `TLH primary-agent subagent ${mode} calls may not use agentScope: "${agentScope}". TLH minor agents must run from the isolated user scope.`;
		}
	}

	input.agentScope = "user";
	return undefined;
}

function forceFreshSubagentContext(input, mode = "execution") {
	const rawContext = input.context;
	if (rawContext !== undefined) {
		if (typeof rawContext !== "string") {
			return `TLH primary-agent subagent ${mode} must use context: "fresh" or omit context.`;
		}
		const context = rawContext.trim();
		if (context && context !== "fresh") {
			return `TLH primary-agent subagent ${mode} may not use context: "${context}". TLH child sessions must start fresh so parent primary-agent/Gnosis context is not leaked.`;
		}
	}

	input.context = "fresh";
	return undefined;
}

function validateNestedFreshContext(owner, path) {
	if (!isRecord(owner) || owner.context === undefined) {
		return undefined;
	}
	if (typeof owner.context !== "string") {
		return `TLH primary-agent subagent execution nested ${path} must use context: "fresh" or omit context.`;
	}
	const context = owner.context.trim();
	if (context !== "fresh") {
		return `TLH primary-agent subagent execution nested ${path} may not use context: "${context}". TLH child sessions must start fresh so parent primary-agent/Gnosis context is not leaked.`;
	}
	return undefined;
}

function validateNestedFreshSubagentContexts(input) {
	if (Array.isArray(input.tasks)) {
		for (let index = 0; index < input.tasks.length; index += 1) {
			const reason = validateNestedFreshContext(input.tasks[index], `tasks[${index}].context`);
			if (reason) return reason;
		}
	}


	return undefined;
}

export function validateSubagentToolInput(input, options = {}) {
	const allowedSubagents = normalizeAllowedSubagents(options.allowedSubagents);
	const allowedSubagentSet = new Set(allowedSubagents);

	if (!isRecord(input)) {
		return "TLH primary-agent subagent calls must use an object input.";
	}

	const action = stringField(input.action);
	if (action) {
		if (!SAFE_SUBAGENT_ACTION_SET.has(action)) {
			return `TLH primary agents may not use subagent management action '${action}'. Allowed actions: ${SAFE_SUBAGENT_ACTIONS.join(", ")}.`;
		}
		if (action === "list" || action === "get") {
			return forceUserAgentScope(input, action, { allowBoth: true });
		}
		if (action === "resume") {
			const scopeReason = forceUserAgentScope(input, action, { allowBoth: true });
			if (scopeReason) {
				return scopeReason;
			}
			const contextReason = forceFreshSubagentContext(input, action);
			if (contextReason) {
				return contextReason;
			}
			return undefined;
		}
		return undefined;
	}

	const scopeReason = forceUserAgentScope(input, "execution");
	if (scopeReason) {
		return scopeReason;
	}

	const contextReason = forceFreshSubagentContext(input);
	if (contextReason) {
		return contextReason;
	}

	const nestedContextReason = validateNestedFreshSubagentContexts(input);
	if (nestedContextReason) {
		return nestedContextReason;
	}

	const targets = collectSubagentTargets(input);
	if (targets.length === 0) {
		return `TLH primary-agent subagent execution must target one of: ${allowedSubagents.join(", ")}.`;
	}

	const disallowed = targets.filter((agent) => !allowedSubagentSet.has(agent));
	if (disallowed.length > 0) {
		return `TLH primary agents may delegate only to: ${allowedSubagents.join(", ")}. Disallowed target(s): ${disallowed.join(", ")}.`;
	}

	return undefined;
}

/**
 * @param {ExtensionAPI} pi
 * @param {() => string} buildChildSubagentSystemPrompt
 */
export function registerChildSubagentPrompt(pi, buildChildSubagentSystemPrompt) {
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: [event.systemPrompt, buildChildSubagentSystemPrompt()].filter(Boolean).join("\n\n"),
	}));
}

/**
 * @param {ExtensionAPI} pi
 * @param {TlhStartupModeOptions} [options={}]
 * @returns {"child" | "parent"}
 */
export function registerTlhStartupMode(pi, options = {}) {
	const { env = process.env, buildChildSubagentSystemPrompt, registerChild, registerParent } = options;
	if (env?.[SUBAGENT_CHILD_ENV] === "1") {
		if (typeof registerChild === "function") {
			registerChild();
		} else if (typeof buildChildSubagentSystemPrompt === "function") {
			registerChildSubagentPrompt(pi, buildChildSubagentSystemPrompt);
		}
		return "child";
	}

	registerParent?.();
	return "parent";
}
