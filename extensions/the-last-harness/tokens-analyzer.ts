import type { ExtensionContext, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";

const BUILT_IN_TOOL_NAMES = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);
/** Approximate characters per token used for tool-payload size estimates. */
const CHARS_PER_TOKEN = 4;
const SKIP_DISCOVERY_KEYS = new Set([
	"content",
	"messages",
	"output",
	"summary",
	"stderr",
	"stdout",
	"text",
	"task",
	"error",
	"errorMessage",
	"finalOutput",
	"displayOutput",
]);
const SUBAGENT_NESTED_KEYS = new Set(["results", "steps", "children", "modelAttempts"]);
const PREFERRED_SUBAGENT_CHILD_KEYS = ["results", "steps"] as const;
const MAX_DISCOVERY_DEPTH = 8;
const MAX_DISCOVERY_ARRAY_ITEMS = 64;
const MAX_DISCOVERY_OBJECTS = 512;

type TokensAnalysisSessionManager = Pick<ExtensionContext["sessionManager"], "getEntries" | "getHeader" | "getLeafId" | "getSessionName">;

export type TlhUsageTotals = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
	turns: number;
	assistantMessages: number;
};

export type TlhUsageCoverage = {
	assistantMessages: number;
	withUsage: number;
	withoutUsage: number;
};

export type TlhModelUsage = {
	key: string;
	provider?: string;
	modelId: string;
	source: "primary" | "subagent";
	usage: TlhUsageTotals;
};

export type TlhSanitizedReference = {
	kind: "artifact" | "session";
	label: string;
	basename: string;
	extension?: string;
	runId?: string;
	sessionId?: string;
	pathRedacted: true;
};

export type TlhToolSourceEstimate = {
	key: string;
	label: string;
	kind: "built-in" | "extension" | "mcp-proxy" | "mcp-direct" | "unknown";
	source?: string;
	scope?: string;
	origin?: string;
	estimated: true;
};

export type TlhToolUsage = {
	toolName: string;
	callCount: number;
	resultCount: number;
	errorCount: number;
	/** Estimated tokens consumed by this tool's call arguments plus result content. */
	approxTokens: number;
	mcp: boolean;
	source: TlhToolSourceEstimate;
};

export type TlhToolSourceUsage = {
	source: TlhToolSourceEstimate;
	callCount: number;
	/** Estimated tokens consumed by all tools in this source group. */
	approxTokens: number;
	tools: string[];
};

export type TlhDiscoveredSubagentRun = {
	key: string;
	sourceEntryId: string;
	sourceTurnIndex?: number;
	runId?: string;
	agent?: string;
	agents?: string[];
	mode?: string;
	model?: string;
	attemptedModels?: string[];
	intercomTarget?: string;
	session?: TlhSanitizedReference;
	artifacts: TlhSanitizedReference[];
	usage?: TlhUsageTotals;
	success?: boolean;
	exitCode?: number;
};

export type TlhUsageTimelineTurn = {
	turnIndex: number;
	entryId: string;
	timestamp: string;
	activeBranch: boolean;
	provider?: string;
	modelId?: string;
	stopReason?: string;
	usageReported: boolean;
	usage: TlhUsageTotals;
	toolCalls: {
		total: number;
		mcp: number;
		byTool: Array<{
			toolName: string;
			count: number;
		}>;
	};
	toolResults: {
		total: number;
		errors: number;
	};
	discoveries: {
		subagentRuns: number;
		artifactReferences: number;
		sessionReferences: number;
		intercomTargets: number;
	};
};

export type TlhToolCatalogEntry = Pick<ToolInfo, "name" | "sourceInfo">;

export type TlhSessionUsageAnalysisOptions = {
	sessionId?: string;
	sessionName?: string;
	startedAt?: string;
	activeLeafId?: string | null;
	toolCatalog?: readonly TlhToolCatalogEntry[];
};

export type TlhSessionUsageAnalysis = {
	session: {
		sessionId?: string;
		sessionName?: string;
		startedAt?: string;
		entryCount: number;
		leafCount: number;
		activeLeafId?: string | null;
		assistantTurnsOnActiveBranch: number;
		assistantTurnsOffActiveBranch: number;
	};
	totals: {
		primary: TlhUsageTotals;
		subagents: TlhUsageTotals;
		combined: TlhUsageTotals;
	};
	primaryAssistant: {
		usage: TlhUsageTotals;
		usageCoverage: TlhUsageCoverage;
		models: TlhModelUsage[];
		timeline: TlhUsageTimelineTurn[];
	};
	tools: {
		precision: "estimated";
		totalCalls: number;
		totalResults: number;
		totalErrors: number;
		mcpCalls: number;
		mcpProxyCalls: number;
		mcpDirectCalls: number;
		/** Estimated tokens across all MCP tool calls and results combined. */
		mcpApproxTokens: number;
		/** Estimated tokens across all tool calls and results combined. */
		totalToolApproxTokens: number;
		byTool: TlhToolUsage[];
		bySource: TlhToolSourceUsage[];
	};
	subagents: {
		precision: "discoverable-only";
		runCount: number;
		usage: TlhUsageTotals;
		models: TlhModelUsage[];
		runs: TlhDiscoveredSubagentRun[];
	};
	references: {
		artifacts: TlhSanitizedReference[];
		sessions: TlhSanitizedReference[];
		intercomTargets: string[];
	};
	caveats: string[];
};

