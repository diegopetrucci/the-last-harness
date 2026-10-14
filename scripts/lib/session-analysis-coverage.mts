/** Shared, read-only session scan coverage calculation. */

/** Privacy-safe reasons a correlation evidence join was not trusted. */
export interface CorrelationEvidenceFailureCounts {
  /** Scan-time bounded evidence capture exceeded its ID/occurrence limits. */
  scanCaptureOverflow: number;
  /** The bounded rescan capture exceeded its ID/occurrence limits. */
  rescanCaptureOverflow: number;
  /** The bounded evidence digest changed between scan and rescan. */
  digestMismatch: number;
  /** The bounded evidence occurrence count changed between scan and rescan. */
  generationMismatch: number;
}

/** Failure keys emitted by correlation rescans; scan overflow is pre-counted. */
export type CorrelationEvidenceRescanFailureReason =
  | "rescanCaptureOverflow"
  | "digestMismatch"
  | "generationMismatch";

/** Coverage summary aggregated across multiple scan results. */
export interface ScanCoverage {
  /** Total JSONL files discovered (run-history.jsonl is excluded during enumeration). */
  filesDiscovered: number;
  /** Files successfully scanned (toolPairs + malformed lines accumulated). */
  filesScanned: number;
  /** Files that threw an error during scanning (not counted in filesScanned). */
  failedScans: number;
  /** Directories that could not be read during enumeration. */
  unreadableDirectories: number;
  totalMalformedLines: number;
  totalUnmatchedToolCalls: number;
  totalUnmatchedToolResults: number;
  filesWithSizeChange: number;
  /** Sum of duplicateToolCallIdCount across all scanned files. */
  totalDuplicateToolCallIds: number;
  /** Sum of invalidTimestampPairCount across all scanned files. */
  totalInvalidTimestampPairs: number;
  /** Number of bounded message values that could not be projected. */
  totalProjectionGaps: number;
  /** Number of scan/rescan joins rejected because evidence was not trustworthy. */
  totalCorrelationEvidenceFailures: number;
  /** Counts of bounded correlation evidence failures by privacy-safe reason. */
  correlationEvidenceFailures: CorrelationEvidenceFailureCounts;
}

/** Extra counters gathered outside the per-file scan that belong in coverage. */
export interface ExtraCoverageData {
  filesDiscovered?: number;
  failedScans?: number;
  unreadableDirectories?: number;
}

/** The bounded fields needed from each streaming session scan. */
export interface ScanCoverageInput {
  malformedLines: number;
  unmatchedToolCallCount: number;
  unmatchedToolResultCount: number;
  fileSizeChangedDuringScan: boolean;
  duplicateToolCallIdCount: number;
  invalidTimestampPairCount: number;
  /** Number of bounded message values that could not be projected. */
  projectionGapCount?: number;
  /** True when the scan-time bounded correlation evidence capture overflowed. */
  correlationEvidenceCaptureOverflow?: boolean;
}

/**
 * Aggregate coverage statistics across multiple scan results.
 *
 * Pass `extra` to include counters gathered outside the per-file scan (for
 * example, files discovered, failed scans, or unreadable directories).
 */
export function aggregateCoverage(
  results: readonly ScanCoverageInput[],
  extra: ExtraCoverageData = {},
): ScanCoverage {
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
    if (result.fileSizeChangedDuringScan) filesWithSizeChange++;
    totalDuplicateToolCallIds += result.duplicateToolCallIdCount;
    totalInvalidTimestampPairs += result.invalidTimestampPairCount;
    totalProjectionGaps += result.projectionGapCount ?? 0;
    if (result.correlationEvidenceCaptureOverflow) scanCaptureOverflow++;
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
export function recordCorrelationEvidenceFailures(
  coverage: ScanCoverage,
  reasons: readonly CorrelationEvidenceRescanFailureReason[],
): void {
  if (reasons.length === 0) return;
  coverage.totalCorrelationEvidenceFailures++;
  for (const reason of reasons) coverage.correlationEvidenceFailures[reason]++;
}
