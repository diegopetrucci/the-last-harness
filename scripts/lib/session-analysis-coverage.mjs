/** Shared, read-only session scan coverage calculation. */
/**
 * Aggregate coverage statistics across multiple scan results.
 *
 * Pass `extra` to include counters gathered outside the per-file scan (for
 * example, files discovered, failed scans, or unreadable directories).
 */
export function aggregateCoverage(results, extra = {}) {
    let totalMalformedLines = 0;
    let totalUnmatchedToolCalls = 0;
    let totalUnmatchedToolResults = 0;
    let filesWithSizeChange = 0;
    let totalDuplicateToolCallIds = 0;
    let totalInvalidTimestampPairs = 0;
    let totalProjectionGaps = 0;
    let scanCaptureOverflow = 0;
    for (const result of results) {
        totalMalformedLines += result.malformedLines;
        totalUnmatchedToolCalls += result.unmatchedToolCallCount;
        totalUnmatchedToolResults += result.unmatchedToolResultCount;
        if (result.fileSizeChangedDuringScan)
            filesWithSizeChange++;
        totalDuplicateToolCallIds += result.duplicateToolCallIdCount;
        totalInvalidTimestampPairs += result.invalidTimestampPairCount;
        totalProjectionGaps += result.projectionGapCount ?? 0;
        if (result.correlationEvidenceCaptureOverflow)
            scanCaptureOverflow++;
    }
    return {
        filesDiscovered: extra.filesDiscovered ?? results.length,
        filesScanned: results.length,
        failedScans: extra.failedScans ?? 0,
        unreadableDirectories: extra.unreadableDirectories ?? 0,
        totalMalformedLines,
        totalUnmatchedToolCalls,
        totalUnmatchedToolResults,
        filesWithSizeChange,
        totalDuplicateToolCallIds,
        totalInvalidTimestampPairs,
        totalProjectionGaps,
        totalCorrelationEvidenceFailures: scanCaptureOverflow,
        correlationEvidenceFailures: {
            scanCaptureOverflow,
            rescanCaptureOverflow: 0,
            digestMismatch: 0,
            generationMismatch: 0,
        },
    };
}
/**
 * Add static, privacy-safe correlation evidence failure reasons to coverage.
 * Each extraction attempt contributes at most one total failure, while all
 * applicable reason counters are retained for diagnosis.
 */
export function recordCorrelationEvidenceFailures(coverage, reasons) {
    if (reasons.length === 0)
        return;
    coverage.totalCorrelationEvidenceFailures++;
    for (const reason of reasons)
        coverage.correlationEvidenceFailures[reason]++;
}