type MutableTurn = TlhUsageTimelineTurn & {
	toolCallCounts: Map<string, number>;
};

type DiscoveryContext = {
	sourceEntryId: string;
	sourceTurnIndex?: number;
};

type StructuredDiscoveries = {
	subagentRuns: TlhDiscoveredSubagentRun[];
	sessionRefs: TlhSanitizedReference[];
	artifactRefs: TlhSanitizedReference[];
	intercomTargets: string[];
};

export function analyzeCurrentSessionUsage(
	sessionManager: TokensAnalysisSessionManager,
	toolCatalog: readonly TlhToolCatalogEntry[] = [],
): TlhSessionUsageAnalysis {
	const header = sessionManager.getHeader();
	return analyzeSessionEntries(sessionManager.getEntries(), {
		sessionId: header?.id,
		sessionName: sessionManager.getSessionName(),
		startedAt: header?.timestamp,
		activeLeafId: sessionManager.getLeafId(),
		toolCatalog,
	});
}

export function analyzeSessionEntries(
	entries: SessionEntry[],
	{
		sessionId,
		sessionName,
		startedAt,
		activeLeafId,
		toolCatalog = [],
	}: TlhSessionUsageAnalysisOptions = {},
): TlhSessionUsageAnalysis {
	const byId = new Map<string, SessionEntry>();
	const childCounts = new Map<string, number>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
		if (entry.parentId) {
			childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1);
		}
	}

	const leafCount = entries.filter((entry) => !childCounts.has(entry.id)).length;
	const activeBranchIds = collectActiveBranchIds(activeLeafId, byId);
	const toolCatalogByName = new Map(toolCatalog.map((tool) => [tool.name, tool]));
	const primaryTotals = createUsageTotals();
	const primaryCoverage: TlhUsageCoverage = { assistantMessages: 0, withUsage: 0, withoutUsage: 0 };
	const subagentTotals = createUsageTotals();
	const modelUsage = new Map<string, TlhModelUsage>();
	const toolUsage = new Map<string, TlhToolUsage>();
	const toolSourceUsage = new Map<string, { source: TlhToolSourceEstimate; callCount: number; approxTokens: number; tools: Set<string> }>();
	const subagentRuns = new Map<string, TlhDiscoveredSubagentRun>();
	const sessionRefs = new Map<string, TlhSanitizedReference>();
	const artifactRefs = new Map<string, TlhSanitizedReference>();
	const intercomTargets = new Set<string>();
	const timeline: MutableTurn[] = [];
	let currentTurn: MutableTurn | undefined;
	let totalToolResults = 0;
	let totalToolErrors = 0;
	let mcpProxyCalls = 0;
	let mcpDirectCalls = 0;

	for (const entry of entries) {
		if (entry.type === "custom") {
			registerDiscoveries(collectStructuredDiscoveries(entry.data, { sourceEntryId: entry.id }), {
				subagentRuns,
				sessionRefs,
				artifactRefs,
				intercomTargets,
			});
			continue;
		}

		if (entry.type === "custom_message") {
			registerDiscoveries(collectStructuredDiscoveries(entry.details, { sourceEntryId: entry.id }), {
				subagentRuns,
				sessionRefs,
				artifactRefs,
				intercomTargets,
			});
			continue;
		}

		if (entry.type !== "message") {
			continue;
		}

		const { message } = entry;
		if (message.role === "assistant") {
			const usage = normalizeUsage(message.usage);
			const turnUsage = usage ?? createUsageTotals();
			primaryCoverage.assistantMessages += 1;
			if (usage) {
				primaryCoverage.withUsage += 1;
				addUsage(primaryTotals, usage, { turns: 1, assistantMessages: 1 });
			} else {
				primaryCoverage.withoutUsage += 1;
				primaryTotals.turns += 1;
				primaryTotals.assistantMessages += 1;
			}

			const activeBranch = activeBranchIds.has(entry.id);
			const turn: MutableTurn = {
				turnIndex: timeline.length + 1,
				entryId: entry.id,
				timestamp: entry.timestamp,
				activeBranch,
				provider: typeof message.provider === "string" ? message.provider : undefined,
				modelId: typeof message.model === "string" ? message.model : undefined,
				stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
				usageReported: usage != null,
				usage: turnUsage,
				toolCalls: { total: 0, mcp: 0, byTool: [] },
				toolResults: { total: 0, errors: 0 },
				discoveries: { subagentRuns: 0, artifactReferences: 0, sessionReferences: 0, intercomTargets: 0 },
				toolCallCounts: new Map(),
			};
			timeline.push(turn);
			currentTurn = turn;

			if (typeof message.model === "string") {
				addModelUsage(modelUsage, {
					provider: typeof message.provider === "string" ? message.provider : undefined,
					modelId: message.model,
					source: "primary",
					usage: usage ?? createUsageTotals(),
					countAsTurn: 1,
					countAsAssistantMessage: 1,
				});
			}

			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block?.type !== "toolCall" || typeof block.name !== "string") {
						continue;
					}

					const source = estimateToolSource(block.name, toolCatalogByName.get(block.name));
					const existing = toolUsage.get(block.name) ?? {
						toolName: block.name,
						callCount: 0,
						resultCount: 0,
						errorCount: 0,
						approxTokens: 0,
						mcp: source.kind === "mcp-proxy" || source.kind === "mcp-direct",
						source,
					};
					existing.callCount += 1;
					const argApproxTokens = Math.ceil(safeArgChars(block.arguments) / CHARS_PER_TOKEN);
					existing.approxTokens += argApproxTokens;
					toolUsage.set(block.name, existing);

					const sourceBucket = toolSourceUsage.get(source.key) ?? {
						source,
						callCount: 0,
						approxTokens: 0,
						tools: new Set<string>(),
					};
					sourceBucket.callCount += 1;
					sourceBucket.approxTokens += argApproxTokens;
					sourceBucket.tools.add(block.name);
					toolSourceUsage.set(source.key, sourceBucket);

					turn.toolCalls.total += 1;
					turn.toolCallCounts.set(block.name, (turn.toolCallCounts.get(block.name) ?? 0) + 1);
					if (source.kind === "mcp-proxy" || source.kind === "mcp-direct") {
						turn.toolCalls.mcp += 1;
						if (source.kind === "mcp-proxy") {
							mcpProxyCalls += 1;
						} else {
							mcpDirectCalls += 1;
						}
					}
				}
			}
			continue;
		}

		if (message.role !== "toolResult") {
			continue;
		}

		totalToolResults += 1;
		if (message.isError) {
			totalToolErrors += 1;
		}
		if (currentTurn) {
			currentTurn.toolResults.total += 1;
			if (message.isError) {
				currentTurn.toolResults.errors += 1;
			}
		}

		if (typeof message.toolName === "string") {
			const source = estimateToolSource(message.toolName, toolCatalogByName.get(message.toolName));
			const existing = toolUsage.get(message.toolName) ?? {
				toolName: message.toolName,
				callCount: 0,
				resultCount: 0,
				errorCount: 0,
				approxTokens: 0,
				mcp: source.kind === "mcp-proxy" || source.kind === "mcp-direct",
				source,
			};
			existing.resultCount += 1;
			if (message.isError) {
				existing.errorCount += 1;
			}
			const resultApproxTokens = Math.ceil(resultContentChars(message.content) / CHARS_PER_TOKEN);
			existing.approxTokens += resultApproxTokens;
			toolUsage.set(message.toolName, existing);
			const resultSourceBucket = toolSourceUsage.get(source.key);
			if (resultSourceBucket) {
				resultSourceBucket.approxTokens += resultApproxTokens;
			}
		}

		const discoveries = collectStructuredDiscoveries(message, {
			sourceEntryId: entry.id,
			sourceTurnIndex: currentTurn?.turnIndex,
		});
		const discoveryCounts = registerDiscoveries(discoveries, {
			subagentRuns,
			sessionRefs,
			artifactRefs,
			intercomTargets,
		});
		if (currentTurn) {
			currentTurn.discoveries.subagentRuns += discoveryCounts.subagentRuns;
			currentTurn.discoveries.artifactReferences += discoveryCounts.artifactRefs;
			currentTurn.discoveries.sessionReferences += discoveryCounts.sessionRefs;
			currentTurn.discoveries.intercomTargets += discoveryCounts.intercomTargets;
		}
	}

	for (const run of subagentRuns.values()) {
		if (run.usage) {
			addUsage(subagentTotals, run.usage);
		}
		const model = firstNonEmptyString(run.model, run.attemptedModels?.[0]);
		if (model) {
			const { provider, modelId } = splitProviderModel(model);
			addModelUsage(modelUsage, {
				provider,
				modelId,
				source: "subagent",
				usage: run.usage ?? createUsageTotals(),
				countAsTurn: run.usage?.turns ?? 0,
				countAsAssistantMessage: run.usage?.assistantMessages ?? 0,
			});
		}
	}

	const renderedTimeline = timeline.map(({ toolCallCounts, ...turn }) => ({
		...turn,
		toolCalls: {
			...turn.toolCalls,
			byTool: [...toolCallCounts.entries()]
				.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
				.map(([toolName, count]) => ({ toolName, count })),
		},
	}));

	const combinedTotals = cloneUsageTotals(primaryTotals);
	addUsage(combinedTotals, subagentTotals);

	return {
		session: {
			sessionId,
			sessionName,
			startedAt,
			entryCount: entries.length,
			leafCount,
			activeLeafId,
			assistantTurnsOnActiveBranch: timeline.filter((turn) => turn.activeBranch).length,
			assistantTurnsOffActiveBranch: timeline.filter((turn) => !turn.activeBranch).length,
		},
		totals: {
			primary: primaryTotals,
			subagents: subagentTotals,
			combined: combinedTotals,
		},
		primaryAssistant: {
			usage: primaryTotals,
			usageCoverage: primaryCoverage,
			models: sortModelUsage([...modelUsage.values()].filter((model) => model.source === "primary")),
			timeline: renderedTimeline,
		},
		tools: {
			precision: "estimated",
			totalCalls: [...toolUsage.values()].reduce((sum, tool) => sum + tool.callCount, 0),
			totalResults: totalToolResults,
			totalErrors: totalToolErrors,
			mcpCalls: mcpProxyCalls + mcpDirectCalls,
			mcpProxyCalls,
			mcpDirectCalls,
			byTool: [...toolUsage.values()].sort(
				(left, right) => right.approxTokens - left.approxTokens || right.callCount - left.callCount || right.resultCount - left.resultCount || left.toolName.localeCompare(right.toolName),
			),
			mcpApproxTokens: [...toolUsage.values()].reduce((sum, tool) => (tool.mcp ? sum + tool.approxTokens : sum), 0),
			totalToolApproxTokens: [...toolUsage.values()].reduce((sum, tool) => sum + tool.approxTokens, 0),
			bySource: [...toolSourceUsage.values()]
				.map((bucket) => ({
					source: bucket.source,
					callCount: bucket.callCount,
					approxTokens: bucket.approxTokens,
					tools: [...bucket.tools].sort((left, right) => left.localeCompare(right)),
				}))
				.sort((left, right) => right.callCount - left.callCount || left.source.label.localeCompare(right.source.label)),
		},
		subagents: {
			precision: "discoverable-only",
			runCount: subagentRuns.size,
			usage: subagentTotals,
			models: sortModelUsage([...modelUsage.values()].filter((model) => model.source === "subagent")),
			runs: [...subagentRuns.values()].sort(
				(left, right) =>
					(right.usage?.totalTokens ?? 0) - (left.usage?.totalTokens ?? 0) ||
					(left.agent ?? "").localeCompare(right.agent ?? "") ||
					left.key.localeCompare(right.key),
			),
		},
		references: {
			artifacts: [...artifactRefs.values()].sort((left, right) => left.label.localeCompare(right.label)),
			sessions: [...sessionRefs.values()].sort((left, right) => left.label.localeCompare(right.label)),
			intercomTargets: [...intercomTargets].sort((left, right) => left.localeCompare(right)),
		},
		caveats: [
			"Primary assistant token and cost totals use provider-reported assistant usage exactly where the session recorded it.",
			"Tool, MCP, and source attribution are estimates derived from tool names and the current tool catalog.",
			"Tool I/O token counts are estimated from payload size (~4 chars/token), are not provider-reported, and reflect model-visible tool arguments and result content rather than turn-level token attribution.",
			"Subagent usage appears only when structured session data exposed it; missing discoveries do not prove zero subagent spend.",
			"Artifact and session references are sanitized and do not expose absolute local paths.",
		],
	};
}

