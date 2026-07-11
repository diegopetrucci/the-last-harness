import { getAvailableThinkingLevels, isThinkingLevel } from "./thinking.js";
import type { ReasoningModel, ThinkingLevel, TlhSubagentOverride } from "./types.js";

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

export type ProviderAwareSubagentResolution<T extends ProviderModelReference = ProviderModelReference> = {
	model?: T;
	fallbackModels?: T[];
	modelFallbackNotice?: string;
	thinking?: ThinkingLevel;
	independence: "not-applicable" | "preferred" | "degraded" | "unknown";
	warning?: string;
};

export type ApplyProviderAwareSubagentModelOptions = {
	agentOverrides?: ReadonlyMap<string, TlhSubagentOverride>;
	onWarning?: (warning: { agent: string; message: string }) => void;
};

type ReasoningProviderModelReference = ProviderModelReference & Partial<ReasoningModel>;

const OPENAI_PROVIDERS = new Set(["openai-codex", "openai"]);
const ANTHROPIC_PROVIDERS = new Set(["anthropic"]);
const MODEL_SUFFIX_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
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

export function splitKnownThinkingSuffix(model: string | undefined): { baseModel: string | undefined; thinkingSuffix: string } {
	if (!model) {
		return { baseModel: model, thinkingSuffix: "" };
	}
	const colon = model.lastIndexOf(":");
	if (colon === -1) {
		return { baseModel: model, thinkingSuffix: "" };
	}
	const suffix = model.slice(colon + 1);
	if (!MODEL_SUFFIX_THINKING_LEVELS.includes(suffix as ThinkingLevel)) {
		return { baseModel: model, thinkingSuffix: "" };
	}
	return { baseModel: model.slice(0, colon), thinkingSuffix: `:${suffix}` };
}

function applyThinkingSuffix(model: string | undefined, thinking: ThinkingLevel | undefined): string | undefined {
	if (!model || !thinking) {
		return model;
	}
	if (!MODEL_SUFFIX_THINKING_LEVELS.includes(thinking)) {
		return model;
	}
	const { thinkingSuffix } = splitKnownThinkingSuffix(model);
	return thinkingSuffix ? model : `${model}:${thinking}`;
}

function isOpenaiProvider(provider: string | undefined): boolean {
	return Boolean(provider && OPENAI_PROVIDERS.has(provider));
}

function isAnthropicProvider(provider: string | undefined): boolean {
	return Boolean(provider && ANTHROPIC_PROVIDERS.has(provider));
}

function providerFamily(provider: string | undefined): "openai" | "anthropic" | undefined {
	if (isOpenaiProvider(provider)) {
		return "openai";
	}
	if (isAnthropicProvider(provider)) {
		return "anthropic";
	}
	return undefined;
}

