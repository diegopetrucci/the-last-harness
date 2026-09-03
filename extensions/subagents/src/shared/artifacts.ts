import * as fs from "node:fs";
import * as path from "node:path";
import { isEffectivelyEmpty } from "../runs/shared/acceptance.ts";
import {
  DEFAULT_ARTIFACT_CONFIG,
  type ArtifactMode,
  type ArtifactPaths,
  type ResolvedArtifactConfig,
  TEMP_ARTIFACTS_DIR,
  type SingleResult,
} from "./types.ts";
import { getAgentDir } from "./utils.ts";
const CLEANUP_MARKER_FILE = ".last-cleanup";
const PROJECT_ARTIFACT_ROOT = ".pi-subagents";

const LEGACY_DETAILED_ARTIFACT_CONFIG: ResolvedArtifactConfig = {
  mode: "debug",
  enabled: true,
  includeInput: true,
  includeOutput: true,
  includeJsonl: false,
  includeTranscript: true,
  includeChildEventProjections: true,
  includeMetadata: true,
  cleanupDays: DEFAULT_ARTIFACT_CONFIG.cleanupDays,
};

let invalidArtifactModeWarningShown = false;

export interface ArtifactConfigResolutionOptions {
  /** Caller-owned overall artifact switch; this cannot select a detail mode. */
  enabled?: boolean;
  /** Use the pre-profile detailed defaults for old persisted run configs. */
  legacy?: boolean;
}

function isArtifactConfigRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warnInvalidArtifactMode(): void {
  if (invalidArtifactModeWarningShown) return;
  invalidArtifactModeWarningShown = true;
  console.warn("[pi-subagents] Invalid artifacts.mode; using compact artifact mode.");
}

function resolveArtifactMode(value: unknown, legacy: boolean): ArtifactMode {
  if (value === undefined) return legacy ? "debug" : "compact";
  if (value === "compact" || value === "debug") return value;
  warnInvalidArtifactMode();
  return "compact";
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function optionalCleanupDays(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Resolve the human artifact profile at the trusted parent/detached-run
 * boundary. External settings omit the mode for compact-by-default behavior;
 * persisted pre-profile configs opt into the legacy detailed defaults instead.
 * Explicit profiles own all diagnostic file flags, including raw child JSONL.
 */
export function resolveArtifactConfig(
  source: unknown,
  options: ArtifactConfigResolutionOptions = {},
): ResolvedArtifactConfig {
  const sourceRecord = isArtifactConfigRecord(source) ? source : undefined;
  const legacy = options.legacy === true;
  const sourceMode = sourceRecord
    ? Object.hasOwn(sourceRecord, "mode")
      ? sourceRecord.mode
      : undefined
    : source;
  const hasExplicitMode = sourceMode !== undefined;
  const mode = resolveArtifactMode(sourceMode, legacy && !hasExplicitMode);
  const profile = mode === "debug" ? LEGACY_DETAILED_ARTIFACT_CONFIG : DEFAULT_ARTIFACT_CONFIG;
  // External settings intentionally expose only `mode`; historical detached
  // configs may still carry the pre-profile enabled/diagnostic fields.
  const enabled =
    options.enabled ??
    (legacy ? optionalBoolean(sourceRecord?.enabled, profile.enabled) : profile.enabled);

  if (!hasExplicitMode && legacy) {
    return {
      mode,
      enabled,
      includeInput: optionalBoolean(sourceRecord?.includeInput, profile.includeInput),
      includeOutput: optionalBoolean(sourceRecord?.includeOutput, profile.includeOutput),
      includeJsonl: optionalBoolean(sourceRecord?.includeJsonl, profile.includeJsonl),
      includeTranscript: optionalBoolean(
        sourceRecord?.includeTranscript,
        profile.includeTranscript ?? false,
      ),
      includeChildEventProjections: optionalBoolean(
        sourceRecord?.includeChildEventProjections,
        true,
      ),
      includeMetadata: optionalBoolean(sourceRecord?.includeMetadata, profile.includeMetadata),
      cleanupDays: optionalCleanupDays(sourceRecord?.cleanupDays, profile.cleanupDays),
    };
  }

  return {
    mode,
    enabled,
    includeInput: profile.includeInput,
    includeOutput: profile.includeOutput,
    includeJsonl: false,
    includeTranscript: profile.includeTranscript ?? false,
    // Detached readers must not change an in-flight run's behavior merely
    // because it predates this internal flag. New parent-resolved configs use
    // the profile value; persisted legacy envelopes default to detailed.
    includeChildEventProjections: legacy
      ? optionalBoolean(sourceRecord?.includeChildEventProjections, true)
      : profile.includeChildEventProjections,
    includeMetadata: profile.includeMetadata,
    cleanupDays: profile.cleanupDays,
  };
}

export function getProjectSubagentsDir(cwd: string): string {
  return path.join(cwd, PROJECT_ARTIFACT_ROOT);
}

export function getProjectArtifactsDir(cwd: string): string {
  return path.join(getProjectSubagentsDir(cwd), "artifacts");
}

export function getArtifactsDir(sessionFile: string | null, projectCwd?: string): string {
  if (projectCwd) return getProjectArtifactsDir(projectCwd);
  if (sessionFile) {
    const sessionDir = path.dirname(sessionFile);
    return path.join(sessionDir, "subagent-artifacts");
  }
  return TEMP_ARTIFACTS_DIR;
}

export function getArtifactPaths(
  artifactsDir: string,
  runId: string,
  agent: string,
  index?: number,
): ArtifactPaths {
  const suffix = index !== undefined ? `_${index}` : "";
  const safeAgent = agent.replace(/[^\w.-]/g, "_");
  const base = `${runId}_${safeAgent}${suffix}`;
  return {
    inputPath: path.join(artifactsDir, `${base}_input.md`),
    outputPath: path.join(artifactsDir, `${base}_output.md`),
    jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
    transcriptPath: path.join(artifactsDir, `${base}_transcript.jsonl`),
    metadataPath: path.join(artifactsDir, `${base}_meta.json`),
  };
}

export function ensureArtifactsDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeArtifact(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * Write a supervisor-facing artifact file, applying a non-destruction floor as
 * part of the write: if computedContent is effectively empty (whitespace or
 * Markdown horizontal rules only) but rawOutput is non-empty, rawOutput is
 * preserved on disk instead of the degenerate computed value.
 *
 * This is the single enforcement point for the non-destruction invariant; both
 * the async background writer and the foreground writer route through here so
 * the floor cannot be bypassed without also removing the write.
 *
 * @param isArchive When true the file is a byte-exact archive of a user-requested
 *   deliverable; the floor is skipped and computedContent is written as-is.
 *   An empty deliverable is empty by the user's own request.
 */
export function writeArtifactWithFloor(
  filePath: string,
  computedContent: string,
  rawOutput: string,
  isArchive: boolean,
): void {
  const content =
    !isArchive && rawOutput.trim() && isEffectivelyEmpty(computedContent)
      ? rawOutput
      : computedContent;
  fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * Metadata emitted by the foreground writer after a synchronous run.
 *
 * The background runner writes a separate process metadata shape directly in
 * runs/background/subagent-runner.ts; these writers intentionally remain distinct.
 */
interface ForegroundSubagentArtifactMetadata extends Pick<
  SingleResult,
  | "agent"
  | "task"
  | "projectAgent"
  | "exitCode"
  | "exitSignal"
  | "timedOut"
  | "terminationReason"
  | "contextUsage"
  | "contextPressure"
  | "contextPressureCrossedThresholds"
  | "sessionFile"
  | "usage"
  | "model"
  | "thinking"
  | "modelIdentity"
  | "modelResolution"
  | "attemptedModels"
  | "modelAttempts"
  | "modelFallbackNotice"
  | "error"
  | "stderr"
  | "stderrTruncated"
  | "protocolOutputLimit"
  | "transcriptPath"
  | "transcriptError"
  | "skills"
  | "skillsWarning"
  | "activeRuntimeMs"
> {
  runId: string;
  durationMs?: number;
  timeoutMs?: number;
  deadlineAt?: number;
  toolCount?: number;
  timestamp: number;
}

export function writeMetadata(
  filePath: string,
  metadata: ForegroundSubagentArtifactMetadata,
): void {
  fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}

export function appendJsonl(filePath: string, line: string): void {
  fs.appendFileSync(filePath, `${line}\n`);
}

function isFullyExpiredTree(dir: string, cutoff: number): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return false;
  }

  if (!stat.isDirectory()) return stat.mtimeMs < cutoff;
  if (stat.mtimeMs >= cutoff) return false;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!isFullyExpiredTree(path.join(dir, entry), cutoff)) return false;
  }

  return true;
}