function createUsageTotals(): TlhUsageTotals {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		turns: 0,
		assistantMessages: 0,
	};
}

function cloneUsageTotals(usage: TlhUsageTotals): TlhUsageTotals {
	return { ...usage };
}

function addUsage(
	target: TlhUsageTotals,
	usage: TlhUsageTotals,
	counts: { turns?: number; assistantMessages?: number } = {},
): void {
	target.inputTokens += usage.inputTokens;
	target.outputTokens += usage.outputTokens;
	target.cacheReadTokens += usage.cacheReadTokens;
	target.cacheWriteTokens += usage.cacheWriteTokens;
	target.totalTokens += usage.totalTokens;
	target.costUsd += usage.costUsd;
	target.turns += counts.turns ?? usage.turns;
	target.assistantMessages += counts.assistantMessages ?? usage.assistantMessages;
}

function normalizeUsage(value: unknown): TlhUsageTotals | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const inputTokens = numberFromUnknown(value.input ?? value.inputTokens) ?? 0;
	const outputTokens = numberFromUnknown(value.output ?? value.outputTokens) ?? 0;
	const cacheReadTokens =
		numberFromUnknown(value.cacheRead ?? value.cacheReadTokens ?? value.cache_read_input_tokens ?? value.cacheReadInputTokens) ?? 0;
	const cacheWriteTokens =
		numberFromUnknown(value.cacheWrite ?? value.cacheWriteTokens ?? value.cache_creation_input_tokens ?? value.cacheWriteInputTokens) ?? 0;
	const explicitTotal = numberFromUnknown(value.total ?? value.totalTokens);
	const costUsd = costFromUnknown(value.cost) ?? numberFromUnknown(value.costUsd) ?? 0;
	const turns = numberFromUnknown(value.turns) ?? 0;
	const assistantMessages = numberFromUnknown(value.assistantMessages) ?? turns;
	const hasAnyUsageField =
		"input" in value ||
		"inputTokens" in value ||
		"output" in value ||
		"outputTokens" in value ||
		"cacheRead" in value ||
		"cacheReadTokens" in value ||
		"cacheWrite" in value ||
		"cacheWriteTokens" in value ||
		"cache_read_input_tokens" in value ||
		"cache_creation_input_tokens" in value ||
		"total" in value ||
		"totalTokens" in value ||
		"cost" in value;
	if (!hasAnyUsageField) {
		return undefined;
	}

	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens: explicitTotal ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
		costUsd,
		turns,
		assistantMessages,
	};
}

