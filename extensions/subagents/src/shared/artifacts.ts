import * as fs from "node:fs";
import * as path from "node:path";
import { isEffectivelyEmpty } from "../runs/shared/acceptance.ts";
import { TEMP_ARTIFACTS_DIR, type ArtifactPaths, type SingleResult } from "./types.ts";
import { getAgentDir } from "./utils.ts";
const CLEANUP_MARKER_FILE = ".last-cleanup";
const PROJECT_ARTIFACT_ROOT = ".pi-subagents";

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
