const NOISE_FLOOR_TOKENS = 1024;
const BUILT_IN_TOOL_NAMES = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);
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
const PREFERRED_SUBAGENT_CHILD_KEYS = ["results", "steps"];
const MAX_DISCOVERY_DEPTH = 8;
const MAX_DISCOVERY_ARRAY_ITEMS = 64;
const MAX_DISCOVERY_OBJECT_PROPERTIES = 64;
const MAX_DISCOVERY_ARTIFACT_PATHS = 64;
const MAX_DISCOVERY_CONTAINERS = 512;
export function analyzeCurrentSessionUsage(sessionManager, toolCatalog = [], priceSource) {
    const header = sessionManager.getHeader();
    return analyzeSessionEntries(sessionManager.getEntries(), {
        sessionId: header?.id,
        sessionName: sessionManager.getSessionName(),
        startedAt: header?.timestamp,
        activeLeafId: sessionManager.getLeafId(),
        toolCatalog,
        priceSource,
    });
}
export function analyzeSessionEntries(entries, { sessionId, sessionName, startedAt, activeLeafId, toolCatalog = [], priceSource, } = {}) {
    const byId = new Map();
    const childCounts = new Map();
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
    const primaryCoverage = { assistantMessages: 0, withUsage: 0, withoutUsage: 0 };
    const subagentTotals = createUsageTotals();
    const modelUsage = new Map();
    const toolUsage = new Map();
    const toolSourceUsage = new Map();
    const subagentRuns = new Map();
    const sessionRefs = new Map();
    const artifactRefs = new Map();
    const intercomTargets = new Set();
    const timeline = [];
    let currentTurn;
    let totalToolResults = 0;
    let totalToolErrors = 0;
    let mcpProxyCalls = 0;
    let mcpDirectCalls = 0;
    let cacheMissPrev;
    let assistantTurnIndex = 0;
    const cacheMissEvents = [];
    let totalMissedTokens = 0;
    let totalMissedCost = 0;
    for (const entry of entries) {
        if (entry.type === "compaction" || entry.type === "branch_summary") {
            cacheMissPrev = undefined;
        }
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
            }
            else {
                primaryCoverage.withoutUsage += 1;
                primaryTotals.turns += 1;
                primaryTotals.assistantMessages += 1;
            }
            const rawMsgUsage = isRecord(message.usage) ? message.usage : undefined;
            const cmInput = numberFromUnknown(rawMsgUsage?.input ?? rawMsgUsage?.inputTokens) ?? 0;
            const cmCacheRead = numberFromUnknown(rawMsgUsage?.cacheRead ?? rawMsgUsage?.cacheReadTokens ?? rawMsgUsage?.cache_read_input_tokens ?? rawMsgUsage?.cacheReadInputTokens) ?? 0;
            const cmCacheWrite = numberFromUnknown(rawMsgUsage?.cacheWrite ?? rawMsgUsage?.cacheWriteTokens ?? rawMsgUsage?.cache_creation_input_tokens ?? rawMsgUsage?.cacheWriteInputTokens) ?? 0;
            const cmPromptTokens = cmInput + cmCacheRead + cmCacheWrite;
            const rawCost = isRecord(rawMsgUsage?.cost) ? rawMsgUsage.cost : undefined;
            const cmCostInput = numberFromUnknown(rawCost?.input) ?? 0;
            const cmCostCacheWrite = numberFromUnknown(rawCost?.cacheWrite) ?? 0;
            const cmCostCacheRead = numberFromUnknown(rawCost?.cacheRead) ?? 0;
            const cmProvider = typeof message.provider === "string" ? message.provider : "";
            const cmModel = typeof message.model === "string" ? message.model : "";
            const cmModelKey = `${cmProvider}/${cmModel}`;
            const cmTimestampMs = Date.parse(entry.timestamp);
            const cmTimestamp = Number.isFinite(cmTimestampMs) ? cmTimestampMs : 0;
            if (cacheMissPrev !== undefined &&
                cmPromptTokens > 0 &&
                !(cmCacheRead + cmCacheWrite === 0 && !cacheMissPrev.reportedCache)) {
                const missedTokens = Math.min(cacheMissPrev.promptTokens, cmPromptTokens) - cmCacheRead;
                if (missedTokens > NOISE_FLOOR_TOKENS) {
                    const paidTokens = cmInput + cmCacheWrite;
                    const paidPerToken = paidTokens > 0 ? (cmCostInput + cmCostCacheWrite) / paidTokens : 0;
                    const readPerToken = cmCacheRead > 0
                        ? cmCostCacheRead / cmCacheRead
                        : (priceSource?.find(cmProvider, cmModel)?.cost.cacheRead ?? 0) / 1_000_000;
                    const missedCost = missedTokens * Math.max(0, paidPerToken - readPerToken);
                    const idleMs = Math.max(0, cmTimestamp - cacheMissPrev.timestamp);
                    const modelChanged = cmModelKey !== cacheMissPrev.modelKey;
                    cacheMissEvents.push({ turnIndex: assistantTurnIndex, idleMs, modelChanged, missedTokens, missedCost });
                    totalMissedTokens += missedTokens;
                    totalMissedCost += missedCost;
                }
            }
            if (cmPromptTokens > 0) {
                cacheMissPrev = {
                    promptTokens: cmPromptTokens,
                    timestamp: cmTimestamp,
                    modelKey: cmModelKey,
                    reportedCache: (cacheMissPrev?.reportedCache ?? false) || cmCacheRead + cmCacheWrite > 0,
                };
            }
            assistantTurnIndex += 1;
            const activeBranch = activeBranchIds.has(entry.id);
            const turn = {
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
                        tools: new Set(),
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
                        }
                        else {
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
    const agentProviderUsage = new Map();
    for (const run of subagentRuns.values()) {
        if (run.usage) {
            addUsage(subagentTotals, run.usage);
        }
        const model = firstNonEmptyString(run.model, run.attemptedModels?.[0]);
        const provider = model ? splitProviderModel(model).provider : undefined;
        if (model) {
            const { modelId } = splitProviderModel(model);
            addModelUsage(modelUsage, {
                provider,
                modelId,
                source: "subagent",
                usage: run.usage ?? createUsageTotals(),
                countAsTurn: run.usage?.turns ?? 0,
                countAsAssistantMessage: run.usage?.assistantMessages ?? 0,
            });
        }
        if (run.usage) {
            const agentKey = `${run.agent ?? ""}:${provider ?? ""}`;
            const existing = agentProviderUsage.get(agentKey) ?? {
                key: agentKey,
                agent: run.agent,
                provider,
                usage: createUsageTotals(),
            };
            addUsage(existing.usage, run.usage);
            agentProviderUsage.set(agentKey, existing);
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
    const worstMisses = [...cacheMissEvents]
        .sort((a, b) => b.missedTokens - a.missedTokens)
        .slice(0, 10);
    return {
        cacheMisses: {
            missedTokens: totalMissedTokens,
            missedCost: totalMissedCost,
            missCount: cacheMissEvents.length,
            worst: worstMisses,
        },
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
            byTool: [...toolUsage.values()].sort((left, right) => right.approxTokens - left.approxTokens || right.callCount - left.callCount || right.resultCount - left.resultCount || left.toolName.localeCompare(right.toolName)),
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
            byAgent: [...agentProviderUsage.values()].sort((left, right) => (left.agent ?? "").localeCompare(right.agent ?? "") ||
                (left.provider ?? "").localeCompare(right.provider ?? "")),
            runs: [...subagentRuns.values()].sort((left, right) => (right.usage?.totalTokens ?? 0) - (left.usage?.totalTokens ?? 0) ||
                (left.agent ?? "").localeCompare(right.agent ?? "") ||
                left.key.localeCompare(right.key)),
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
function createUsageTotals() {
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
function cloneUsageTotals(usage) {
    return { ...usage };
}
function addUsage(target, usage, counts = {}) {
    target.inputTokens += usage.inputTokens;
    target.outputTokens += usage.outputTokens;
    target.cacheReadTokens += usage.cacheReadTokens;
    target.cacheWriteTokens += usage.cacheWriteTokens;
    target.totalTokens += usage.totalTokens;
    target.costUsd += usage.costUsd;
    target.turns += counts.turns ?? usage.turns;
    target.assistantMessages += counts.assistantMessages ?? usage.assistantMessages;
}
function normalizeUsage(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const inputTokens = numberFromUnknown(value.input ?? value.inputTokens) ?? 0;
    const outputTokens = numberFromUnknown(value.output ?? value.outputTokens) ?? 0;
    const cacheReadTokens = numberFromUnknown(value.cacheRead ?? value.cacheReadTokens ?? value.cache_read_input_tokens ?? value.cacheReadInputTokens) ?? 0;
    const cacheWriteTokens = numberFromUnknown(value.cacheWrite ?? value.cacheWriteTokens ?? value.cache_creation_input_tokens ?? value.cacheWriteInputTokens) ?? 0;
    const explicitTotal = numberFromUnknown(value.total ?? value.totalTokens);
    const costUsd = costFromUnknown(value.cost) ?? numberFromUnknown(value.costUsd) ?? 0;
    const turns = numberFromUnknown(value.turns) ?? 0;
    const assistantMessages = numberFromUnknown(value.assistantMessages) ?? turns;
    const hasAnyUsageField = "input" in value ||
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
function costFromUnknown(value) {
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
function numberFromUnknown(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function* takeArrayIndices(value, limit) {
    for (let index = 0; index < value.length && index < limit; index += 1) {
        yield index;
    }
}
function* takeOwnEnumerableKeys(value, limit) {
    let count = 0;
    for (const key in value) {
        if (!Object.hasOwn(value, key)) {
            continue;
        }
        if (count >= limit) {
            break;
        }
        yield key;
        count += 1;
    }
}
function collectActiveBranchIds(activeLeafId, byId) {
    const branch = new Set();
    if (!activeLeafId) {
        return branch;
    }
    let currentId = activeLeafId;
    while (currentId) {
        if (branch.has(currentId)) {
            break;
        }
        branch.add(currentId);
        currentId = byId.get(currentId)?.parentId;
    }
    return branch;
}
function estimateToolSource(toolName, catalogEntry) {
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
function addModelUsage(store, input) {
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
function sortModelUsage(models) {
    return models.sort((left, right) => right.usage.totalTokens - left.usage.totalTokens ||
        right.usage.turns - left.usage.turns ||
        left.key.localeCompare(right.key));
}
function collectStructuredDiscoveries(value, context) {
    const subagentRuns = new Map();
    const sessionRefs = new Map();
    const artifactRefs = new Map();
    const intercomTargets = new Set();
    const seenContainers = new Set();
    let containerVisits = 0;
    const registerRun = (run) => {
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
    const visit = (current, path, skipNestedRuns) => {
        if (path.length > MAX_DISCOVERY_DEPTH || !isRecord(current)) {
            return;
        }
        if (seenContainers.has(current) || containerVisits >= MAX_DISCOVERY_CONTAINERS) {
            return;
        }
        seenContainers.add(current);
        containerVisits += 1;
        const canDescend = path.length < MAX_DISCOVERY_DEPTH && containerVisits < MAX_DISCOVERY_CONTAINERS;
        if (Array.isArray(current)) {
            if (!canDescend) {
                return;
            }
            for (const index of takeArrayIndices(current, MAX_DISCOVERY_ARRAY_ITEMS)) {
                if (containerVisits >= MAX_DISCOVERY_CONTAINERS) {
                    break;
                }
                visit(current[index], [...path, String(index)], skipNestedRuns);
            }
            return;
        }
        const nestedRuns = !skipNestedRuns && canDescend ? collectPreferredNestedSubagentRuns(current, context) : [];
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
            for (const key of takeOwnEnumerableKeys(current.artifactPaths, MAX_DISCOVERY_ARTIFACT_PATHS)) {
                const artifactRef = sanitizePathReference(current.artifactPaths[key], "artifact");
                if (artifactRef) {
                    artifactRefs.set(referenceKey(artifactRef), artifactRef);
                }
            }
        }
        if (!canDescend) {
            return;
        }
        for (const key of takeOwnEnumerableKeys(current, MAX_DISCOVERY_OBJECT_PROPERTIES)) {
            if (SKIP_DISCOVERY_KEYS.has(key)) {
                continue;
            }
            if (run && SUBAGENT_NESTED_KEYS.has(key)) {
                continue;
            }
            if (containerVisits >= MAX_DISCOVERY_CONTAINERS) {
                break;
            }
            visit(current[key], [...path, key], skipNestedRuns ||
                Boolean(run) ||
                (nestedRuns.length > 0 && PREFERRED_SUBAGENT_CHILD_KEYS.includes(key)));
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
function collectPreferredNestedSubagentRuns(value, context) {
    const runs = [];
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
        for (const index of takeArrayIndices(nested, MAX_DISCOVERY_ARRAY_ITEMS)) {
            const item = nested[index];
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
function sanitizeSubagentRun(value, context, inherited = {}) {
    const agent = stringFromUnknown(value.agent);
    const session = sanitizePathReference(value.sessionFile, "session");
    const intercomTarget = stringFromUnknown(value.intercomTarget, inherited.intercomTarget);
    const artifacts = collectArtifactReferences(value);
    const mode = stringFromUnknown(value.mode, inherited.mode);
    const attemptedModels = arrayOfStrings(value.attemptedModels);
    const model = stringFromUnknown(value.model);
    const runId = stringFromUnknown(value.runId, value.id, inherited.runId);
    const usage = normalizeUsage(value.usage) ??
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
    const hasStrongSignal = agent != null ||
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
function collectArtifactReferences(value) {
    const refs = new Map();
    for (const candidate of [value.inputPath, value.outputPath, value.metadataPath, value.htmlPath, value.artifactPath]) {
        const ref = sanitizePathReference(candidate, "artifact");
        if (ref) {
            refs.set(referenceKey(ref), ref);
        }
    }
    if (isRecord(value.artifactPaths)) {
        for (const key of takeOwnEnumerableKeys(value.artifactPaths, MAX_DISCOVERY_ARTIFACT_PATHS)) {
            const ref = sanitizePathReference(value.artifactPaths[key], "artifact");
            if (ref) {
                refs.set(referenceKey(ref), ref);
            }
        }
    }
    return [...refs.values()].sort((left, right) => left.label.localeCompare(right.label));
}
function sumUsageArray(value) {
    if (!Array.isArray(value) || value.length === 0) {
        return undefined;
    }
    const total = createUsageTotals();
    let foundUsage = false;
    for (const index of takeArrayIndices(value, MAX_DISCOVERY_ARRAY_ITEMS)) {
        const item = value[index];
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
function sanitizePathReference(value, kind) {
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
    const sessionId = kind === "session" && basename.endsWith(".jsonl") && basename !== "session.jsonl" ? basename.slice(0, -6) : undefined;
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
function buildSafePathLabel(kind, segments, basename) {
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
function referenceKey(reference) {
    return `${reference.kind}:${reference.label}`;
}
function registerDiscoveries(discoveries, stores) {
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
function stringFromUnknown(...values) {
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
function booleanFromUnknown(value) {
    return typeof value === "boolean" ? value : undefined;
}
function arrayOfStrings(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const strings = [];
    for (const index of takeArrayIndices(value, MAX_DISCOVERY_ARRAY_ITEMS)) {
        const item = value[index];
        if (typeof item !== "string") {
            continue;
        }
        const trimmed = item.trim();
        if (trimmed.length > 0) {
            strings.push(trimmed);
        }
    }
    return dedupeStrings(strings);
}
function dedupeStrings(values) {
    return [
        ...new Set(values
            .filter((value) => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)),
    ];
}
function firstNonEmptyString(...values) {
    return values.find((value) => typeof value === "string" && value.length > 0);
}
function splitProviderModel(value) {
    const slashIndex = value.indexOf("/");
    if (slashIndex <= 0 || slashIndex === value.length - 1) {
        return { modelId: value };
    }
    return {
        provider: value.slice(0, slashIndex),
        modelId: value.slice(slashIndex + 1),
    };
}
function safeArgChars(args) {
    if (args == null) {
        return 0;
    }
    try {
        return JSON.stringify(args).length;
    }
    catch {
        return 0;
    }
}
function resultContentChars(content) {
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