function costFromUnknown(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (!isRecord(value)) {
		return undefined;
	}
	const explicitTotal = numberFromUnknown(value.total);
	if (explicitTotal != null) {
		return explicitTotal;
	}
	const input = numberFromUnknown(value.input) ?? 0;
	const output = numberFromUnknown(value.output) ?? 0;
	const cacheRead = numberFromUnknown(value.cacheRead) ?? 0;
	const cacheWrite = numberFromUnknown(value.cacheWrite) ?? 0;
	if (!("input" in value || "output" in value || "cacheRead" in value || "cacheWrite" in value)) {
		return undefined;
	}
	return input + output + cacheRead + cacheWrite;
}

function numberFromUnknown(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Intentionally includes arrays (unlike common.ts isPlainObject which excludes them).
// artifactPaths can arrive as an array in the wild; the two call sites that handle it
// (in collectArtifactReferences and the standalone artifact-entry sanitizer) iterate
// Object.values(artifactPaths), which works correctly for both plain objects and arrays.
// Replacing this with the shared common.ts isRecord/isPlainObject would silently skip
// array-valued artifactPaths at those call sites.
// If the schema for artifactPaths is ever narrowed to plain-object-only, audit those
// call sites first and confirm no callers pass an array before switching.
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function collectActiveBranchIds(activeLeafId: string | null | undefined, byId: Map<string, SessionEntry>): Set<string> {
	const branch = new Set<string>();
	if (!activeLeafId) {
		return branch;
	}
	let currentId: string | null | undefined = activeLeafId;
	while (currentId) {
		if (branch.has(currentId)) {
			break;
		}
		branch.add(currentId);
		currentId = byId.get(currentId)?.parentId;
	}
	return branch;
}

function estimateToolSource(toolName: string, catalogEntry?: TlhToolCatalogEntry): TlhToolSourceEstimate {
	if (toolName === "mcp") {
		return {
			key: catalogEntry?.sourceInfo?.source ? `mcp-proxy:${catalogEntry.sourceInfo.source}` : "mcp-proxy",
			label: catalogEntry?.sourceInfo?.source ? `MCP proxy (${catalogEntry.sourceInfo.source})` : "MCP proxy",
			kind: "mcp-proxy",
			source: catalogEntry?.sourceInfo?.source,
			scope: catalogEntry?.sourceInfo?.scope,
			origin: catalogEntry?.sourceInfo?.origin,
			estimated: true,
		};
	}

	const sourceHint = [catalogEntry?.sourceInfo?.source, catalogEntry?.sourceInfo?.path].filter((value) => typeof value === "string").join(" ");
	if (sourceHint && /mcp/i.test(sourceHint)) {
		return {
			key: catalogEntry?.sourceInfo?.source ? `mcp-direct:${catalogEntry.sourceInfo.source}` : `mcp-direct:${toolName}`,
			label: catalogEntry?.sourceInfo?.source ? `MCP direct (${catalogEntry.sourceInfo.source})` : `MCP direct (${toolName})`,
			kind: "mcp-direct",
			source: catalogEntry?.sourceInfo?.source,
			scope: catalogEntry?.sourceInfo?.scope,
			origin: catalogEntry?.sourceInfo?.origin,
			estimated: true,
		};
	}

	if (BUILT_IN_TOOL_NAMES.has(toolName)) {
		return {
			key: "built-in",
			label: "Built-in tools",
			kind: "built-in",
			estimated: true,
		};
	}

	if (catalogEntry?.sourceInfo) {
		const { sourceInfo } = catalogEntry;
		return {
			key: `extension:${sourceInfo.source}:${sourceInfo.scope}:${sourceInfo.origin}`,
			label: `Extension (${sourceInfo.source})`,
			kind: "extension",
			source: sourceInfo.source,
			scope: sourceInfo.scope,
			origin: sourceInfo.origin,
			estimated: true,
		};
	}

	return {
		key: `unknown:${toolName}`,
		label: `Unknown source (${toolName})`,
		kind: "unknown",
		estimated: true,
	};
}

function addModelUsage(
	store: Map<string, TlhModelUsage>,
	input: {
		provider?: string;
		modelId: string;
		source: "primary" | "subagent";
		usage: TlhUsageTotals;
		countAsTurn: number;
		countAsAssistantMessage: number;
	},
): void {
	const key = `${input.source}:${input.provider ? `${input.provider}/` : ""}${input.modelId}`;
	const existing = store.get(key) ?? {
		key: input.provider ? `${input.provider}/${input.modelId}` : input.modelId,
		provider: input.provider,
		modelId: input.modelId,
		source: input.source,
		usage: createUsageTotals(),
	};
	addUsage(existing.usage, input.usage, {
		turns: input.countAsTurn,
		assistantMessages: input.countAsAssistantMessage,
	});
	store.set(key, existing);
}

function sortModelUsage(models: TlhModelUsage[]): TlhModelUsage[] {
	return models.sort(
		(left, right) =>
			right.usage.totalTokens - left.usage.totalTokens ||
			right.usage.turns - left.usage.turns ||
			left.key.localeCompare(right.key),
	);
}

function collectStructuredDiscoveries(value: unknown, context: DiscoveryContext): StructuredDiscoveries {
	const subagentRuns = new Map<string, TlhDiscoveredSubagentRun>();
	const sessionRefs = new Map<string, TlhSanitizedReference>();
	const artifactRefs = new Map<string, TlhSanitizedReference>();
	const intercomTargets = new Set<string>();
	const seenObjects = new Set<object>();
	let objectVisits = 0;

	const registerRun = (run: TlhDiscoveredSubagentRun): void => {
		subagentRuns.set(run.key, run);
		if (run.session) {
			sessionRefs.set(referenceKey(run.session), run.session);
		}
		for (const artifact of run.artifacts) {
			artifactRefs.set(referenceKey(artifact), artifact);
		}
		if (run.intercomTarget) {
			intercomTargets.add(run.intercomTarget);
		}
	};

	const visit = (current: unknown, path: string[], skipNestedRuns: boolean): void => {
		if (path.length > MAX_DISCOVERY_DEPTH || objectVisits >= MAX_DISCOVERY_OBJECTS) {
			return;
		}
		if (Array.isArray(current)) {
			for (const [index, item] of current.slice(0, MAX_DISCOVERY_ARRAY_ITEMS).entries()) {
				visit(item, [...path, String(index)], skipNestedRuns);
			}
			return;
		}
		if (!isRecord(current)) {
			return;
		}
		if (seenObjects.has(current)) {
			return;
		}
		seenObjects.add(current);
		objectVisits += 1;

		const nestedRuns = !skipNestedRuns ? collectPreferredNestedSubagentRuns(current, context) : [];
		for (const nestedRun of nestedRuns) {
			registerRun(nestedRun);
		}

		const run = !skipNestedRuns && nestedRuns.length === 0 ? sanitizeSubagentRun(current, context) : undefined;
		if (run) {
			registerRun(run);
		}

		const sessionRef = sanitizePathReference(current.sessionFile, "session");
		if (sessionRef) {
			sessionRefs.set(referenceKey(sessionRef), sessionRef);
		}
		const intercomTarget = stringFromUnknown(current.intercomTarget);
		if (intercomTarget) {
			intercomTargets.add(intercomTarget);
		}
		const artifactPathCandidates = [
			current.inputPath,
			current.outputPath,
			current.metadataPath,
			current.htmlPath,
			current.artifactPath,
		];
		for (const candidate of artifactPathCandidates) {
			const artifactRef = sanitizePathReference(candidate, "artifact");
			if (artifactRef) {
				artifactRefs.set(referenceKey(artifactRef), artifactRef);
			}
		}
		if (isRecord(current.artifactPaths)) {
			for (const nestedValue of Object.values(current.artifactPaths)) {
				const artifactRef = sanitizePathReference(nestedValue, "artifact");
				if (artifactRef) {
					artifactRefs.set(referenceKey(artifactRef), artifactRef);
				}
			}
		}

		for (const [key, nestedValue] of Object.entries(current)) {
			if (SKIP_DISCOVERY_KEYS.has(key)) {
				continue;
			}
			if (run && SUBAGENT_NESTED_KEYS.has(key)) {
				continue;
			}
			visit(
				nestedValue,
				[...path, key],
				skipNestedRuns ||
					Boolean(run) ||
					(nestedRuns.length > 0 && PREFERRED_SUBAGENT_CHILD_KEYS.includes(key as (typeof PREFERRED_SUBAGENT_CHILD_KEYS)[number])),
			);
		}
	};

	visit(value, [], false);
	return {
		subagentRuns: [...subagentRuns.values()],
		sessionRefs: [...sessionRefs.values()],
		artifactRefs: [...artifactRefs.values()],
		intercomTargets: [...intercomTargets],
	};
}

function collectPreferredNestedSubagentRuns(
	value: Record<string, unknown>,
	context: DiscoveryContext,
): TlhDiscoveredSubagentRun[] {
	const runs: TlhDiscoveredSubagentRun[] = [];
	const inherited = {
		runId: stringFromUnknown(value.runId, value.id),
		mode: stringFromUnknown(value.mode),
		intercomTarget: stringFromUnknown(value.intercomTarget),
	};

	for (const key of PREFERRED_SUBAGENT_CHILD_KEYS) {
		const nested = value[key];
		if (!Array.isArray(nested)) {
			continue;
		}
		for (const item of nested.slice(0, MAX_DISCOVERY_ARRAY_ITEMS)) {
			if (!isRecord(item)) {
				continue;
			}
			const run = sanitizeSubagentRun(item, context, inherited);
			if (run) {
				runs.push(run);
			}
		}
	}

	return runs;
}

function sanitizeSubagentRun(
	value: Record<string, unknown>,
	context: DiscoveryContext,
	inherited: { runId?: string; mode?: string; intercomTarget?: string } = {},
): TlhDiscoveredSubagentRun | undefined {
	const agent = stringFromUnknown(value.agent);
	const session = sanitizePathReference(value.sessionFile, "session");
	const intercomTarget = stringFromUnknown(value.intercomTarget, inherited.intercomTarget);
	const artifacts = collectArtifactReferences(value);
	const mode = stringFromUnknown(value.mode, inherited.mode);
	const attemptedModels = arrayOfStrings(value.attemptedModels);
	const model = stringFromUnknown(value.model);
	const runId = stringFromUnknown(value.runId, value.id, inherited.runId);
	const usage =
		normalizeUsage(value.usage) ??
		sumUsageArray(value.modelAttempts) ??
		sumUsageArray(value.results) ??
		sumUsageArray(value.steps) ??
		undefined;
	const success = booleanFromUnknown(value.success);
	const exitCode = numberFromUnknown(value.exitCode);
	const agents = dedupeStrings([agent, ...arrayOfStrings(value.agents)]);
	const ownSessionId = stringFromUnknown(value.sessionId);
	const sessionId = ownSessionId ?? session?.sessionId;
	const ownRunId = stringFromUnknown(value.runId, value.id);
	const ownMode = stringFromUnknown(value.mode);
	const ownIntercomTarget = stringFromUnknown(value.intercomTarget);
	const hasStrongSignal =
		agent != null ||
		agents.length > 0 ||
		session != null ||
		ownSessionId != null ||
		ownIntercomTarget != null ||
		artifacts.length > 0 ||
		ownMode != null ||
		attemptedModels.length > 0 ||
		ownRunId != null;
	const looksLikeRun = hasStrongSignal || (usage != null && model != null);
	if (!looksLikeRun) {
		return undefined;
	}

	const key = [runId, session?.label, intercomTarget, agent, mode, model, context.sourceEntryId]
		.filter(Boolean)
		.join("|");
	return {
		key,
		sourceEntryId: context.sourceEntryId,
		sourceTurnIndex: context.sourceTurnIndex,
		runId,
		agent,
		agents: agents.length > 0 ? agents : undefined,
		mode,
		model,
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		intercomTarget,
		session: sessionId && session ? { ...session, sessionId } : session,
		artifacts,
		usage,
		success,
		exitCode,
	};
}

function collectArtifactReferences(value: Record<string, unknown>): TlhSanitizedReference[] {
	const refs = new Map<string, TlhSanitizedReference>();
	for (const candidate of [value.inputPath, value.outputPath, value.metadataPath, value.htmlPath, value.artifactPath]) {
		const ref = sanitizePathReference(candidate, "artifact");
		if (ref) {
			refs.set(referenceKey(ref), ref);
		}
	}
	if (isRecord(value.artifactPaths)) {
		for (const candidate of Object.values(value.artifactPaths)) {
			const ref = sanitizePathReference(candidate, "artifact");
			if (ref) {
				refs.set(referenceKey(ref), ref);
			}
		}
	}
	return [...refs.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function sumUsageArray(value: unknown): TlhUsageTotals | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}
	const total = createUsageTotals();
	let foundUsage = false;
	for (const item of value.slice(0, MAX_DISCOVERY_ARRAY_ITEMS)) {
		if (!isRecord(item)) {
			continue;
		}
		const usage = normalizeUsage(item.usage);
		if (usage) {
			addUsage(total, usage);
			foundUsage = true;
			continue;
		}
		const nested = normalizeUsage(item);
		if (nested) {
			addUsage(total, nested);
			foundUsage = true;
		}
	}
	return foundUsage ? total : undefined;
}

function sanitizePathReference(value: unknown, kind: "artifact" | "session"): TlhSanitizedReference | undefined {
	if (typeof value !== "string" || value.trim().length === 0) {
		return undefined;
	}
	const normalized = value.replaceAll("\\", "/");
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	const basename = segments.at(-1);
	if (!basename) {
		return undefined;
	}
	const extensionIndex = basename.lastIndexOf(".");
	const extension = extensionIndex > 0 ? basename.slice(extensionIndex) : undefined;
	const runId = [...segments].reverse().find((segment) => /^run-[A-Za-z0-9_-]+$/.test(segment));
	const sessionId =
		kind === "session" && basename.endsWith(".jsonl") && basename !== "session.jsonl" ? basename.slice(0, -6) : undefined;
	return {
		kind,
		label: buildSafePathLabel(kind, segments, basename),
		basename,
		extension,
		runId,
		sessionId,
		pathRedacted: true,
	};
}

function buildSafePathLabel(kind: "artifact" | "session", segments: string[], basename: string): string {
	const runIndex = segments.findIndex((segment) => /^run-[A-Za-z0-9_-]+$/.test(segment));
	if (runIndex >= 0) {
		return segments.slice(runIndex).join("/");
	}
	const bucket = kind === "artifact" ? "artifacts" : "sessions";
	const bucketIndex = segments.lastIndexOf(bucket);
	if (bucketIndex >= 0) {
		return [bucket, ...segments.slice(bucketIndex + 1)].join("/");
	}
	return basename;
}

function referenceKey(reference: TlhSanitizedReference): string {
	return `${reference.kind}:${reference.label}`;
}

function registerDiscoveries(
	discoveries: StructuredDiscoveries,
	stores: {
		subagentRuns: Map<string, TlhDiscoveredSubagentRun>;
		sessionRefs: Map<string, TlhSanitizedReference>;
		artifactRefs: Map<string, TlhSanitizedReference>;
		intercomTargets: Set<string>;
	},
): {
	subagentRuns: number;
	sessionRefs: number;
	artifactRefs: number;
	intercomTargets: number;
} {
	let subagentRunCount = 0;
	let sessionRefCount = 0;
	let artifactRefCount = 0;
	let intercomTargetCount = 0;

	for (const run of discoveries.subagentRuns) {
		if (!stores.subagentRuns.has(run.key)) {
			stores.subagentRuns.set(run.key, run);
			subagentRunCount += 1;
		}
	}
	for (const ref of discoveries.sessionRefs) {
		const key = referenceKey(ref);
		if (!stores.sessionRefs.has(key)) {
			stores.sessionRefs.set(key, ref);
			sessionRefCount += 1;
		}
	}
	for (const ref of discoveries.artifactRefs) {
		const key = referenceKey(ref);
		if (!stores.artifactRefs.has(key)) {
			stores.artifactRefs.set(key, ref);
			artifactRefCount += 1;
		}
	}
	for (const target of discoveries.intercomTargets) {
		if (!stores.intercomTargets.has(target)) {
			stores.intercomTargets.add(target);
			intercomTargetCount += 1;
		}
	}

	return {
		subagentRuns: subagentRunCount,
		sessionRefs: sessionRefCount,
		artifactRefs: artifactRefCount,
		intercomTargets: intercomTargetCount,
	};
}

function stringFromUnknown(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed.length > 0) {
				return trimmed;
			}
		}
	}
	return undefined;
}

