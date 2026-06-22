import type { ThinkingLevel } from "./types.js";

export type ProviderModelReference = {
	provider: string;
	id: string;
};

export type AgentModelDefaults = {
	name: string;
	model?: string;
	tlhOpenaiModels?: string[];
	tlhAnthropicModels?: string[];
	thinking?: ThinkingLevel;
	tlhOpenaiThinking?: ThinkingLevel;
	preferCurrentOpenaiModel?: boolean;
	preferOppositeProvider?: boolean;
};

export type ProviderAwareAgentDefaults<T extends ProviderModelReference = ProviderModelReference> = {
	model?: T;
	thinking?: ThinkingLevel;
};

const OPENAI_PROVIDERS = new Set(["openai-codex", "openai"]);
const ANTHROPIC_PROVIDERS = new Set(["anthropic"]);
const OPPOSITE_PROVIDER_FALLBACK_NOTICE =
	"TLH fell back to a same-provider review model; review independence is reduced.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseProviderModelReference(model: string | undefined): ProviderModelReference | undefined {
	const slash = model?.indexOf("/") ?? -1;
	if (!model || slash <= 0 || slash === model.length - 1) {
		return undefined;
	}
	return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

export function formatProviderModelReference(model: ProviderModelReference): string {
	return `${model.provider}/${model.id}`;
}

function isOpenaiProvider(provider: string | undefined): boolean {
	return Boolean(provider && OPENAI_PROVIDERS.has(provider));
}

function isAnthropicProvider(provider: string | undefined): boolean {
	return Boolean(provider && ANTHROPIC_PROVIDERS.has(provider));
}

export function findAvailableProviderModel<T extends ProviderModelReference>(
	availableModels: readonly T[],
	model: string | undefined,
): T | undefined {
	const parsed = parseProviderModelReference(model);
	if (!parsed) {
		return undefined;
	}
	return findAvailableProviderModelReference(availableModels, parsed);
}

function findAvailableProviderModelReference<T extends ProviderModelReference>(
	availableModels: readonly T[],
	model: ProviderModelReference | undefined,
): T | undefined {
	if (!model) {
		return undefined;
	}
	return availableModels.find((entry) => entry.provider === model.provider && entry.id === model.id);
}

function availableOpenaiCandidate<T extends ProviderModelReference>(
	availableModels: readonly T[],
	candidate: string | undefined,
): T | undefined {
	const parsed = parseProviderModelReference(candidate);
	if (!parsed || !isOpenaiProvider(parsed.provider)) {
		return undefined;
	}
	return findAvailableProviderModel(availableModels, candidate);
}

function availableCodexCandidate<T extends ProviderModelReference>(
	availableModels: readonly T[],
	candidate: string | undefined,
): T | undefined {
	const parsed = parseProviderModelReference(candidate);
	if (!parsed || parsed.provider !== "openai-codex") {
		return undefined;
	}
	return findAvailableProviderModel(availableModels, candidate);
}

function availableAnthropicCandidate<T extends ProviderModelReference>(
	availableModels: readonly T[],
	candidate: string | undefined,
): T | undefined {
	const parsed = parseProviderModelReference(candidate);
	if (!parsed || !isAnthropicProvider(parsed.provider)) {
		return undefined;
	}
	return findAvailableProviderModel(availableModels, candidate);
}

function currentProviderOpenaiCandidate<T extends ProviderModelReference>(
	agent: AgentModelDefaults | undefined,
	availableModels: readonly T[],
	currentProvider?: string,
): T | undefined {
	if (!isOpenaiProvider(currentProvider)) {
		return undefined;
	}
	const currentProviderCandidate = agent?.tlhOpenaiModels?.find(
		(candidate) => parseProviderModelReference(candidate)?.provider === currentProvider,
	);
	return availableOpenaiCandidate(availableModels, currentProviderCandidate);
}

function currentProviderAnthropicCandidate<T extends ProviderModelReference>(
	agent: AgentModelDefaults | undefined,
	availableModels: readonly T[],
	currentProvider?: string,
): T | undefined {
	if (!isAnthropicProvider(currentProvider)) {
		return undefined;
	}
	const currentProviderCandidate = agent?.tlhAnthropicModels?.find(
		(candidate) => parseProviderModelReference(candidate)?.provider === currentProvider,
	);
	return availableAnthropicCandidate(availableModels, currentProviderCandidate);
}

function selectOppositeProviderPreferredAgentModel<T extends ProviderModelReference>(
	agent: AgentModelDefaults | undefined,
	availableModels: readonly T[],
	currentProvider?: string,
): T | undefined {
	if (!agent?.preferOppositeProvider) {
		return undefined;
	}

	if (isAnthropicProvider(currentProvider)) {
		for (const candidate of agent.tlhOpenaiModels ?? []) {
			const model = availableCodexCandidate(availableModels, candidate);
			if (model) {
				return model;
			}
		}
		return undefined;
	}

	if (isOpenaiProvider(currentProvider)) {
		for (const candidate of agent.tlhAnthropicModels ?? []) {
			const model = availableAnthropicCandidate(availableModels, candidate);
			if (model) {
				return model;
			}
		}
	}

	return undefined;
}

function selectOppositeProviderFallbackModel<T extends ProviderModelReference>(
	agent: AgentModelDefaults | undefined,
	availableModels: readonly T[],
	currentProvider: string | undefined,
	currentModel: ProviderModelReference | undefined,
): T | undefined {
	if (!agent?.preferOppositeProvider) {
		return undefined;
	}

	if (currentModel?.provider === currentProvider) {
		const availableCurrentModel = findAvailableProviderModelReference(availableModels, currentModel);
		if (availableCurrentModel) {
			return availableCurrentModel;
		}
	}

	return currentProviderOpenaiCandidate(agent, availableModels, currentProvider)
		?? currentProviderAnthropicCandidate(agent, availableModels, currentProvider);
}

