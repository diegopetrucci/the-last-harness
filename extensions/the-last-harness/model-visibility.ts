// Pi compatibility shim for TLH model visibility/filtering behavior.
// See ../../docs/upstream-sync-inventory.md for sync/review guidance.
import { InteractiveMode, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { isRecord, readText, uniqueSorted } from "./common.js";
import { safeTlhProfileFilePath } from "./profile-state.js";
import type { TlhSettings } from "./types.js";

type ProviderModelReference = {
	provider: string;
	id: string;
};

type ResolvedTlhModelVisibilityConfig = {
	disabled: boolean;
	hidden: string[];
	visible: string[];
};

type ModelRegistryPrototype = typeof ModelRegistry.prototype & {
	[TLH_MODEL_VISIBILITY_PATCHED]?: boolean;
	[TLH_MODEL_VISIBILITY_GET_AVAILABLE_ORIGINAL]?: typeof ModelRegistry.prototype.getAvailable;
};

type ModelRuntimePrototype = typeof ModelRuntime.prototype & {
	[TLH_MODEL_VISIBILITY_RUNTIME_PATCHED]?: boolean;
	[TLH_MODEL_VISIBILITY_RUNTIME_GET_AVAILABLE_ORIGINAL]?: typeof ModelRuntime.prototype.getAvailable;
	[TLH_MODEL_VISIBILITY_RUNTIME_GET_AVAILABLE_SNAPSHOT_ORIGINAL]?: typeof ModelRuntime.prototype.getAvailableSnapshot;
};

type ModelRegistryCompatibilityFacade = Pick<ModelRegistry, "getAvailable">;

type InteractiveModeLike = {
	session?: {
		scopedModels?: Array<{ model: ProviderModelReference }>;
		modelRegistry?: Pick<ModelRegistry, "getAvailable">;
		modelRuntime?: Pick<ModelRuntime, "getAvailableSnapshot">;
	};
};

type InteractiveModeFindExactModelMatch = (
	this: InteractiveModeLike,
	searchTerm: string,
) => Promise<ProviderModelReference | undefined>;

type InteractiveModePrototype = {
	findExactModelMatch?: InteractiveModeFindExactModelMatch;
	[TLH_MODEL_VISIBILITY_EXACT_LOOKUP_PATCHED]?: boolean;
	[TLH_MODEL_VISIBILITY_FIND_EXACT_MODEL_MATCH_ORIGINAL]?: InteractiveModeFindExactModelMatch;
};

const TLH_MODEL_VISIBILITY_PATCHED = Symbol.for("tlh.modelVisibilityPatched");
const TLH_MODEL_VISIBILITY_GET_AVAILABLE_ORIGINAL = Symbol.for("tlh.modelVisibilityGetAvailableOriginal");
const TLH_MODEL_VISIBILITY_RUNTIME_PATCHED = Symbol.for("tlh.modelVisibilityRuntimePatched");
const TLH_MODEL_VISIBILITY_RUNTIME_GET_AVAILABLE_ORIGINAL = Symbol.for(
	"tlh.modelVisibilityRuntimeGetAvailableOriginal",
);
const TLH_MODEL_VISIBILITY_RUNTIME_GET_AVAILABLE_SNAPSHOT_ORIGINAL = Symbol.for(
	"tlh.modelVisibilityRuntimeGetAvailableSnapshotOriginal",
);
const TLH_MODEL_VISIBILITY_EXACT_LOOKUP_PATCHED = Symbol.for("tlh.modelVisibilityExactLookupPatched");
const TLH_MODEL_VISIBILITY_FIND_EXACT_MODEL_MATCH_ORIGINAL = Symbol.for(
	"tlh.modelVisibilityFindExactModelMatchOriginal",
);

export const TLH_HIDDEN_MODEL_DEFAULTS = Object.freeze([
	"anthropic/claude-3-5-haiku-20241022",
	"anthropic/claude-3-5-haiku-latest",
	"anthropic/claude-3-5-sonnet-20240620",
	"anthropic/claude-3-5-sonnet-20241022",
	"anthropic/claude-3-7-sonnet-20250219",
	"anthropic/claude-3-haiku-20240307",
	"anthropic/claude-3-opus-20240229",
	"anthropic/claude-3-sonnet-20240229",
	"anthropic/claude-haiku-4-5",
	"anthropic/claude-haiku-4-5-20251001",
	"anthropic/claude-opus-4-0",
	"anthropic/claude-opus-4-1",
	"anthropic/claude-opus-4-1-20250805",
	"anthropic/claude-opus-4-20250514",
	"anthropic/claude-opus-4-5",
	"anthropic/claude-opus-4-5-20251101",
	"anthropic/claude-opus-4-6",
	"anthropic/claude-sonnet-4-0",
	"anthropic/claude-sonnet-4-20250514",
	"anthropic/claude-sonnet-4-5",
	"anthropic/claude-sonnet-4-5-20250929",
	"anthropic/claude-sonnet-4-6",
	"anthropic/claude-sonnet-5",
	"openai-codex/gpt-5.3-codex-spark",
	"openai-codex/gpt-5.4",
	"openai-codex/gpt-5.4-mini",
]);

function normalizePatternList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return uniqueSorted(
		value
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
}

export function normalizeTlhModelVisibilityConfig(config: unknown): ResolvedTlhModelVisibilityConfig {
	if (!isRecord(config)) {
		return { disabled: false, hidden: [], visible: [] };
	}
	return {
		disabled: config.disabled === true,
		hidden: normalizePatternList(config.hidden),
		visible: uniqueSorted([...normalizePatternList(config.visible), ...normalizePatternList(config.unhide)]),
	};
}

function readTlhSettings(): TlhSettings | undefined {
	const settingsPath = safeTlhProfileFilePath("settings.json");
	const content = settingsPath ? readText(settingsPath) : undefined;
	if (!content) {
		return settingsPath ? {} : undefined;
	}
	try {
		const parsed = JSON.parse(content) as unknown;
		return isRecord(parsed) ? (parsed as TlhSettings) : {};
	} catch {
		return {};
	}
}

export function getTlhModelVisibilityConfig(): ResolvedTlhModelVisibilityConfig {
	const settings = readTlhSettings();
	if (!settings) {
		return { disabled: true, hidden: [], visible: [] };
	}
	return normalizeTlhModelVisibilityConfig(settings.tlh?.modelVisibility);
}

function escapeRegExp(text: string): string {
	return text.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function matchesGlobPattern(value: string, pattern: string): boolean {
	const regex = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, ".*").replace(/\\\?/g, ".")}$`, "i");
	return regex.test(value);
}

function modelCandidates(model: ProviderModelReference, pattern: string): string[] {
	const full = `${model.provider}/${model.id}`;
	return pattern.includes("/") ? [full] : [model.id, full];
}

export function matchesTlhModelVisibilityPattern(model: ProviderModelReference, pattern: string): boolean {
	const normalizedPattern = pattern.trim().toLowerCase();
	if (!normalizedPattern) {
		return false;
	}
	const candidates = modelCandidates(model, normalizedPattern).map((value) => value.toLowerCase());
	if (normalizedPattern.includes("*") || normalizedPattern.includes("?")) {
		return candidates.some((candidate) => matchesGlobPattern(candidate, normalizedPattern));
	}
	return candidates.some((candidate) => candidate === normalizedPattern);
}

function matchesAnyPattern(model: ProviderModelReference, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => matchesTlhModelVisibilityPattern(model, pattern));
}

function findExactModelReferenceMatch<T extends ProviderModelReference>(
	modelReference: string,
	availableModels: readonly T[],
): T | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}
	const normalizedReference = trimmedReference.toLowerCase();
	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return canonicalMatches[0];
	}
	if (canonicalMatches.length > 1) {
		return undefined;
	}
	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() && model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) {
				return providerMatches[0];
			}
			if (providerMatches.length > 1) {
				return undefined;
			}
		}
	}
	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

function isCanonicalModelReference(modelReference: string): boolean {
	const trimmedReference = modelReference.trim();
	const slashIndex = trimmedReference.indexOf("/");
	return slashIndex > 0 && slashIndex < trimmedReference.length - 1;
}

export function isTlhModelHidden(
	model: ProviderModelReference,
	config: ResolvedTlhModelVisibilityConfig = getTlhModelVisibilityConfig(),
): boolean {
	if (config.disabled) {
		return false;
	}
	if (matchesAnyPattern(model, config.visible)) {
		return false;
	}
	return matchesAnyPattern(model, TLH_HIDDEN_MODEL_DEFAULTS) || matchesAnyPattern(model, config.hidden);
}

export function filterTlhVisibleModels<T extends ProviderModelReference>(
	models: readonly T[],
	config: ResolvedTlhModelVisibilityConfig = getTlhModelVisibilityConfig(),
): T[] {
	if (config.disabled) {
		return [...models];
	}
	return models.filter((model) => !isTlhModelHidden(model, config));
}

export function installTlhModelVisibilityFilter(): void {
	const modelRuntimePrototype = ModelRuntime.prototype as ModelRuntimePrototype;
	if (!modelRuntimePrototype[TLH_MODEL_VISIBILITY_RUNTIME_PATCHED]) {
		const originalGetAvailable = modelRuntimePrototype.getAvailable;
		const originalGetAvailableSnapshot = modelRuntimePrototype.getAvailableSnapshot;
		modelRuntimePrototype[TLH_MODEL_VISIBILITY_RUNTIME_GET_AVAILABLE_ORIGINAL] = originalGetAvailable;
		modelRuntimePrototype[TLH_MODEL_VISIBILITY_RUNTIME_GET_AVAILABLE_SNAPSHOT_ORIGINAL] = originalGetAvailableSnapshot;
		modelRuntimePrototype.getAvailable = async function tlhModelVisibilityRuntimeGetAvailable(
			this: ModelRuntime,
			providerId?: string,
			options?: Parameters<ModelRuntime["getAvailable"]>[1],
		): ReturnType<typeof originalGetAvailable> {
			return filterTlhVisibleModels(await originalGetAvailable.call(this, providerId, options));
		};
		modelRuntimePrototype.getAvailableSnapshot = function tlhModelVisibilityRuntimeGetAvailableSnapshot(
			this: ModelRuntime,
		): ReturnType<typeof originalGetAvailableSnapshot> {
			return filterTlhVisibleModels(originalGetAvailableSnapshot.call(this));
		};
		modelRuntimePrototype[TLH_MODEL_VISIBILITY_RUNTIME_PATCHED] = true;
	}

	const modelRegistryPrototype = ModelRegistry.prototype as ModelRegistryPrototype;
	if (!modelRegistryPrototype[TLH_MODEL_VISIBILITY_PATCHED]) {
		const originalGetAvailable = modelRegistryPrototype.getAvailable;
		modelRegistryPrototype[TLH_MODEL_VISIBILITY_GET_AVAILABLE_ORIGINAL] = originalGetAvailable;
		modelRegistryPrototype.getAvailable = function tlhModelVisibilityGetAvailable(
			this: ModelRegistry,
		): ReturnType<typeof originalGetAvailable> {
			return filterTlhVisibleModels(originalGetAvailable.call(this));
		};
		modelRegistryPrototype[TLH_MODEL_VISIBILITY_PATCHED] = true;
	}

	const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
	if (
		interactiveModePrototype[TLH_MODEL_VISIBILITY_EXACT_LOOKUP_PATCHED] ||
		typeof interactiveModePrototype.findExactModelMatch !== "function"
	) {
		return;
	}

	const originalFindExactModelMatch = interactiveModePrototype.findExactModelMatch;
	interactiveModePrototype[TLH_MODEL_VISIBILITY_FIND_EXACT_MODEL_MATCH_ORIGINAL] = originalFindExactModelMatch;
	interactiveModePrototype.findExactModelMatch = async function tlhFindExactModelMatch(
		this: InteractiveModeLike,
		searchTerm: string,
	): Promise<ProviderModelReference | undefined> {
		const isUnscopedCanonicalReference =
			isCanonicalModelReference(searchTerm) && (this.session?.scopedModels?.length ?? 0) === 0;
		if (isUnscopedCanonicalReference) {
			try {
				// Preserve Pi's filtered cached-match priority. A canonical-looking
				// reference can also be a visible bare model id under another provider.
				const filteredCachedMatch = findExactModelReferenceMatch(
					searchTerm,
					this.session?.modelRuntime?.getAvailableSnapshot() ?? this.session?.modelRegistry?.getAvailable() ?? [],
				);
				if (filteredCachedMatch) {
					return filteredCachedMatch;
				}

				// Recover a known TLH-hidden canonical model from the unfiltered cached
				// snapshot so explicit references do not enter Pi's refresh/status path.
				const unfilteredCachedMatch = findExactModelReferenceMatch(
					searchTerm,
					getUnfilteredAvailableModels(this.session),
				);
				if (unfilteredCachedMatch && isTlhModelHidden(unfilteredCachedMatch)) {
					return unfilteredCachedMatch;
				}
			} catch {
				// Preserve Pi's matcher as the compatibility fallback when the runtime
				// shape is unavailable or its snapshots cannot be read.
			}
		}

		const exactMatch = await originalFindExactModelMatch.call(this, searchTerm);
		const hasScopedModelsAfterDelegation = (this.session?.scopedModels?.length ?? 0) > 0;
		if (exactMatch || !isUnscopedCanonicalReference || hasScopedModelsAfterDelegation) {
			return exactMatch;
		}

		try {
			// Pi's refresh may discover a TLH-hidden model that its final filtered
			// snapshot cannot return. Retry the refreshed unfiltered snapshot.
			const refreshedMatch = findExactModelReferenceMatch(searchTerm, getUnfilteredAvailableModels(this.session));
			return refreshedMatch && isTlhModelHidden(refreshedMatch) ? refreshedMatch : exactMatch;
		} catch {
			return exactMatch;
		}
	};
	interactiveModePrototype[TLH_MODEL_VISIBILITY_EXACT_LOOKUP_PATCHED] = true;
}

function getUnfilteredRuntimeAvailableSnapshot(
	modelRuntime: Pick<ModelRuntime, "getAvailableSnapshot">,
): ReturnType<ModelRegistry["getAvailable"]> {
	const modelRuntimePrototype = Object.getPrototypeOf(modelRuntime) as ModelRuntimePrototype | null;
	const originalGetAvailableSnapshot =
		modelRuntimePrototype?.[TLH_MODEL_VISIBILITY_RUNTIME_GET_AVAILABLE_SNAPSHOT_ORIGINAL];
	return originalGetAvailableSnapshot
		? [...originalGetAvailableSnapshot.call(modelRuntime as ModelRuntime)]
		: [...modelRuntime.getAvailableSnapshot()];
}

export function getUnfilteredAvailableModels(
	modelSource:
		| ModelRegistryCompatibilityFacade
		| Pick<ModelRuntime, "getAvailableSnapshot">
		| InteractiveModeLike["session"],
): ReturnType<ModelRegistry["getAvailable"]> {
	if (!modelSource) {
		return [];
	}
	if ("getAvailableSnapshot" in modelSource && typeof modelSource.getAvailableSnapshot === "function") {
		return getUnfilteredRuntimeAvailableSnapshot(modelSource);
	}
	if ("modelRuntime" in modelSource && modelSource.modelRuntime) {
		return getUnfilteredRuntimeAvailableSnapshot(modelSource.modelRuntime);
	}
	if ("modelRegistry" in modelSource && modelSource.modelRegistry) {
		return getUnfilteredAvailableModels(modelSource.modelRegistry);
	}
	const compatibilityRuntime = (modelSource as unknown as { runtime?: Pick<ModelRuntime, "getAvailableSnapshot"> })
		.runtime;
	if (compatibilityRuntime) {
		return getUnfilteredRuntimeAvailableSnapshot(compatibilityRuntime);
	}
	if ("getAvailable" in modelSource && typeof modelSource.getAvailable === "function") {
		const modelRegistryPrototype = Object.getPrototypeOf(modelSource) as ModelRegistryPrototype | null;
		const originalGetAvailable = modelRegistryPrototype?.[TLH_MODEL_VISIBILITY_GET_AVAILABLE_ORIGINAL];
		return originalGetAvailable
			? originalGetAvailable.call(modelSource as unknown as ModelRegistry)
			: modelSource.getAvailable();
	}
	return [];
}

export type { ResolvedTlhModelVisibilityConfig };