export function findAvailableProviderModel<T extends ProviderModelReference>(
	availableModels: readonly T[],
	model: string | undefined,
): T | undefined {
	const parsed = parseProviderModelReference(splitKnownThinkingSuffix(model).baseModel);
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

function selectThinkingForProvider(agent: AgentModelDefaults | undefined, provider?: string): ThinkingLevel | undefined {
	return isOpenaiProvider(provider) && agent?.tlhOpenaiThinking
		? agent.tlhOpenaiThinking
		: agent?.thinking;
}

function resolveSubagentThinking<T extends ReasoningProviderModelReference>(
	agent: AgentModelDefaults | undefined,
	model: T | undefined,
	fallbackModels: readonly T[],
	override: TlhSubagentOverride | undefined,
): { thinking?: ThinkingLevel; warning?: string } {
	const rawThinking = override?.thinking;
	const thinking = rawThinking && isThinkingLevel(rawThinking)
		? rawThinking
		: rawThinking === undefined
			? selectThinkingForProvider(agent, model?.provider)
			: undefined;
	if (!thinking) {
		return rawThinking === undefined
			? {}
			: {
				warning: `TLH ignored unsupported stored minor-agent effort "${rawThinking}" for ${agent?.name ?? "this subagent"}; using bundled defaults for this run.`,
			};
	}
	if (!override?.thinking) {
		return { thinking };
	}
	const candidates = model ? [model, ...fallbackModels] : [];
	for (const candidate of candidates) {
		if (!getAvailableThinkingLevels(candidate).includes(thinking) || !MODEL_SUFFIX_THINKING_LEVELS.includes(thinking)) {
			return {
				warning: `TLH stored minor-agent effort "${thinking}" is not supported by ${formatProviderModelReference(candidate)}; using bundled defaults for this run.`,
			};
		}
	}
	return { thinking };
}

function resolveIndependence(
	agent: AgentModelDefaults | undefined,
	model: ProviderModelReference | undefined,
	currentProvider?: string,
): ProviderAwareSubagentResolution["independence"] {
	if (!agent?.preferOppositeProvider) {
		return "not-applicable";
	}
	if (!model) {
		return "unknown";
	}
	const currentFamily = providerFamily(currentProvider);
	const modelFamily = providerFamily(model.provider);
	if (!currentFamily || !modelFamily) {
		return "unknown";
	}
	return currentFamily === modelFamily ? "degraded" : "preferred";
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
	const thinking = selectThinkingForProvider(agent, model?.provider ?? currentProvider);
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

export function resolveProviderAwareSubagentResolution<T extends ReasoningProviderModelReference>(
	agent: AgentModelDefaults | undefined,
	availableModels: readonly T[],
	currentProvider?: string,
	currentModel?: ProviderModelReference,
	override?: TlhSubagentOverride,
): ProviderAwareSubagentResolution<T> {
	const overrideModel = findAvailableProviderModel(availableModels, override?.model);
	if (overrideModel) {
		const thinkingResolution = resolveSubagentThinking(agent, overrideModel, [], override);
		return {
			model: overrideModel,
			thinking: thinkingResolution.thinking,
			independence: resolveIndependence(agent, overrideModel, currentProvider),
			warning: thinkingResolution.warning,
		};
	}

	const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider);
	const selectedModel = oppositeProviderModel
		?? (agent?.preferCurrentOpenaiModel
			? currentProviderOpenaiCandidate(agent, availableModels, currentProvider)
				?? selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider)
			: selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider));
	const fallbackModel = oppositeProviderModel
		? selectOppositeProviderFallbackModel(agent, availableModels, currentProvider, currentModel)
		: undefined;
	const fallbackModels = fallbackModel && (!selectedModel || formatProviderModelReference(fallbackModel) !== formatProviderModelReference(selectedModel))
		? [fallbackModel]
		: [];
	const thinkingResolution = resolveSubagentThinking(agent, selectedModel, fallbackModels, override);
	return {
		model: selectedModel,
		fallbackModels,
		modelFallbackNotice: fallbackModels.length > 0 ? OPPOSITE_PROVIDER_FALLBACK_NOTICE : undefined,
		thinking: thinkingResolution.thinking,
		independence: resolveIndependence(agent, selectedModel, currentProvider),
		warning: thinkingResolution.warning,
	};
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
	availableModels: readonly ReasoningProviderModelReference[],
	currentProvider: string | undefined,
	currentModel: ProviderModelReference | undefined,
	options: ApplyProviderAwareSubagentModelOptions,
): number {
	if (!isRecord(target)) {
		return 0;
	}

	const agentName = agentNameForTarget(target);
	const agent = agentName ? agents.get(agentName) : undefined;
	const override = agentName ? options.agentOverrides?.get(agentName) : undefined;
	if (hasExplicitModel(target)) {
		if (typeof target.model !== "string" || splitKnownThinkingSuffix(target.model).thinkingSuffix || override?.thinking === undefined) {
			return 0;
		}
		const explicitModel = findAvailableProviderModel(availableModels, target.model);
		const thinkingResolution = resolveSubagentThinking(agent, explicitModel, [], override);
		if (thinkingResolution.warning && agentName) {
			options.onWarning?.({ agent: agentName, message: thinkingResolution.warning });
		}
		const modelWithThinking = applyThinkingSuffix(target.model, thinkingResolution.thinking);
		if (!modelWithThinking || modelWithThinking === target.model) {
			return 0;
		}
		target.model = modelWithThinking;
		return 1;
	}
	const resolution = resolveProviderAwareSubagentResolution(agent, availableModels, currentProvider, currentModel, override);
	if (resolution.warning && agentName) {
		options.onWarning?.({ agent: agentName, message: resolution.warning });
	}
	const selectedModel = resolution.model ? applyThinkingSuffix(formatProviderModelReference(resolution.model), resolution.thinking) : undefined;
	if (!selectedModel || selectedModel === agent?.model) {
		return 0;
	}

	target.model = selectedModel;
	const fallbackModels = resolution.fallbackModels
		?.map((fallbackModel) => applyThinkingSuffix(formatProviderModelReference(fallbackModel), resolution.thinking))
		.filter((model): model is string => Boolean(model));
	if (fallbackModels?.length) {
		if (!Object.hasOwn(target, "fallbackModels") || target.fallbackModels === undefined) {
			target.fallbackModels = fallbackModels;
		}
		if (!Object.hasOwn(target, "modelFallbackNotice") || target.modelFallbackNotice === undefined) {
			target.modelFallbackNotice = resolution.modelFallbackNotice;
		}
	}
	return 1;
}

export function applyProviderAwareSubagentModels(
	input: unknown,
	agents: ReadonlyMap<string, AgentModelDefaults>,
	availableModels: readonly ReasoningProviderModelReference[],
	currentProvider?: string,
	currentModel?: ProviderModelReference,
	options: ApplyProviderAwareSubagentModelOptions = {},
): number {
	if (!isRecord(input)) {
		return 0;
	}

	let mutations = applyModelToRunnableTarget(input, agents, availableModels, currentProvider, currentModel, options);

	if (Array.isArray(input.tasks)) {
		for (const task of input.tasks) {
			mutations += applyModelToRunnableTarget(task, agents, availableModels, currentProvider, currentModel, options);
		}
	}

	if (Array.isArray(input.chain)) {
		for (const step of input.chain) {
			if (!isRecord(step)) {
				continue;
			}
			if (Array.isArray(step.parallel)) {
				for (const task of step.parallel) {
					mutations += applyModelToRunnableTarget(task, agents, availableModels, currentProvider, currentModel, options);
				}
				continue;
			}
			mutations += applyModelToRunnableTarget(step, agents, availableModels, currentProvider, currentModel, options);
		}
	}

	return mutations;
}