export function cleanupOldArtifacts(dir: string, maxAgeDays: number): void {
  if (!fs.existsSync(dir)) return;

  const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
  const now = Date.now();

  if (fs.existsSync(markerPath)) {
    const stat = fs.statSync(markerPath);
    if (now - stat.mtimeMs < 24 * 60 * 60 * 1000) return;
  }

  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const cutoff = now - maxAgeMs;

  for (const file of fs.readdirSync(dir)) {
    if (file === CLEANUP_MARKER_FILE) continue;
    const filePath = path.join(dir, file);
    try {
      if (!isFullyExpiredTree(filePath, cutoff)) continue;
      const stat = fs.lstatSync(filePath);
      if (stat.isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: false });
      } else {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Artifact cleanup is best-effort housekeeping. Skip files that disappear
      // or become unreadable while scanning so one bad entry does not block the rest.
    }
  }

  fs.writeFileSync(markerPath, String(now));
}

export function cleanupAllArtifactDirs(maxAgeDays: number): void {
  cleanupOldArtifacts(TEMP_ARTIFACTS_DIR, maxAgeDays);

  const sessionsBase = path.join(getAgentDir(), "sessions");
  if (!fs.existsSync(sessionsBase)) return;

  let dirs: string[];
  try {
    dirs = fs.readdirSync(sessionsBase);
  } catch {
    // Session artifact cleanup is best-effort. If the sessions root cannot be read,
    // skip cleanup instead of failing extension startup.
    return;
  }

  for (const dir of dirs) {
    const artifactsDir = path.join(sessionsBase, dir, "subagent-artifacts");
    try {
      cleanupOldArtifacts(artifactsDir, maxAgeDays);
    } catch {
      // Session cleanup is best-effort. Keep going so one unreadable session dir
      // does not block cleanup for the rest.
    }
  }
}
