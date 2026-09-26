import { createHash } from "node:crypto";
import { BACKGROUND_COMPLETION_NUDGE, CONTROL_NOTICE_NUDGE, SUBAGENT_ACTIONS, SUBAGENT_CONTROL_TYPE, SUBAGENT_NOTIFY_TYPE, TARGETING_ACTIONS, controlSourceKey, hasOwn, isCompletionBatchCandidate, isLegacyCompletionText, isLegacyControlText, isObject, MAX_COMPLETION_BATCH_STATES, parseCompletionBatchDetails, parseDirectSubagentControlEvent, parseLegacyUsage, parseNormalizedTelemetry, parseSubagentControlEvent, parsedCallOperation, safeMetadataString, safeOpaqueRunId, safeRunId, syntheticNudgeKind, } from "./subagent-analysis-parser.mjs";
import { tupleKey } from "./subagent-analysis-keys.mjs";
import { cloneSubagentUsage, } from "./subagent-analysis-aggregation.mjs";
function emptyManagementCalls() {
    return new Map();
}
function assistantUsage(message) {
    const usage = parseLegacyUsage(message.usage);
    return usage ? cloneSubagentUsage(usage) : null;
}
function managementCallsForWakeup(message, runIds) {
    const managementCalls = emptyManagementCalls();
    if (runIds.size === 0 || !Array.isArray(message.content))
        return managementCalls;
    for (const rawItem of message.content) {
        if (!isObject(rawItem) || rawItem.type !== "toolCall")
            continue;
        const toolName = typeof rawItem.toolName === "string"
            ? rawItem.toolName
            : typeof rawItem.name === "string"
                ? rawItem.name
                : undefined;
        if (toolName !== "subagent")
            continue;
        const operation = parsedCallOperation(rawItem);
        const action = operation.action;
        if (!action || !SUBAGENT_ACTIONS.has(action))
            continue;
        const target = TARGETING_ACTIONS.has(action) ? operation.targetRunId : undefined;
        if (!target || !runIds.has(target))
            continue;
        managementCalls.set(action, (managementCalls.get(action) ?? 0) + 1);
    }
    return managementCalls;
}
function makeWakeupRecord(source, attributed, reason, usage, managementCalls) {
    const byAction = Object.fromEntries([...managementCalls.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const runIds = [...new Set(source.runIds)].sort((a, b) => a.localeCompare(b));
    return {
        kind: source.kind,
        ...(runIds.length === 1 ? { runId: runIds[0] } : {}),
        ...(runIds.length > 1 ? { runIds } : {}),
        attributed,
        ...(reason ? { reason } : {}),
        assistantUsage: usage,
        managementCalls: {
            total: [...managementCalls.values()].reduce((sum, value) => sum + value, 0),
            byAction,
        },
    };
}
function finishWakeup(context, active, reason, usage = null, managementCalls = emptyManagementCalls(), attributed = false) {
    const record = active.registration.record;
    if (!context.wakeups.includes(record) || active.registration.finalized)
        return;
    Object.assign(record, makeWakeupRecord(active.source, attributed, reason, usage, managementCalls));
    active.registration.finalized = true;
    if (attributed)
        context.counters.wakeupsAttributed++;
    else
        context.counters.wakeupsUnattributed++;
    if (reason === "interrupted-by-human-input")
        context.counters.wakeupsInterruptedByHumanInput++;
    if (reason === "missing-assistant-turn")
        context.counters.wakeupsMissingAssistantTurn++;
    if (reason === "missing-run-id")
        context.counters.wakeupsMissingRunId++;
}
function abandonPendingSource(context, state) {
    if (!state.pendingSource)
        return;
    context.counters.wakeupsMissingNudge++;
    state.pendingSource = undefined;
}
function registerSource(context, state, source) {
    if (state.pendingSource)
        abandonPendingSource(context, state);
    state.pendingSource = source;
}
function detailsIndicateAsync(details) {
    return (details.asyncId !== undefined ||
        details.asyncDir !== undefined ||
        details.asyncReference === true);
}
function extractRunIdFromDetails(details, opaque = false) {
    if (!details)
        return undefined;
    const parse = opaque ? safeOpaqueRunId : safeRunId;
    return parse(details.runId) ?? parse(details.asyncId);
}
function processStructuredControlEventArray(context, state, events, source) {
    const limit = Math.min(events.length, 64);
    for (let index = 0; index < limit; index++) {
        context.counters.controlNotifications++;
        const parsed = parseDirectSubagentControlEvent(events[index], source);
        if (!parsed) {
            context.counters.malformedControlDetails++;
            continue;
        }
        const run = context.ensureRun(parsed.runId);
        const effectiveSource = parsed.source === "unknown" ? run.execution : parsed.source;
        run.sourceKinds.add("control-event");
        const agent = safeMetadataString(parsed.event.agent);
        if (agent)
            run.roles.add(agent);
        if (!run.telemetry && parsed.source !== "unknown")
            run.execution = parsed.source;
        const sourceKey = controlSourceKey(parsed.event, parsed.runId);
        const duplicate = context.seenControlSources.has(sourceKey);
        context.seenControlSources.add(sourceKey);
        if (effectiveSource !== "foreground" && !duplicate) {
            registerSource(context, state, {
                kind: "control",
                key: sourceKey,
                runIds: [parsed.runId],
                nudgeKind: "control",
            });
        }
    }
    if (events.length > limit)
        context.counters.malformedControlDetails++;
}
function processStructuredControlEvents(context, state, details) {
    const telemetry = parseNormalizedTelemetry(details.telemetry);
    const source = telemetry?.run.execution ?? (detailsIndicateAsync(details) ? "async" : "foreground");
    if (hasOwn(details, "controlEvents")) {
        if (Array.isArray(details.controlEvents))
            processStructuredControlEventArray(context, state, details.controlEvents, source);
        else
            context.counters.malformedControlDetails++;
    }
    if (!Array.isArray(details.results))
        return;
    const limit = Math.min(details.results.length, 64);
    for (let index = 0; index < limit; index++) {
        const result = details.results[index];
        if (!isObject(result) || !hasOwn(result, "controlEvents"))
            continue;
        if (Array.isArray(result.controlEvents))
            processStructuredControlEventArray(context, state, result.controlEvents, source);
        else
            context.counters.malformedControlDetails++;
    }
    if (details.results.length > limit)
        context.counters.malformedControlDetails++;
}
function completionBatchComplete(batch) {
    if (batch.invalid || batch.chunks.size !== batch.batchCount)
        return false;
    for (let index = 0; index < batch.batchCount; index++) {
        if (!batch.chunks.has(index))
            return false;
    }
    return true;
}
function completionChunkDigest(parsed) {
    return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}
function completionFlushSourceKey(flushId) {
    return tupleKey("completion-flush", flushId);
}
function completeCompletionFlush(state, finalBatch) {
    if (finalBatch.flushIndex >= MAX_COMPLETION_BATCH_STATES ||
        finalBatch.flushIndex !== finalBatch.flushCount - 1)
        return undefined;
    const flush = state.completionFlushes.get(finalBatch.flushId);
    if (!flush || flush.invalid || flush.flushCount !== finalBatch.flushCount)
        return undefined;
    if (flush.members.size !== finalBatch.flushCount)
        return undefined;
    const ordered = [];
    for (let index = 0; index < finalBatch.flushCount; index++) {
        const candidate = flush.members.get(index);
        if (!candidate ||
            candidate.flushCount !== finalBatch.flushCount ||
            !completionBatchComplete(candidate) ||
            (candidate !== finalBatch && candidate.sawFinalTrigger))
            return undefined;
        ordered.push(candidate);
    }
    return ordered;
}
function processCompletionBatchEntry(context, batch, entry) {
    context.counters.completionBatchEntriesObserved++;
    let invalid = entry.invalid;
    const telemetry = entry.telemetryPresent
        ? context.addTelemetry(entry.telemetry, "completion-batch")
        : undefined;
    if (!entry.telemetryPresent) {
        context.counters.completionBatchEntriesWithoutTelemetry++;
        batch.mixedLegacy = true;
    }
    else if (!telemetry) {
        // Keep scanning valid siblings, but a malformed nested envelope makes the
        // batch ineligible to trigger a synthetic wakeup.
        invalid = true;
    }
    // A malformed legacy entry cannot establish a run from its fallback ID. A
    // valid structured sibling, however, remains independently canonicalized.
    if (invalid && !telemetry)
        return true;
    let runId = telemetry?.run.id;
    if (!runId && !invalid && entry.asyncId) {
        runId = entry.asyncId;
        const run = context.ensureRun(runId);
        context.addCompletionDetailsToRun(run, {
            ...(entry.agent ? { agent: entry.agent } : {}),
            ...(entry.status ? { status: entry.status } : {}),
            ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
            asyncId: entry.asyncId,
        });
        run.sourceKinds.add("completion-batch");
    }
    else if (runId) {
        const run = context.ensureRun(runId);
        if (entry.agent)
            run.roles.add(entry.agent);
        run.sourceKinds.add("completion-batch");
    }
    if (runId)
        batch.runIds.add(runId);
    return invalid;
}
function revokeWakeup(context, registration) {
    const recordIndex = context.wakeups.indexOf(registration.record);
    if (recordIndex < 0)
        return;
    context.wakeups.splice(recordIndex, 1);
    context.counters.wakeupsObserved--;
    if (!registration.finalized)
        return;
    if (registration.record.attributed)
        context.counters.wakeupsAttributed--;
    else
        context.counters.wakeupsUnattributed--;
    if (registration.record.reason === "interrupted-by-human-input")
        context.counters.wakeupsInterruptedByHumanInput--;
    if (registration.record.reason === "missing-assistant-turn")
        context.counters.wakeupsMissingAssistantTurn--;
    if (registration.record.reason === "missing-run-id")
        context.counters.wakeupsMissingRunId--;
}
function invalidateRegisteredFlushWakeup(context, state, flush, revokeActive = false) {
    const sourceKey = flush.wakeSourceKey;
    if (!flush.sourceRegistered || !sourceKey)
        return;
    if (state.pendingSource?.key === sourceKey) {
        state.pendingSource = undefined;
        context.counters.wakeupsMissingNudge++;
    }
    const activeWake = state.activeWake?.source.key === sourceKey ? state.activeWake : undefined;
    if (activeWake) {
        if (revokeActive) {
            // Tombstone pressure forgets the source identity, so remove an active
            // record rather than retaining an attribution that can no longer be
            // validated.
            state.activeWake = undefined;
        }
        else {
            // Preserve the pre-existing ambiguity classification when the conflict wins
            // before the assistant turn arrives. Only a completed attribution is
            // revocable after the active state has already been cleared.
            finishWakeup(context, activeWake, "ambiguous-next-turn");
            state.activeWake = undefined;
        }
    }
    const registration = flush.wakeupRegistration;
    flush.wakeupRegistration = undefined;
    flush.sourceRegistered = false;
    for (const candidate of flush.members.values()) {
        if (candidate.wakeSourceKey !== sourceKey)
            continue;
        candidate.wakeupRegistration = undefined;
        candidate.sourceRegistered = false;
    }
    if (registration && (!activeWake || revokeActive))
        revokeWakeup(context, registration);
}
function invalidateRegisteredBatchWakeup(context, state, batch) {
    const sourceKey = batch.wakeSourceKey;
    if (!batch.sourceRegistered || !sourceKey)
        return;
    for (const flush of state.completionFlushes.values()) {
        if (flush.wakeSourceKey === sourceKey) {
            invalidateRegisteredFlushWakeup(context, state, flush);
            return;
        }
    }
    // A flush tombstone can only be absent after pressure already revoked its
    // source. Keep this fallback idempotent for a state that is being finalized.
    batch.wakeupRegistration = undefined;
    batch.sourceRegistered = false;
}
function invalidateCompletionFlush(context, state, flush, _structural = false, revokeActive = false) {
    if (flush.invalid)
        return;
    flush.invalid = true;
    // Flush invalidation revokes only the affected grouped wakeup. Individual
    // batch coverage remains attributable, matching the existing sibling-level
    // malformed-entry behavior and avoiding double-counted invalid batches.
    invalidateRegisteredFlushWakeup(context, state, flush, revokeActive);
}
function invalidateCompletionBatch(context, state, batch, structural = false) {
    batch.invalid = true;
    if (structural)
        batch.structurallyInvalid = true;
    invalidateRegisteredBatchWakeup(context, state, batch);
}
function finalizeCompletionBatch(context, batch) {
    if (batch.coverageFinalized)
        return;
    let missing = 0;
    for (let index = 0; index < batch.batchCount; index++) {
        if (!batch.chunks.has(index))
            missing++;
    }
    if (missing > 0 || batch.invalid) {
        context.counters.completionBatchesIncomplete++;
        context.counters.completionBatchChunksMissing += missing;
    }
    else {
        context.counters.completionBatchesComplete++;
    }
    if (batch.mixedLegacy)
        context.counters.completionBatchesMixedLegacy++;
    batch.coverageFinalized = true;
}
function evictOldestCompletionBatch(context, state) {
    let candidate;
    for (const entry of state.completionBatches.entries()) {
        if (!completionBatchComplete(entry[1])) {
            candidate = entry;
            break;
        }
    }
    candidate ??= state.completionBatches.entries().next().value;
    if (!candidate)
        return;
    finalizeCompletionBatch(context, candidate[1]);
    state.completionBatches.delete(candidate[0]);
    context.counters.completionBatchStateEvictions++;
}
/** Evicting a flush tombstone revokes its old accounting before forgetting it. */
function evictOldestCompletionFlush(context, state) {
    const oldest = state.completionFlushes.entries().next().value;
    if (!oldest)
        return;
    const [flushId, flush] = oldest;
    invalidateCompletionFlush(context, state, flush, true, true);
    // The source set is the bounded design's conservative forgotten-ID guard:
    // once a tombstone is discarded, the same flush identity cannot wake again.
    context.seenCompletionSources.add(completionFlushSourceKey(flush.flushId));
    state.completionFlushes.delete(flushId);
    context.counters.completionFlushStateEvictions++;
}
function processCompletionBatchNotification(context, state, scanResult, entryIndex, details) {
    context.counters.completionBatchChunksObserved++;
    const parsed = parseCompletionBatchDetails(details);
    if (!parsed) {
        context.counters.completionBatchChunksInvalid++;
        context.counters.malformedCompletionDetails++;
        return;
    }
    const sourceKey = completionFlushSourceKey(parsed.flushId);
    let batch = state.completionBatches.get(parsed.batchId);
    if (batch && batch.flushId !== parsed.flushId) {
        const previousFlush = state.completionFlushes.get(batch.flushId);
        batch.invalid = true;
        batch.structurallyInvalid = true;
        if (previousFlush)
            invalidateCompletionFlush(context, state, previousFlush, true);
        else
            invalidateCompletionBatch(context, state, batch, true);
        context.counters.completionBatchChunksInvalid++;
        context.counters.malformedCompletionDetails++;
        return;
    }
    let flush = state.completionFlushes.get(parsed.flushId);
    if (!flush) {
        // A live batch without its flush tombstone has already lost the membership
        // needed to validate its next chunk. Reject it rather than rebuilding state.
        if (batch || context.seenCompletionSources.has(sourceKey)) {
            if (batch)
                invalidateCompletionBatch(context, state, batch, true);
            context.counters.completionBatchChunksInvalid++;
            context.counters.malformedCompletionDetails++;
            return;
        }
        if (state.completionFlushes.size >= MAX_COMPLETION_BATCH_STATES)
            evictOldestCompletionFlush(context, state);
        flush = {
            flushId: parsed.flushId,
            flushCount: parsed.flushCount,
            members: new Map(),
            invalid: false,
            sourceRegistered: false,
        };
        state.completionFlushes.set(parsed.flushId, flush);
    }
    if (flush.invalid || flush.flushCount !== parsed.flushCount) {
        invalidateCompletionFlush(context, state, flush, true);
        context.counters.completionBatchChunksInvalid++;
        context.counters.malformedCompletionDetails++;
        return;
    }
    const memberAtPosition = flush.members.get(parsed.flushIndex);
    const memberForBatch = [...flush.members.values()].find((candidate) => candidate.batchId === parsed.batchId);
    if ((memberAtPosition && memberAtPosition.batchId !== parsed.batchId) ||
        (memberForBatch && memberForBatch !== memberAtPosition)) {
        // A flush position is immutable. This catches a different batch ID even
        // when the original batch state has already been evicted.
        invalidateCompletionFlush(context, state, flush, true);
        context.counters.completionBatchChunksInvalid++;
        context.counters.malformedCompletionDetails++;
        return;
    }
    if (!batch && memberAtPosition) {
        const digest = completionChunkDigest(parsed);
        context.counters.completionBatchChunksDuplicate++;
        if (!memberAtPosition.invalid &&
            memberAtPosition.chunkDigests.get(parsed.batchIndex) === digest) {
            // The batch state is gone, so an identical chunk can be discarded using
            // its bounded tombstone without replaying telemetry or usage.
            context.counters.completionBatchChunksDeduplicated++;
        }
        else {
            invalidateCompletionFlush(context, state, flush, true);
            context.counters.completionBatchChunksInvalid++;
            context.counters.malformedCompletionDetails++;
        }
        return;
    }
    if (!batch && context.seenCompletionSources.has(sourceKey)) {
        // A completed/forgotten flush is never allowed to register a second wakeup.
        context.counters.completionBatchChunksInvalid++;
        context.counters.malformedCompletionDetails++;
        return;
    }
    if (!batch && state.completionBatches.size >= MAX_COMPLETION_BATCH_STATES)
        evictOldestCompletionBatch(context, state);
    if (!batch) {
        batch = {
            batchId: parsed.batchId,
            batchCount: parsed.batchCount,
            flushId: parsed.flushId,
            flushIndex: parsed.flushIndex,
            flushCount: parsed.flushCount,
            chunks: new Set(),
            chunkDigests: new Map(),
            runIds: new Set(),
            sawFinalChunk: false,
            sawFinalTrigger: false,
            invalid: false,
            structurallyInvalid: false,
            mixedLegacy: false,
            sourceRegistered: false,
            coverageFinalized: false,
        };
        state.completionBatches.set(parsed.batchId, batch);
        flush.members.set(parsed.flushIndex, batch);
        context.counters.completionBatchesObserved++;
    }
    if (batch.batchCount !== parsed.batchCount ||
        batch.flushId !== parsed.flushId ||
        batch.flushIndex !== parsed.flushIndex ||
        batch.flushCount !== parsed.flushCount ||
        flush.members.get(parsed.flushIndex) !== batch) {
        batch.invalid = true;
        batch.structurallyInvalid = true;
        invalidateCompletionFlush(context, state, flush, true);
        context.counters.completionBatchChunksInvalid++;
        context.counters.malformedCompletionDetails++;
        return;
    }
    const digest = completionChunkDigest(parsed);
    if (batch.chunks.has(parsed.batchIndex)) {
        context.counters.completionBatchChunksDuplicate++;
        if (batch.chunkDigests.get(parsed.batchIndex) === digest) {
            // Identical duplicates are harmless and explicitly deduplicated. The
            // original chunk remains the sole source of run and usage evidence.
            context.counters.completionBatchChunksDeduplicated++;
        }
        else {
            // A same-index replacement is not a second snapshot: it invalidates the
            // complete overall flush so it can never fabricate a wakeup.
            batch.invalid = true;
            batch.structurallyInvalid = true;
            invalidateCompletionFlush(context, state, flush, true);
            context.counters.completionBatchChunksInvalid++;
            context.counters.malformedCompletionDetails++;
        }
        return;
    }
    if (batch.structurallyInvalid || parsed.batchIndex !== batch.chunks.size) {
        // Do not admit reversed or skipped chunks into the state machine. Their
        // bounded evidence is intentionally not used to create a wakeup.
        invalidateCompletionBatch(context, state, batch, true);
        context.counters.completionBatchChunksInvalid++;
        context.counters.malformedCompletionDetails++;
        return;
    }
    batch.chunks.add(parsed.batchIndex);
    batch.chunkDigests.set(parsed.batchIndex, digest);
    if (parsed.batchIndex === parsed.batchCount - 1)
        batch.sawFinalChunk = true;
    let chunkInvalid = parsed.invalid;
    if (parsed.triggersTurn) {
        if (parsed.batchIndex !== parsed.batchCount - 1 || batch.sawFinalTrigger) {
            chunkInvalid = true;
            batch.structurallyInvalid = true;
        }
        else {
            batch.sawFinalTrigger = true;
        }
    }
    for (const completion of parsed.completions)
        chunkInvalid = processCompletionBatchEntry(context, batch, completion) || chunkInvalid;
    if (chunkInvalid) {
        invalidateCompletionBatch(context, state, batch);
        context.counters.completionBatchChunksInvalid++;
        context.counters.malformedCompletionDetails++;
    }
    else {
        context.counters.completionBatchChunksValid++;
    }
    const flushMembers = batch.sawFinalTrigger ? completeCompletionFlush(state, batch) : undefined;
    if (!batch.invalid && flushMembers && !flush.sourceRegistered) {
        if (!context.seenCompletionSources.has(sourceKey)) {
            context.seenCompletionSources.add(sourceKey);
            const wakeSourceKey = tupleKey(sourceKey, scanResult.filePath, entryIndex);
            flush.wakeSourceKey = wakeSourceKey;
            flush.sourceRegistered = true;
            registerSource(context, state, {
                kind: "completion",
                key: wakeSourceKey,
                runIds: [...new Set(flushMembers.flatMap((member) => [...member.runIds]))],
                nudgeKind: "completion",
            });
            for (const member of flushMembers) {
                member.wakeSourceKey = wakeSourceKey;
                member.sourceRegistered = true;
            }
        }
    }
}
function processCompletionNotification(context, state, scanResult, entryIndex, message) {
    context.counters.completionNotifications++;
    const details = isObject(message.details) ? message.details : undefined;
    if (details && isCompletionBatchCandidate(details)) {
        processCompletionBatchNotification(context, state, scanResult, entryIndex, details);
        return;
    }
    let telemetry;
    if (details && hasOwn(details, "telemetry"))
        telemetry = context.addTelemetry(details.telemetry, "completion");
    if (!details) {
        context.counters.completionDetailsMissing++;
        if (message.legacyNotification === "completion" || isLegacyCompletionText(message.content)) {
            context.counters.legacyProseNotifications++;
            registerSource(context, state, {
                kind: "completion",
                key: tupleKey("completion", scanResult.filePath, entryIndex),
                runIds: [],
                nudgeKind: "completion",
            });
        }
        else
            context.counters.malformedCompletionDetails++;
        return;
    }
    const runId = telemetry?.run.id ?? extractRunIdFromDetails(details, true);
    const sourceExecution = telemetry?.run.execution ??
        (detailsIndicateAsync(details)
            ? "async"
            : runId
                ? (context.getRun(runId)?.execution ?? "unknown")
                : "unknown");
    if (runId) {
        const run = context.ensureRun(runId);
        if (!telemetry && !run.telemetry) {
            if (run.execution === "unknown")
                run.execution = sourceExecution === "unknown" ? "async" : sourceExecution;
            context.addCompletionDetailsToRun(run, details);
        }
        else {
            run.sourceKinds.add("completion");
        }
    }
    const statusValid = details.status === "completed" || details.status === "failed" || details.status === "paused";
    const agentValid = details.agent === undefined || safeMetadataString(details.agent) !== undefined;
    if (!statusValid || !agentValid)
        context.counters.malformedCompletionDetails++;
    const sourceKey = runId
        ? tupleKey("completion", runId)
        : tupleKey("completion", scanResult.filePath, entryIndex);
    const duplicate = context.seenCompletionSources.has(sourceKey);
    context.seenCompletionSources.add(sourceKey);
    const completionEvidenceValid = telemetry !== undefined || (statusValid && details.agent !== undefined && agentValid);
    if (!duplicate && completionEvidenceValid && sourceExecution !== "foreground") {
        registerSource(context, state, {
            kind: "completion",
            key: sourceKey,
            runIds: runId ? [runId] : [],
            nudgeKind: "completion",
        });
    }
}
function processControlNotification(context, state, scanResult, entryIndex, message) {
    context.counters.controlNotifications++;
    const details = isObject(message.details) ? message.details : undefined;
    const telemetry = details && hasOwn(details, "telemetry")
        ? context.addTelemetry(details.telemetry, "control")
        : undefined;
    const parsed = details ? parseSubagentControlEvent(details) : undefined;
    if (!parsed) {
        context.counters.controlDetailsMissing++;
        context.counters.malformedControlDetails++;
        if (message.legacyNotification === "control" || isLegacyControlText(message.content)) {
            context.counters.legacyProseNotifications++;
            registerSource(context, state, {
                kind: "control",
                key: tupleKey("control", scanResult.filePath, entryIndex),
                runIds: [],
                nudgeKind: "control",
            });
        }
        return;
    }
    const run = context.ensureRun(parsed.runId);
    const effectiveSource = parsed.source === "unknown" ? (telemetry?.run.execution ?? run.execution) : parsed.source;
    run.sourceKinds.add("control");
    if (!run.telemetry && parsed.source !== "unknown")
        run.execution = parsed.source;
    const sourceKey = controlSourceKey(parsed.event, parsed.runId);
    const duplicate = context.seenControlSources.has(sourceKey);
    context.seenControlSources.add(sourceKey);
    if (effectiveSource !== "foreground" && !duplicate) {
        registerSource(context, state, {
            kind: "control",
            key: sourceKey,
            runIds: [parsed.runId],
            nudgeKind: "control",
        });
    }
}
function handleNudge(context, state, nudgeKind) {
    if (state.activeWake) {
        finishWakeup(context, state.activeWake, "ambiguous-next-turn");
        state.activeWake = undefined;
    }
    if (!state.pendingSource) {
        context.counters.unmatchedNudges++;
        return;
    }
    const source = state.pendingSource;
    state.pendingSource = undefined;
    context.counters.wakeupsObserved++;
    const registration = {
        record: makeWakeupRecord(source, false, undefined, null, emptyManagementCalls()),
        finalized: false,
    };
    context.wakeups.push(registration.record);
    for (const flush of state.completionFlushes.values()) {
        if (flush.wakeSourceKey === source.key)
            flush.wakeupRegistration = registration;
    }
    for (const batch of state.completionBatches.values()) {
        if (batch.wakeSourceKey === source.key)
            batch.wakeupRegistration = registration;
    }
    state.activeWake = { source: { ...source }, registration };
    if (source.nudgeKind !== nudgeKind) {
        finishWakeup(context, state.activeWake, "mismatched-nudge");
        state.activeWake = undefined;
    }
}
function processOrdinaryUserMessage(context, state) {
    if (state.activeWake) {
        finishWakeup(context, state.activeWake, "interrupted-by-human-input");
        state.activeWake = undefined;
    }
    if (state.pendingSource)
        abandonPendingSource(context, state);
}
function processAssistantMessage(context, state, message) {
    if (state.activeWake) {
        const usage = assistantUsage(message);
        const runIds = new Set(state.activeWake.source.runIds);
        const managementCalls = managementCallsForWakeup(message, runIds);
        if (runIds.size === 0)
            finishWakeup(context, state.activeWake, "missing-run-id", usage, managementCalls);
        else
            finishWakeup(context, state.activeWake, undefined, usage, managementCalls, true);
        state.activeWake = undefined;
    }
    if (state.pendingSource)
        abandonPendingSource(context, state);
}
function processWakeupEntry(context, state, scanResult, entryIndex, pairedSubagentCallIds) {
    const entry = scanResult.entries[entryIndex];
    if (!isObject(entry) || entry.type !== "message" || !isObject(entry.message))
        return;
    const message = entry.message;
    const customType = typeof message.customType === "string" ? message.customType : undefined;
    const isPairedSubagentResult = message.role === "toolResult" &&
        typeof message.toolCallId === "string" &&
        pairedSubagentCallIds.has(message.toolCallId);
    if (isObject(message.details) &&
        (isPairedSubagentResult ||
            customType === SUBAGENT_NOTIFY_TYPE ||
            customType === SUBAGENT_CONTROL_TYPE))
        processStructuredControlEvents(context, state, message.details);
    if (customType === SUBAGENT_NOTIFY_TYPE)
        processCompletionNotification(context, state, scanResult, entryIndex, message);
    else if (customType === SUBAGENT_CONTROL_TYPE)
        processControlNotification(context, state, scanResult, entryIndex, message);
    const text = messageText(message.content);
    const nudgeKind = syntheticNudgeKind(message.role, text) ??
        (message.syntheticNudge === "completion" || message.syntheticNudge === "control"
            ? message.syntheticNudge
            : undefined);
    if (nudgeKind) {
        handleNudge(context, state, nudgeKind);
        return;
    }
    if (message.role === "user")
        processOrdinaryUserMessage(context, state);
    else if (message.role === "assistant")
        processAssistantMessage(context, state, message);
}
function messageText(value) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value))
        return undefined;
    const parts = [];
    for (const item of value) {
        if (!isObject(item) || item.type !== "text" || typeof item.text !== "string")
            return undefined;
        parts.push(item.text);
    }
    return parts.join("");
}
export function analyzeWakeupsForScan(scanResult, context) {
    const state = {
        completionBatches: new Map(),
        completionFlushes: new Map(),
    };
    const pairedSubagentCallIds = new Set(scanResult.toolPairs
        .filter((pair) => pair.toolName === "subagent")
        .map((pair) => pair.toolCallId));
    for (let entryIndex = 0; entryIndex < scanResult.entries.length; entryIndex++) {
        processWakeupEntry(context, state, scanResult, entryIndex, pairedSubagentCallIds);
    }
    if (state.activeWake) {
        finishWakeup(context, state.activeWake, "missing-assistant-turn");
        state.activeWake = undefined;
    }
    if (state.pendingSource)
        abandonPendingSource(context, state);
    for (const batch of state.completionBatches.values())
        finalizeCompletionBatch(context, batch);
}
export { BACKGROUND_COMPLETION_NUDGE, CONTROL_NOTICE_NUDGE };