function booleanFromUnknown(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return dedupeStrings(
		value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter((item) => item.length > 0),
	);
}

function dedupeStrings(values: Array<string | undefined>): string[] {
	return [
		...new Set(
			values
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter((value) => value.length > 0),
		),
	];
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
	return values.find((value) => typeof value === "string" && value.length > 0);
}

function splitProviderModel(value: string): { provider?: string; modelId: string } {
	const slashIndex = value.indexOf("/");
	if (slashIndex <= 0 || slashIndex === value.length - 1) {
		return { modelId: value };
	}
	return {
		provider: value.slice(0, slashIndex),
		modelId: value.slice(slashIndex + 1),
	};
}

/**
 * Serialize tool-call arguments to JSON and return the character length.
 * Returns 0 if arguments are absent or not serializable.
 * Only the character count is used — raw payload text is never stored.
 */
function safeArgChars(args: unknown): number {
	if (args == null) {
		return 0;
	}
	try {
		return JSON.stringify(args).length;
	} catch {
		return 0;
	}
}

/**
 * Sum the character length of all text items in a tool-result content array.
 * Image and other non-text items are excluded — only derived counts are used.
 */
function resultContentChars(content: unknown): number {
	if (!Array.isArray(content)) {
		return 0;
	}
	let total = 0;
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
			total += item.text.length;
		}
	}
	return total;
}
