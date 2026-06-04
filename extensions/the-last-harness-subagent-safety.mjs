export const ALLOWED_SUBAGENTS = Object.freeze(["developer", "validator", "code-reviewer", "repo-scout", "diff-summarizer", "librarian", "web-scout", "oracle"]);
export const PRIMARY_SUBAGENT_ALLOWLISTS = Object.freeze({
	architect: ALLOWED_SUBAGENTS,
	product: Object.freeze(["repo-scout", "librarian"]),
	"bug-hunter": Object.freeze(["repo-scout", "librarian", "oracle"]),
	rush: Object.freeze(["repo-scout", "diff-summarizer", "librarian", "code-reviewer", "oracle"]),
});
export const SAFE_SUBAGENT_ACTIONS = Object.freeze(["list", "get", "status", "interrupt", "doctor"]);
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

const SAFE_SUBAGENT_ACTION_SET = new Set(SAFE_SUBAGENT_ACTIONS);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePrimaryAgent(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

export function allowedSubagentsForPrimary(primaryAgent) {
	const normalizedPrimaryAgent = normalizePrimaryAgent(primaryAgent);
	return normalizedPrimaryAgent && hasOwn(PRIMARY_SUBAGENT_ALLOWLISTS, normalizedPrimaryAgent)
		? PRIMARY_SUBAGENT_ALLOWLISTS[normalizedPrimaryAgent]
		: ALLOWED_SUBAGENTS;
}

function delegationPolicyLabel(primaryAgent) {
	const normalizedPrimaryAgent = normalizePrimaryAgent(primaryAgent);
	return normalizedPrimaryAgent && hasOwn(PRIMARY_SUBAGENT_ALLOWLISTS, normalizedPrimaryAgent) ? `TLH ${normalizedPrimaryAgent}` : "TLH primary agents";
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

	if (Array.isArray(input.chain)) {
		for (const step of input.chain) {
			if (!isRecord(step)) continue;
			const agent = stringField(step.agent);
			if (agent) targets.push(agent);
			if (!Array.isArray(step.parallel)) continue;
			for (const task of step.parallel) {
				if (!isRecord(task)) continue;
				const parallelAgent = stringField(task.agent);
				if (parallelAgent) targets.push(parallelAgent);
			}
		}
	}

	return [...new Set(targets)];
}

function forceUserAgentScope(input, mode) {
	const rawScope = input.agentScope;
	if (rawScope !== undefined) {
		if (typeof rawScope !== "string") {
			return `TLH primary-agent subagent ${mode} calls must use agentScope: "user" or omit agentScope.`;
		}
		const agentScope = rawScope.trim();
		if (agentScope && agentScope !== "user") {
			return `TLH primary-agent subagent ${mode} calls may not use agentScope: "${agentScope}". TLH minor agents must run from the isolated user scope.`;
		}
	}

	input.agentScope = "user";
	return undefined;
}

function forceFreshSubagentContext(input) {
	const rawContext = input.context;
	if (rawContext !== undefined) {
		if (typeof rawContext !== "string") {
			return `TLH primary-agent subagent execution must use context: "fresh" or omit context.`;
		}
		const context = rawContext.trim();
		if (context && context !== "fresh") {
			return `TLH primary-agent subagent execution may not use context: "${context}". TLH child sessions must start fresh so parent primary-agent/Gnosis context is not leaked.`;
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

	if (Array.isArray(input.chain)) {
		for (let chainIndex = 0; chainIndex < input.chain.length; chainIndex += 1) {
			const step = input.chain[chainIndex];
			const stepReason = validateNestedFreshContext(step, `chain[${chainIndex}].context`);
			if (stepReason) return stepReason;
			if (!isRecord(step) || !Array.isArray(step.parallel)) continue;
			for (let parallelIndex = 0; parallelIndex < step.parallel.length; parallelIndex += 1) {
				const reason = validateNestedFreshContext(step.parallel[parallelIndex], `chain[${chainIndex}].parallel[${parallelIndex}].context`);
				if (reason) return reason;
			}
		}
	}

	return undefined;
}

export function validateSubagentToolInput(input, { primaryAgent } = {}) {
	if (!isRecord(input)) {
		return "TLH primary-agent subagent calls must use an object input.";
	}

	const action = stringField(input.action);
	if (action) {
		if (!SAFE_SUBAGENT_ACTION_SET.has(action)) {
			return `TLH primary agents may not use subagent management action '${action}'. Allowed actions: ${SAFE_SUBAGENT_ACTIONS.join(", ")}.`;
		}
		return action === "list" || action === "get" ? forceUserAgentScope(input, action) : undefined;
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
		return `TLH primary-agent subagent execution must target one of: ${ALLOWED_SUBAGENTS.join(", ")}.`;
	}

	const disallowed = targets.filter((agent) => !ALLOWED_SUBAGENTS.includes(agent));
	if (disallowed.length > 0) {
		return `TLH primary agents may delegate only to: ${ALLOWED_SUBAGENTS.join(", ")}. Disallowed target(s): ${disallowed.join(", ")}.`;
	}

	const primaryAllowedSubagents = allowedSubagentsForPrimary(primaryAgent);
	const primaryDisallowed = targets.filter((agent) => !primaryAllowedSubagents.includes(agent));
	if (primaryDisallowed.length > 0) {
		return `${delegationPolicyLabel(primaryAgent)} may delegate only to: ${primaryAllowedSubagents.join(", ")}. Disallowed target(s): ${primaryDisallowed.join(", ")}.`;
	}

	return undefined;
}

export function registerChildSubagentPrompt(pi, buildChildSubagentSystemPrompt) {
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: [event.systemPrompt, buildChildSubagentSystemPrompt()].filter(Boolean).join("\n\n"),
	}));
}

export function registerTlhStartupMode(pi, { env = process.env, buildChildSubagentSystemPrompt, registerChild, registerParent } = {}) {
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