function selectStandardProviderAwareAgentModel<T extends ProviderModelReference>(
	agent: AgentModelDefaults | undefined,
	availableModels: readonly T[],
	currentProvider?: string,
): T | undefined {
	if (!agent) {
		return undefined;
	}

	const defaultModel = findAvailableProviderModel(availableModels, agent.model);
	if (defaultModel) {
		return defaultModel;
	}

	const currentProviderModel =
		currentProviderOpenaiCandidate(agent, availableModels, currentProvider)
		?? currentProviderAnthropicCandidate(agent, availableModels, currentProvider);
	if (currentProviderModel) {
		return currentProviderModel;
	}

	for (const candidate of agent.tlhOpenaiModels ?? []) {
		const model = availableOpenaiCandidate(availableModels, candidate);
		if (model) {
			return model;
		}
	}

	for (const candidate of agent.tlhAnthropicModels ?? []) {
		const model = availableAnthropicCandidate(availableModels, candidate);
		if (model) {
			return model;
		}
	}

	return undefined;
}

export function selectProviderAwareAgentModel<T extends ProviderModelReference>(
	agent: AgentModelDefaults | undefined,
	availableModels: readonly T[],
	currentProvider?: string,
): T | undefined {
	return selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider)
		?? selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider);
}

export function selectProviderAwareAgentDefaults<T extends ProviderModelReference>(
	agent: AgentModelDefaults | undefined,
	availableModels: readonly T[],
	currentProvider?: string,
): ProviderAwareAgentDefaults<T> {
	const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider);
	const standardModel = agent?.preferCurrentOpenaiModel
		? currentProviderOpenaiCandidate(agent, availableModels, currentProvider)
			?? selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider)
		: selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider);
	const model = oppositeProviderModel ?? standardModel;
	const thinking = isOpenaiProvider(model?.provider ?? currentProvider) && agent?.tlhOpenaiThinking
		? agent.tlhOpenaiThinking
		: agent?.thinking;
	return { model, thinking };
}

export function selectProviderAwareAgentModelId(
	agent: AgentModelDefaults | undefined,
	availableModels: readonly ProviderModelReference[],
	currentProvider?: string,
): string | undefined {
	const model = selectProviderAwareAgentModel(agent, availableModels, currentProvider);
	return model ? formatProviderModelReference(model) : undefined;
}

function hasExplicitModel(target: Record<string, unknown>): boolean {
	return Object.hasOwn(target, "model") && target.model !== undefined;
}

function agentNameForTarget(target: Record<string, unknown>): string | undefined {
	return typeof target.agent === "string" ? target.agent : undefined;
}

function applyModelToRunnableTarget(
	target: unknown,
	agents: ReadonlyMap<string, AgentModelDefaults>,
	availableModels: readonly ProviderModelReference[],
	currentProvider: string | undefined,
	currentModel: ProviderModelReference | undefined,
): number {
	if (!isRecord(target) || hasExplicitModel(target)) {
		return 0;
	}

	const agentName = agentNameForTarget(target);
	const agent = agentName ? agents.get(agentName) : undefined;
	const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider);
	if (oppositeProviderModel) {
		const selectedModel = formatProviderModelReference(oppositeProviderModel);
		if (selectedModel === agent?.model) {
			return 0;
		}

		target.model = selectedModel;
		const fallbackModel = selectOppositeProviderFallbackModel(agent, availableModels, currentProvider, currentModel);
		const fallbackModelId = fallbackModel ? formatProviderModelReference(fallbackModel) : undefined;
		if (fallbackModelId && fallbackModelId !== selectedModel) {
			if (!Object.hasOwn(target, "fallbackModels") || target.fallbackModels === undefined) {
				target.fallbackModels = [fallbackModelId];
			}
			if (!Object.hasOwn(target, "modelFallbackNotice") || target.modelFallbackNotice === undefined) {
				target.modelFallbackNotice = OPPOSITE_PROVIDER_FALLBACK_NOTICE;
			}
		}
		return 1;
	}

	const standardModel = selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider);
	const selectedModel = standardModel ? formatProviderModelReference(standardModel) : undefined;
	if (!selectedModel || selectedModel === agent?.model) {
		return 0;
	}

	target.model = selectedModel;
	return 1;
}

export function applyProviderAwareSubagentModels(
	input: unknown,
	agents: ReadonlyMap<string, AgentModelDefaults>,
	availableModels: readonly ProviderModelReference[],
	currentProvider?: string,
	currentModel?: ProviderModelReference,
): number {
	if (!isRecord(input)) {
		return 0;
	}

	let mutations = applyModelToRunnableTarget(input, agents, availableModels, currentProvider, currentModel);

	if (Array.isArray(input.tasks)) {
		for (const task of input.tasks) {
			mutations += applyModelToRunnableTarget(task, agents, availableModels, currentProvider, currentModel);
		}
	}

	if (Array.isArray(input.chain)) {
		for (const step of input.chain) {
			if (!isRecord(step)) {
				continue;
			}
			if (Array.isArray(step.parallel)) {
				for (const task of step.parallel) {
					mutations += applyModelToRunnableTarget(task, agents, availableModels, currentProvider, currentModel);
				}
				continue;
			}
			mutations += applyModelToRunnableTarget(step, agents, availableModels, currentProvider, currentModel);
		}
	}

	return mutations;
}
