#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildPtyCommand,
  runProcess,
  type CleanupStop,
  type OutputStream,
  type ProcessResult,
} from "./lib/check-installer-performance-process.mjs";
import {
  assertOwnedWorkspacePath,
  buildChildEnvironment,
  createBenchmarkWorkspace,
  removeOwnedWorkspace,
  writeCredentialFreeTrustMetadata,
  type BenchmarkWorkspace,
  BENCHMARK_ROOT_PREFIX,
  REPOSITORY,
} from "./lib/check-installer-performance-workspace.mjs";
import {
  createReadinessObserver,
  hasFooterMarker,
  hasHeaderMarker,
  observeReadinessChunk,
  stripTerminalNoise,
  type ReadinessObservationState,
} from "./lib/tlh-startup-readiness.mjs";

export const hasTlhHeader = hasHeaderMarker;
export const hasTlhFooter = hasFooterMarker;

const DEFAULT_MODE = "remote";
const DEFAULT_REF = "main";
const DEFAULT_RUNS = 3;
const DEFAULT_SCENARIOS = "all";
const MAX_RUNS = 50;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const LAUNCH_TIMEOUT_MS = 90 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;

export type BenchmarkMode = "remote" | "checkout";
export type ScenarioName =
  | "cold-cache-fresh"
  | "warm-cache-fresh"
  | "unchanged-reinstall"
  | "changed-pin-upgrade";
export type PhaseName =
  | "bootstrap"
  | "runtime"
  | "package-reconciliation"
  | "defaults"
  | "managed-tools"
  | "wrapper";

type JsonRecord = Record<string, unknown>;

export interface BenchmarkOptions {
  mode: BenchmarkMode;
  ref: string;
  upgradeFrom?: string;
  runs: number;
  scenarios: "all" | "cold";
  json: boolean;
  help: boolean;
}

export interface PhaseObservationState {
  pendingByStream: Record<OutputStream, string>;
  boundaries: Partial<Record<string, number>>;
}

export interface PhaseMeasurement {
  durationMs: number | null;
  startMs: number | null;
  endMs: number | null;
  quality: "progress-derived" | "unavailable";
  reason?: string;
}

interface PhaseMeasurementMap {
  [phase: string]: PhaseMeasurement;
}

export type ReconciliationEvent =
  | { type: "pi-reconciliation"; phase: "start" | "failed" }
  | { type: "pi-reconciliation"; phase: "complete"; headChanged: boolean }
  | {
      type: "tlh-repair";
      phase: "start" | "complete" | "failed" | "skipped";
      reason: "invalid-marker-or-dependencies" | "pi-repaired-dependencies";
    }
  | {
      type: "managed-checkout-summary";
      tlhGitFetches: number;
      tlhPackageManagerInstalls: number;
    };

export type ReconciliationAvailability = "available" | "no-summary" | "no-trace";

export interface ReconciliationObservation {
  /** True only when a managed-checkout-summary supports the local-work counters. */
  available: boolean;
  availability: ReconciliationAvailability;
  events: ReconciliationEvent[];
  piReconciliations: number;
  piFailures: number;
  tlhRepairs: number;
  tlhRepairSkips: number;
  tlhGitFetches: number | null;
  tlhPackageManagerInstalls: number | null;
}

interface InstallerMeasurement {
  wallMs: number;
  exit: { code: number | null; signal: string | null; timedOut: boolean };
  phases: PhaseMeasurementMap;
  reconciliation: ReconciliationObservation;
  success: boolean;
  diagnostics: string[];
}

interface LaunchMeasurement {
  wallMs: number | null;
  firstOutputMs: number | null;
  headerMs: number | null;
  footerMs: number | null;
  ready: boolean;
  exit: { code: number | null; signal: string | null; timedOut: boolean };
  diagnostics: string[];
}

interface SetupMeasurement {
  kind: "none" | "warm-cache-seed" | "fully-launched-seed";
  excludedFromMeasurements: true;
  installerWallMs: number | null;
  launchWallMs: number | null;
  ready: boolean | null;
  diagnostics: string[];
}

interface SampleResult {
  scenario: ScenarioName;
  run: number;
  cacheCondition: string;
  selectedPackageRef: string;
  setup: SetupMeasurement;
  installer: InstallerMeasurement | null;
  launch: LaunchMeasurement | null;
  readinessOutcome: "ready" | "failed" | "not-run";
  failureDiagnostics: string[];
  observedInstalledRevision: string | null;
  piVersion: string | null;
}

interface PinChange {
  changed: boolean;
  packages: Array<{ name: string; from: string; to: string }>;
}

interface RefInfo {
  requested: string;
  resolved: string | null;
}

interface BenchmarkResult extends JsonRecord {
  schemaVersion: 1;
  benchmark: "installer-performance";
  generatedAt: string;
  platform: { os: string; arch: string };
  toolVersions: { node: string; npm: string | null; pi: string | null };
  mode: BenchmarkMode;
  selectedRef: RefInfo;
  upgradeFromRef: RefInfo | null;
  supportCodeRevision: string | null;
  supportCodeDirty: boolean | null;
  pinChange: PinChange | null;
  scenarios: string;
  runs: number;
  cacheConditions: JsonRecord;
  measurementScope: JsonRecord;
  samples: SampleResult[];
  summary: JsonRecord;
  failureDiagnostics: string[];
}

interface CleanupController {
  install(): void;
  uninstall(): void;
  registerStop(stop: CleanupStop): () => void;
  registerWorkspace(root: string): () => void;
  cleanup(): Promise<void>;
}

interface NpmPinSet {
  packages: Map<string, string>;
}

interface WarmCacheSeed {
  workspace: BenchmarkWorkspace;
  setup: SetupMeasurement;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usage(): string {
  return `Usage: node scripts/check-installer-performance.mjs [options]

Opt-in contributor benchmark for isolated The Last Harness installer work. This
command performs real installs and launches in temporary directories; it is not
part of ordinary validation and has no timing pass/fail budget.

Options:
  --mode remote|checkout  Download/run the selected ref installer, or use this
                          checkout's install.sh (default: ${DEFAULT_MODE}); checkout
                          mode supports --scenarios cold only
  --ref REF               Selected package/support ref (default: ${DEFAULT_REF})
  --upgrade-from REF      Seed ref for the changed-pin upgrade scenario
  --runs N                Samples per scenario (default: ${DEFAULT_RUNS}, max: ${MAX_RUNS})
  --scenarios all|cold    Run all scenarios, or only cold-cache fresh (default: ${DEFAULT_SCENARIOS})
  --json                  Emit one structured JSON result instead of text
  -h, --help              Show this help without creating a workspace or downloading anything

The all selection measures cold-cache fresh, warm-cache fresh, unchanged
reinstall, and changed-pin upgrade in remote mode. --upgrade-from is required
for all; checkout mode supports cold-cache fresh only.
All seed/setup and outer installer-source downloads are reported separately and
excluded from measured installer and first-usable-launch timings.
`;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  if (flag === "--runs" && parsed > MAX_RUNS) {
    throw new Error(`${flag} must not exceed ${MAX_RUNS}`);
  }
  return parsed;
}

function validateRef(ref: string, flag: string): void {
  if (ref.length === 0 || ref.length > 256) throw new Error(`${flag} must be a valid ref`);
  for (const character of ref) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) {
      throw new Error(`${flag} must be a valid Git ref`);
    }
  }
  if (
    ref.startsWith("-") ||
    ref.endsWith(".") ||
    ref.endsWith("/") ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref.includes("\\")
  ) {
    throw new Error(`${flag} must be a valid Git ref`);
  }
  if (!/^[A-Za-z0-9._/@%+=~-]+$/u.test(ref)) {
    throw new Error(`${flag} contains unsupported ref characters`);
  }
}

function parseArgs(argv: readonly string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    mode: DEFAULT_MODE,
    ref: DEFAULT_REF,
    upgradeFrom: undefined,
    runs: DEFAULT_RUNS,
    scenarios: DEFAULT_SCENARIOS,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    const equalsValue = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : undefined;
    if (
      flag === "--mode" ||
      flag === "--ref" ||
      flag === "--upgrade-from" ||
      flag === "--runs" ||
      flag === "--scenarios"
    ) {
      const value = equalsValue ?? requireValue(argv, ++index, flag);
      if (!value) throw new Error(`${flag} requires a value`);
      if (flag === "--mode") {
        if (value !== "remote" && value !== "checkout") {
          throw new Error("--mode must be remote or checkout");
        }
        options.mode = value;
      } else if (flag === "--ref") {
        validateRef(value, "--ref");
        options.ref = value;
      } else if (flag === "--upgrade-from") {
        validateRef(value, "--upgrade-from");
        options.upgradeFrom = value;
      } else if (flag === "--runs") {
        options.runs = parsePositiveInteger(value, "--runs");
      } else {
        if (value !== "all" && value !== "cold") {
          throw new Error("--scenarios must be all or cold");
        }
        options.scenarios = value;
      }
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.help) return options;
  if (options.mode === "checkout" && options.scenarios === "all") {
    throw new Error("--mode checkout only supports --scenarios cold");
  }
  if (options.scenarios === "all" && !options.upgradeFrom) {
    throw new Error("--upgrade-from is required when --scenarios is all");
  }
  if (options.scenarios === "cold" && options.upgradeFrom) {
    throw new Error("--upgrade-from is only valid when --scenarios is all");
  }
  if (options.upgradeFrom && options.upgradeFrom === options.ref) {
    throw new Error("--upgrade-from must differ from --ref");
  }
  return options;
}
function selectedScenarios(selection: BenchmarkOptions["scenarios"]): ScenarioName[] {
  if (selection === "cold") return ["cold-cache-fresh"];
  return ["cold-cache-fresh", "warm-cache-fresh", "unchanged-reinstall", "changed-pin-upgrade"];
}
function scenarioCacheCondition(scenario: ScenarioName): string {
  switch (scenario) {
    case "cold-cache-fresh":
      return "new npm cache for each measured sample";
    case "warm-cache-fresh":
      return "npm cache copied from an explicit, fully launched seed install";
    case "unchanged-reinstall":
      return "existing fully launched profile and its install cache";
    case "changed-pin-upgrade":
      return "existing fully launched old-ref profile and its install cache";
  }
}

function excerptOutput(text: string): string {
  const lines = text
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length === 0 ? "(no output captured)" : lines.slice(-12).join("\n");
}

const RECONCILIATION_EVENT_PREFIX = "TLH_INSTALL_RECONCILIATION_EVENT ";
const RECONCILIATION_EVENT_TYPES = new Set([
  "pi-reconciliation",
  "tlh-repair",
  "managed-checkout-summary",
]);
const RECONCILIATION_PHASES = new Set(["start", "complete", "failed", "skipped"]);

function parseReconciliationEvent(value: unknown): ReconciliationEvent | undefined {
  if (!isJsonRecord(value) || typeof value.type !== "string") return undefined;
  if (!RECONCILIATION_EVENT_TYPES.has(value.type)) return undefined;
  if (value.type === "managed-checkout-summary") {
    if (
      typeof value.tlhGitFetches !== "number" ||
      !Number.isSafeInteger(value.tlhGitFetches) ||
      value.tlhGitFetches < 0 ||
      typeof value.tlhPackageManagerInstalls !== "number" ||
      !Number.isSafeInteger(value.tlhPackageManagerInstalls) ||
      value.tlhPackageManagerInstalls < 0
    )
      return undefined;
    return {
      type: "managed-checkout-summary",
      tlhGitFetches: value.tlhGitFetches,
      tlhPackageManagerInstalls: value.tlhPackageManagerInstalls,
    };
  }
  if (typeof value.phase !== "string" || !RECONCILIATION_PHASES.has(value.phase)) return undefined;
  if (value.type === "pi-reconciliation") {
    if (value.phase === "complete") {
      if (typeof value.headChanged !== "boolean") return undefined;
      return { type: "pi-reconciliation", phase: "complete", headChanged: value.headChanged };
    }
    if (value.phase === "start" || value.phase === "failed") {
      return { type: "pi-reconciliation", phase: value.phase };
    }
    return undefined;
  }
  if (value.type !== "tlh-repair") return undefined;
  const reason =
    value.reason === "invalid-marker-or-dependencies" || value.reason === "pi-repaired-dependencies"
      ? value.reason
      : undefined;
  if (!reason) return undefined;
  if (value.phase === "start") return { type: "tlh-repair", phase: "start", reason };
  if (value.phase === "complete") return { type: "tlh-repair", phase: "complete", reason };
  if (value.phase === "failed") return { type: "tlh-repair", phase: "failed", reason };
  if (value.phase === "skipped") return { type: "tlh-repair", phase: "skipped", reason };
  return undefined;
}

/** Parse and project only the opt-in, path-free reconciliation event fields. */
export function parseReconciliationEvents(output: string): ReconciliationEvent[] {
  const events: ReconciliationEvent[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith(RECONCILIATION_EVENT_PREFIX)) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(RECONCILIATION_EVENT_PREFIX.length));
      const event = parseReconciliationEvent(parsed);
      if (event) events.push(event);
    } catch {
      // Installer diagnostics are best-effort; malformed trace lines are ignored.
    }
  }
  return events;
}

function reconciliationCount(
  events: readonly ReconciliationEvent[],
  type: string,
  phase: string,
): number {
  return events.filter((event) => "phase" in event && event.type === type && event.phase === phase)
    .length;
}

function reconciliationSummaryCount(
  events: readonly ReconciliationEvent[],
  field: "tlhGitFetches" | "tlhPackageManagerInstalls",
): number | null {
  const summaries = events.filter((event) => event.type === "managed-checkout-summary");
  if (summaries.length === 0) return null;
  return summaries.reduce((total, event) => total + event[field], 0);
}

export function parseReconciliationObservation(
  stdout: string,
  stderr = "",
): ReconciliationObservation {
  const events = parseReconciliationEvents(stripTerminalNoise(`${stdout}\n${stderr}`));
  const hasSummary = events.some((event) => event.type === "managed-checkout-summary");
  return {
    available: hasSummary,
    availability: hasSummary ? "available" : events.length > 0 ? "no-summary" : "no-trace",
    events,
    piReconciliations: reconciliationCount(events, "pi-reconciliation", "start"),
    piFailures: reconciliationCount(events, "pi-reconciliation", "failed"),
    tlhRepairs: reconciliationCount(events, "tlh-repair", "start"),
    tlhRepairSkips: reconciliationCount(events, "tlh-repair", "skipped"),
    tlhGitFetches: reconciliationSummaryCount(events, "tlhGitFetches"),
    tlhPackageManagerInstalls: reconciliationSummaryCount(events, "tlhPackageManagerInstalls"),
  };
}

function diagnoseReadinessFailure(
  state: ReadinessObservationState,
  status: { code: number | null; signal: string | null; timedOut: boolean },
): string[] {
  const diagnostics: string[] = [];
  if (state.headerMs === undefined) diagnostics.push("TLH header marker was not observed");
  if (state.footerMs === undefined) diagnostics.push("TLH footer marker was not observed");
  const output = state.normalizedOutput;
  const lower = output.toLowerCase();
  if (
    lower.includes("trust") ||
    lower.includes("/trust") ||
    lower.includes("project is not trusted")
  ) {
    diagnostics.push("output suggests a trust prompt or unresolved project trust");
  }
  if (
    (lower.includes("install") && lower.includes("package")) ||
    lower.includes("loading extension") ||
    lower.includes("npm err!")
  ) {
    diagnostics.push("output suggests a package or extension installation stall");
  }
  if (status.timedOut) diagnostics.push(`launch timed out after ${LAUNCH_TIMEOUT_MS}ms`);
  else if (status.signal) diagnostics.push(`launch ended by signal ${status.signal}`);
  else if (status.code !== null && status.code !== 0)
    diagnostics.push(`launch exited with status ${status.code}`);
  diagnostics.push(`launch output excerpt:\n${excerptOutput(output)}`);
  return diagnostics;
}

function recordBoundary(state: PhaseObservationState, name: string, elapsedMs: number): void {
  if (state.boundaries[name] === undefined) state.boundaries[name] = elapsedMs;
}
function processPhaseLine(state: PhaseObservationState, line: string, elapsedMs: number): void {
  const normalized = line.replace(/\r/g, "").trim();
  if (!normalized) return;
  if (
    /Pinning local Pi runtime|Installing TLH private Pi runtime|^Installing package\.\.\./u.test(
      normalized,
    )
  ) {
    recordBoundary(state, "bootstrap-end", elapsedMs);
  }
  if (/Pinning local Pi runtime|Installing TLH private Pi runtime/u.test(normalized)) {
    recordBoundary(state, "runtime-start", elapsedMs);
  }
  if (normalized.startsWith("Installing package...")) {
    recordBoundary(state, "runtime-end", elapsedMs);
    recordBoundary(state, "package-start", elapsedMs);
  }
  if (/Applying isolated settings|Skipping settings\/keybinding merge/u.test(normalized)) {
    recordBoundary(state, "package-end", elapsedMs);
    recordBoundary(state, "defaults-start", elapsedMs);
  }
  if (
    /Installing bundled default extensions|Skipping bundled default extensions/u.test(normalized)
  ) {
    recordBoundary(state, "defaults-start", elapsedMs);
  }
  if (/Creating wrapper command|Installing wrapper command/u.test(normalized)) {
    recordBoundary(state, "defaults-end", elapsedMs);
    recordBoundary(state, "wrapper-start", elapsedMs);
  }
  if (/Done\. The Last Harness is ready\./u.test(normalized)) {
    recordBoundary(state, "wrapper-end", elapsedMs);
  }
}

export function createPhaseObserver(): PhaseObservationState {
  return { pendingByStream: { stdout: "", stderr: "" }, boundaries: {} };
}

export function observeInstallerChunk(
  state: PhaseObservationState,
  chunk: string,
  elapsedMs: number,
  stream: OutputStream = "stdout",
): void {
  state.pendingByStream[stream] += stripTerminalNoise(chunk);
  const lines = state.pendingByStream[stream].split("\n");
  state.pendingByStream[stream] = lines.pop() || "";
  for (const line of lines) processPhaseLine(state, line, elapsedMs);
}

export function finishPhaseObserver(
  state: PhaseObservationState,
  elapsedMs: number,
): PhaseMeasurementMap {
  for (const stream of ["stdout", "stderr"] as const) {
    const pending = state.pendingByStream[stream];
    if (pending) processPhaseLine(state, pending, elapsedMs);
  }
  const phases: Array<{ name: PhaseName; start: string; end: string; reason: string }> = [
    {
      name: "bootstrap",
      start: "bootstrap-start",
      end: "bootstrap-end",
      reason: "stage boundary was not observed",
    },
    {
      name: "runtime",
      start: "runtime-start",
      end: "runtime-end",
      reason: "runtime progress marker was not observed",
    },
    {
      name: "package-reconciliation",
      start: "package-start",
      end: "package-end",
      reason: "package reconciliation boundary was not observed",
    },
    {
      name: "defaults",
      start: "defaults-start",
      end: "defaults-end",
      reason: "defaults boundary was not observed",
    },
    {
      name: "managed-tools",
      start: "managed-start",
      end: "managed-end",
      reason: "managed tools are not isolated by default-level installer markers",
    },
    {
      name: "wrapper",
      start: "wrapper-start",
      end: "wrapper-end",
      reason: "wrapper boundary was not observed",
    },
  ];
  return Object.fromEntries(
    phases.map(({ name, start, end, reason }) => {
      const startMs = start === "bootstrap-start" ? 0 : (state.boundaries[start] ?? null);
      const endMs = state.boundaries[end] ?? null;
      if (startMs !== null && endMs !== null && endMs >= startMs) {
        return [name, { durationMs: endMs - startMs, startMs, endMs, quality: "progress-derived" }];
      }
      return [
        name,
        {
          durationMs: null,
          startMs,
          endMs,
          quality: "unavailable",
          reason,
        },
      ];
    }),
  );
}

function formatStatus(result: ProcessResult): string {
  if (result.timedOut) return "timed out";
  if (result.signal) return `signal ${result.signal}`;
  if (result.code === null) return "unknown exit";
  return `exit ${result.code}`;
}

function installerDiagnostics(result: ProcessResult, phases: PhaseMeasurementMap): string[] {
  const diagnostics = [formatStatus(result)];
  if (result.error) diagnostics.push(result.error);
  for (const [name, phase] of Object.entries(phases)) {
    if (phase.quality === "unavailable")
      diagnostics.push(`${name}: ${phase.reason || "unavailable"}`);
  }
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code !== 0 || result.signal || result.timedOut) {
    diagnostics.push(`installer output excerpt:\n${excerptOutput(output)}`);
  }
  return diagnostics;
}

async function measureLaunch(
  workspace: BenchmarkWorkspace,
  env: NodeJS.ProcessEnv,
  cleanup: CleanupController,
): Promise<LaunchMeasurement> {
  const ptyCommand = buildPtyCommand([workspace.wrapperPath]);
  const readiness = createReadinessObserver();
  const result = await runProcess(ptyCommand.command, ptyCommand.args, {
    cwd: workspace.cwd,
    env,
    timeoutMs: LAUNCH_TIMEOUT_MS,
    registerStop: cleanup.registerStop,
    onOutput: (chunk, _stream, elapsedMs) => observeReadinessChunk(readiness, chunk, elapsedMs),
  });
  const ready = readiness.readyMs !== undefined;
  return {
    wallMs: ready ? readiness.readyMs || 0 : null,
    firstOutputMs: readiness.firstOutputMs ?? null,
    headerMs: readiness.headerMs ?? null,
    footerMs: readiness.footerMs ?? null,
    ready,
    exit: { code: result.code, signal: result.signal, timedOut: result.timedOut },
    diagnostics: ready
      ? []
      : diagnoseReadinessFailure(readiness, {
          code: result.code,
          signal: result.signal,
          timedOut: result.timedOut,
        }),
  };
}

async function runInstaller(
  sourcePath: string,
  packageRef: string,
  workspace: BenchmarkWorkspace,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
): Promise<InstallerMeasurement> {
  const phaseObserver = createPhaseObserver();
  const env = buildChildEnvironment(workspace, sourceEnv, { ref: packageRef });
  const result = await runProcess(
    "bash",
    [
      sourcePath,
      "--ref",
      packageRef,
      "--agent-dir",
      workspace.agentDir,
      "--bin-dir",
      workspace.binDir,
      "--wrapper-name",
      workspace.wrapperName,
    ],
    {
      cwd: workspace.cwd,
      env,
      timeoutMs: INSTALL_TIMEOUT_MS,
      registerStop: cleanup.registerStop,
      onOutput: (chunk, stream, elapsedMs) => {
        observeInstallerChunk(phaseObserver, chunk, elapsedMs, stream);
      },
    },
  );
  const phases = finishPhaseObserver(phaseObserver, result.elapsedMs);
  const reconciliation = parseReconciliationObservation(result.stdout, result.stderr);
  const success = result.code === 0 && result.signal === null && !result.timedOut;
  return {
    wallMs: result.elapsedMs,
    exit: { code: result.code, signal: result.signal, timedOut: result.timedOut },
    phases,
    reconciliation,
    success,
    diagnostics: success ? [] : installerDiagnostics(result, phases),
  };
}

async function prepareFullyLaunchedSeed(
  sourcePath: string,
  packageRef: string,
  workspace: BenchmarkWorkspace,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
): Promise<SetupMeasurement> {
  const installer = await runInstaller(sourcePath, packageRef, workspace, sourceEnv, cleanup);
  if (!installer.success) {
    return {
      kind: "fully-launched-seed",
      excludedFromMeasurements: true,
      installerWallMs: installer.wallMs,
      launchWallMs: null,
      ready: false,
      diagnostics: installer.diagnostics,
    };
  }
  writeCredentialFreeTrustMetadata(workspace);
  const launch = await measureLaunch(
    workspace,
    buildChildEnvironment(workspace, sourceEnv, { ref: packageRef }),
    cleanup,
  );
  return {
    kind: "fully-launched-seed",
    excludedFromMeasurements: true,
    installerWallMs: installer.wallMs,
    launchWallMs: launch.wallMs,
    ready: launch.ready,
    diagnostics: launch.ready ? [] : launch.diagnostics,
  };
}

function copyNpmCache(source: BenchmarkWorkspace, destination: BenchmarkWorkspace): void {
  assertOwnedWorkspacePath(source.root, source.npmCache);
  assertOwnedWorkspacePath(destination.root, destination.npmCache);
  rmSync(destination.npmCache, { recursive: true, force: true });
  cpSync(source.npmCache, destination.npmCache, { recursive: true });
  mkdirSync(destination.npmCache, { recursive: true, mode: 0o700 });
}

function findPackageCheckout(agentDir: string): string {
  return join(agentDir, "git", "github.com", ...REPOSITORY.split("/"));
}

export async function readInstalledPackageRevision(
  workspace: BenchmarkWorkspace,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
  runner: ProcessRunner = runProcess,
): Promise<string | null> {
  const packageRoot = findPackageCheckout(workspace.agentDir);
  if (!existsSync(join(packageRoot, ".git")) && !existsSync(join(packageRoot, "HEAD"))) return null;
  const env = buildChildEnvironment(workspace, sourceEnv);
  const result = await runner(
    "git",
    ["--no-optional-locks", "-C", packageRoot, "rev-parse", "HEAD"],
    {
      cwd: workspace.cwd,
      env,
      timeoutMs: 10_000,
      registerStop: cleanup.registerStop,
    },
  );
  if (result.code !== 0 || result.signal) return null;
  const revision = result.stdout.trim();
  return /^[0-9a-f]{40}$/u.test(revision) ? revision : null;
}

export async function readPiVersion(
  workspace: BenchmarkWorkspace,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
  runner: ProcessRunner = runProcess,
): Promise<string | null> {
  const piPath = join(dirname(workspace.agentDir), "runtime", "bin", "pi");
  if (!existsSync(piPath)) return null;
  const result = await runner(piPath, ["--version"], {
    cwd: workspace.cwd,
    env: buildChildEnvironment(workspace, sourceEnv),
    timeoutMs: 15_000,
    registerStop: cleanup.registerStop,
  });
  if (result.code !== 0 || result.signal) return null;
  const match = `${result.stdout}\n${result.stderr}`.match(/\d+\.\d+\.\d+/u);
  return match?.[0] || null;
}

function parseNpmSource(source: string): { name: string; version: string } | undefined {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice("npm:".length);
  const separator = spec.lastIndexOf("@");
  if (separator <= 0 || separator === spec.length - 1) return undefined;
  const name = spec.slice(0, separator);
  const version = spec.slice(separator + 1);
  if (!name || !version || (!name.startsWith("@") && name.includes("/"))) return undefined;
  return { name, version };
}

export function parseBundledNpmPins(jsonText: string): NpmPinSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw new Error(
      `bundled default-extension manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed))
    throw new Error("bundled default-extension manifest must be an array");
  const packages = new Map<string, string>();
  for (const entry of parsed) {
    if (!isJsonRecord(entry)) continue;
    const source = entry.source;
    if (typeof source !== "string") continue;
    const pin = parseNpmSource(source);
    if (pin) packages.set(pin.name, pin.version);
  }
  if (packages.size === 0)
    throw new Error("bundled default-extension manifest contains no npm pins");
  return { packages };
}

export function compareBundledNpmPins(before: NpmPinSet, after: NpmPinSet): PinChange {
  const packages: Array<{ name: string; from: string; to: string }> = [];
  for (const [name, from] of before.packages) {
    const to = after.packages.get(name);
    if (to && to !== from) packages.push({ name, from, to });
  }
  return { changed: packages.length > 0, packages };
}

function rawFileUrl(ref: string, relativePath: string): string {
  const encodedRef = ref
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://raw.githubusercontent.com/${REPOSITORY}/${encodedRef}/${relativePath}`;
}

async function fetchTextWithCurl(
  url: string,
  workspace: BenchmarkWorkspace,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
): Promise<string> {
  const result = await runProcess(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--max-time",
      String(DOWNLOAD_TIMEOUT_MS / 1000),
      url,
    ],
    {
      cwd: workspace.cwd,
      env: buildChildEnvironment(workspace, sourceEnv),
      timeoutMs: DOWNLOAD_TIMEOUT_MS + 5_000,
      registerStop: cleanup.registerStop,
    },
  );
  if (result.code !== 0 || result.signal || result.timedOut) {
    throw new Error(
      `failed to download ${url}: ${formatStatus(result)}${result.stderr ? ` (${excerptOutput(result.stderr)})` : ""}`,
    );
  }
  return result.stdout;
}

type TextFetcher = (
  url: string,
  workspace: BenchmarkWorkspace,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
) => Promise<string>;

export async function readRemoteRefFile(
  ref: string,
  relativePath: string,
  workspace: BenchmarkWorkspace,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
  fetcher: TextFetcher = fetchTextWithCurl,
): Promise<string> {
  return fetcher(rawFileUrl(ref, relativePath), workspace, sourceEnv, cleanup);
}

export function installedRevisionMismatchDiagnostic(
  scenario: ScenarioName,
  run: number,
  requestedRef: string,
  resolvedRevision: string,
  observedRevision: string | null,
): string | null {
  if (!observedRevision || observedRevision === resolvedRevision) return null;
  return `${scenario} run ${run}: selected ref ${requestedRef} resolved to ${resolvedRevision}, but installed package revision was ${observedRevision}`;
}

export function parseRemoteRevision(output: string, ref: string): string | null {
  const peeledTagRef = `refs/tags/${ref}^{}`;
  const directRefs = new Set([`refs/heads/${ref}`, `refs/tags/${ref}`, ref]);
  let peeledTag: string | null = null;
  let direct: string | null = null;

  for (const line of output.split(/\r?\n/u)) {
    const match = line.trim().match(/^([0-9a-f]{40})\s+(\S+)$/u);
    if (!match) continue;
    const [, revision, remoteRef] = match;
    if (remoteRef === peeledTagRef) peeledTag = revision;
    else if (direct === null && directRefs.has(remoteRef)) direct = revision;
  }

  return peeledTag ?? direct;
}

type ProcessRunner = typeof runProcess;

export async function resolveRemoteRefRevision(
  ref: string,
  workspace: BenchmarkWorkspace,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
  runner: ProcessRunner = runProcess,
): Promise<string | null> {
  if (/^[0-9a-f]{40}$/u.test(ref)) return ref;
  const remote = await runner(
    "git",
    [
      "--no-optional-locks",
      "ls-remote",
      `https://github.com/${REPOSITORY}.git`,
      ref,
      `refs/heads/${ref}`,
      `refs/tags/${ref}`,
      `refs/tags/${ref}^{}`,
    ],
    {
      cwd: workspace.cwd,
      env: buildChildEnvironment(workspace, sourceEnv, { ref }),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      registerStop: cleanup.registerStop,
    },
  );
  if (remote.code !== 0 || remote.signal || remote.timedOut) return null;
  return parseRemoteRevision(remote.stdout, ref);
}

async function currentCheckoutRevision(
  repoRoot: string,
  workspace: BenchmarkWorkspace,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
): Promise<{ revision: string | null; dirty: boolean | null }> {
  const env = buildChildEnvironment(workspace, sourceEnv);
  const revisionResult = await runProcess(
    "git",
    ["--no-optional-locks", "-C", repoRoot, "rev-parse", "HEAD"],
    {
      cwd: workspace.cwd,
      env,
      timeoutMs: 30_000,
      registerStop: cleanup.registerStop,
    },
  );
  const statusResult = await runProcess(
    "git",
    ["--no-optional-locks", "-C", repoRoot, "status", "--porcelain"],
    {
      cwd: workspace.cwd,
      env,
      timeoutMs: 30_000,
      registerStop: cleanup.registerStop,
    },
  );
  const revision = revisionResult.code === 0 ? revisionResult.stdout.trim() : "";
  return {
    revision: /^[0-9a-f]{40}$/u.test(revision) ? revision : null,
    dirty: statusResult.code === 0 ? statusResult.stdout.trim().length > 0 : null,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function numericSummary(values: number[]): JsonRecord {
  return {
    count: values.length,
    median: median(values),
    mean: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
  };
}

function summarizeSamples(samples: SampleResult[]): JsonRecord {
  const measuredSamples = samples.filter((sample) => sample.failureDiagnostics.length === 0);
  const installerValues = measuredSamples.flatMap((sample) =>
    sample.installer?.success ? [sample.installer.wallMs] : [],
  );
  const launchValues = measuredSamples.flatMap((sample) =>
    sample.launch?.ready && sample.launch.wallMs !== null ? [sample.launch.wallMs] : [],
  );
  const phaseSummary: JsonRecord = {};
  for (const phase of [
    "bootstrap",
    "runtime",
    "package-reconciliation",
    "defaults",
    "managed-tools",
    "wrapper",
  ] as const) {
    const values = measuredSamples.flatMap((sample) => {
      if (!sample.installer?.success) return [];
      const value = sample.installer.phases[phase]?.durationMs;
      return typeof value === "number" ? [value] : [];
    });
    phaseSummary[phase] = numericSummary(values);
  }
  const byScenario: JsonRecord = {};
  for (const scenario of new Set(samples.map((sample) => sample.scenario))) {
    const scenarioSamples = samples.filter((sample) => sample.scenario === scenario);
    const measuredScenarioSamples = scenarioSamples.filter(
      (sample) => sample.failureDiagnostics.length === 0,
    );
    byScenario[scenario] = {
      installerWallMs: numericSummary(
        measuredScenarioSamples.flatMap((sample) =>
          sample.installer?.success ? [sample.installer.wallMs] : [],
        ),
      ),
      firstUsableLaunchMs: numericSummary(
        measuredScenarioSamples.flatMap((sample) =>
          sample.launch?.ready && sample.launch.wallMs !== null ? [sample.launch.wallMs] : [],
        ),
      ),
      failures: scenarioSamples.filter((sample) => sample.failureDiagnostics.length > 0).length,
    };
  }
  return {
    installerWallMs: numericSummary(installerValues),
    firstUsableLaunchMs: numericSummary(launchValues),
    phasesMs: phaseSummary,
    byScenario,
    failedSamples: samples.filter((sample) => sample.failureDiagnostics.length > 0).length,
  };
}

export async function npmVersion(
  workspace: BenchmarkWorkspace,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
  runner: ProcessRunner = runProcess,
): Promise<string | null> {
  const result = await runner("npm", ["--version"], {
    cwd: workspace.cwd,
    env: buildChildEnvironment(workspace, sourceEnv),
    timeoutMs: 15_000,
    registerStop: cleanup.registerStop,
  });
  if (result.code !== 0 || result.signal) return null;
  const value = result.stdout.trim();
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value) ? value : null;
}

export async function prepareSource(
  options: BenchmarkOptions,
  root: string,
  workspace: BenchmarkWorkspace,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
  selectedRevision: string,
  runner: ProcessRunner = runProcess,
) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (options.mode === "checkout") {
    const installScriptPath = join(repoRoot, "install.sh");
    if (!existsSync(installScriptPath))
      throw new Error(`checkout installer not found: ${installScriptPath}`);
    const checkout = await currentCheckoutRevision(repoRoot, workspace, sourceEnv, cleanup);
    return {
      installScriptPath,
      supportCodeRevision: checkout.revision,
      supportCodeDirty: checkout.dirty,
    };
  }

  const installScriptPath = join(root, "remote-install.sh");
  assertOwnedWorkspacePath(root, installScriptPath);
  const result = await runner(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--max-time",
      String(DOWNLOAD_TIMEOUT_MS / 1000),
      rawFileUrl(selectedRevision, "install.sh"),
      "-o",
      installScriptPath,
    ],
    {
      cwd: workspace.cwd,
      env: buildChildEnvironment(workspace, sourceEnv, { ref: selectedRevision }),
      timeoutMs: DOWNLOAD_TIMEOUT_MS + 5_000,
      registerStop: cleanup.registerStop,
    },
  );
  if (result.code !== 0 || result.signal || result.timedOut || !existsSync(installScriptPath)) {
    throw new Error(
      `failed to download installer for ${options.ref}: ${formatStatus(result)}${result.stderr ? ` (${excerptOutput(result.stderr)})` : ""}`,
    );
  }
  return {
    installScriptPath,
    supportCodeRevision: selectedRevision,
    supportCodeDirty: null,
  };
}

async function createWarmCacheSeed(
  sourcePath: string,
  root: string,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
  selectedRevision: string,
): Promise<WarmCacheSeed> {
  const workspace = createBenchmarkWorkspace(root);
  const setup = await prepareFullyLaunchedSeed(
    sourcePath,
    selectedRevision,
    workspace,
    sourceEnv,
    cleanup,
  );
  if (!setup.ready) {
    removeOwnedWorkspace(workspace.root);
    throw new Error(`warm-cache seed was not fully launched:\n${setup.diagnostics.join("\n")}`);
  }
  return { workspace, setup: { ...setup, kind: "warm-cache-seed" } };
}

async function runScenarioSample(
  sourcePath: string,
  options: BenchmarkOptions,
  scenario: ScenarioName,
  runNumber: number,
  root: string,
  sourceEnv: NodeJS.ProcessEnv,
  cleanup: CleanupController,
  warmCacheSeed: WarmCacheSeed | undefined,
  selectedRevision: string,
  upgradeRevision: string | null,
): Promise<SampleResult> {
  const workspace = createBenchmarkWorkspace(root);
  const selectedRef = options.ref;
  let setup: SetupMeasurement = {
    kind: "none",
    excludedFromMeasurements: true,
    installerWallMs: null,
    launchWallMs: null,
    ready: null,
    diagnostics: [],
  };
  const failureDiagnostics: string[] = [];
  try {
    if (scenario === "warm-cache-fresh") {
      if (!warmCacheSeed) throw new Error("warm-cache seed was not prepared");
      copyNpmCache(warmCacheSeed.workspace, workspace);
      setup = warmCacheSeed.setup;
    } else if (scenario === "unchanged-reinstall" || scenario === "changed-pin-upgrade") {
      const seedRef = scenario === "changed-pin-upgrade" ? options.upgradeFrom : selectedRef;
      const seedRevision = scenario === "changed-pin-upgrade" ? upgradeRevision : selectedRevision;
      if (!seedRef || !seedRevision) throw new Error("changed-pin-upgrade requires --upgrade-from");
      setup = await prepareFullyLaunchedSeed(
        sourcePath,
        seedRevision,
        workspace,
        sourceEnv,
        cleanup,
      );
      if (!setup.ready) {
        failureDiagnostics.push("fully launched seed was not ready", ...setup.diagnostics);
        return {
          scenario,
          run: runNumber,
          cacheCondition: scenarioCacheCondition(scenario),
          selectedPackageRef: selectedRef,
          setup,
          installer: null,
          launch: null,
          readinessOutcome: "not-run",
          failureDiagnostics,
          observedInstalledRevision: null,
          piVersion: null,
        };
      }
    }

    const installer = await runInstaller(
      sourcePath,
      selectedRevision,
      workspace,
      sourceEnv,
      cleanup,
    );
    if (!installer.success) {
      failureDiagnostics.push(...installer.diagnostics);
      return {
        scenario,
        run: runNumber,
        cacheCondition: scenarioCacheCondition(scenario),
        selectedPackageRef: selectedRef,
        setup,
        installer,
        launch: null,
        readinessOutcome: "not-run",
        failureDiagnostics,
        observedInstalledRevision: null,
        piVersion: null,
      };
    }

    writeCredentialFreeTrustMetadata(workspace);
    const launch = await measureLaunch(
      workspace,
      buildChildEnvironment(workspace, sourceEnv, { ref: selectedRevision }),
      cleanup,
    );
    if (!launch.ready) failureDiagnostics.push(...launch.diagnostics);
    const observedInstalledRevision = await readInstalledPackageRevision(
      workspace,
      sourceEnv,
      cleanup,
    );
    const revisionDiagnostic = installedRevisionMismatchDiagnostic(
      scenario,
      runNumber,
      selectedRef,
      selectedRevision,
      observedInstalledRevision,
    );
    if (revisionDiagnostic) failureDiagnostics.push(revisionDiagnostic);
    const piVersion = await readPiVersion(workspace, sourceEnv, cleanup);
    return {
      scenario,
      run: runNumber,
      cacheCondition: scenarioCacheCondition(scenario),
      selectedPackageRef: selectedRef,
      setup,
      installer,
      launch,
      readinessOutcome: launch.ready ? "ready" : "failed",
      failureDiagnostics,
      observedInstalledRevision,
      piVersion,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failureDiagnostics.push(message);
    return {
      scenario,
      run: runNumber,
      cacheCondition: scenarioCacheCondition(scenario),
      selectedPackageRef: selectedRef,
      setup,
      installer: null,
      launch: null,
      readinessOutcome: "not-run",
      failureDiagnostics,
      observedInstalledRevision: null,
      piVersion: null,
    };
  } finally {
    removeOwnedWorkspace(workspace.root);
  }
}

function benchmarkScope(): JsonRecord {
  return {
    installerWallTime:
      "measured from the isolated installer process start through exit; all unclassified child work remains included",
    phaseTimings:
      "progress-marker timings are approximate; phases without both markers are unavailable rather than zero",
    phaseComposition:
      "managed-tools is unavailable because default-level output does not isolate it; wrapper creation is reported separately, while defaults may include unmarked managed-tool work",
    reconciliation:
      "opt-in path-free events distinguish Pi reconciliation from TLH local repair; only managed-checkout summaries make TLH fetch and package-manager counters available, while failed, old, or untraced runs report those counters as null",
    firstUsableLaunch:
      "PTY launch with no prompt or model request; readiness requires observed TLH header and footer markers",
    setup:
      "seed installs, warm-cache seeding, trust metadata, and outer remote installer downloads are excluded from measured sample timings and reported separately",
    setupProvenance:
      "checkout mode uses this checkout's current support code for both old-ref seeds and selected-ref installs; remote mode stage-0 canonicalizes support files to each resolved commit, including old-ref seeds",
    environment:
      "temporary HOME/profile/bin/npm cache/cwd with allowlisted environment, isolated npm/git/XDG configuration, and no inherited credentials",
    network:
      "remote mode and package installation require network; no live baseline is run by ordinary validation",
    offline: "PI_OFFLINE is intentionally not set for measured first launch",
  };
}

async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const root = mkdtempSync(join(tmpdir(), BENCHMARK_ROOT_PREFIX));
  const cleanup = createCleanupController();
  cleanup.registerWorkspace(root);
  cleanup.install();
  const sourceEnv = process.env;
  let workspace: BenchmarkWorkspace | undefined;
  try {
    workspace = createBenchmarkWorkspace(root);
    const selectedRevision = await resolveRemoteRefRevision(
      options.ref,
      workspace,
      sourceEnv,
      cleanup,
    );
    if (!selectedRevision) throw new Error(`unable to resolve selected ref ${options.ref}`);
    const upgradeRevision = options.upgradeFrom
      ? await resolveRemoteRefRevision(options.upgradeFrom, workspace, sourceEnv, cleanup)
      : null;
    if (options.upgradeFrom && !upgradeRevision) {
      throw new Error(`unable to resolve upgrade ref ${options.upgradeFrom}`);
    }
    let pinChange: PinChange | null = null;
    if (options.scenarios === "all" && options.upgradeFrom) {
      if (!upgradeRevision) throw new Error(`unable to resolve upgrade ref ${options.upgradeFrom}`);
      const beforeText = await readRemoteRefFile(
        upgradeRevision,
        "config/default-extensions.json",
        workspace,
        sourceEnv,
        cleanup,
      );
      const afterText = await readRemoteRefFile(
        selectedRevision,
        "config/default-extensions.json",
        workspace,
        sourceEnv,
        cleanup,
      );
      pinChange = compareBundledNpmPins(
        parseBundledNpmPins(beforeText),
        parseBundledNpmPins(afterText),
      );
      if (!pinChange.changed) {
        throw new Error(
          `--upgrade-from ${options.upgradeFrom} and --ref ${options.ref} do not change a bundled npm pin`,
        );
      }
    }

    const source = await prepareSource(
      options,
      root,
      workspace,
      sourceEnv,
      cleanup,
      selectedRevision,
    );
    const npm = await npmVersion(workspace, sourceEnv, cleanup);
    const samples: SampleResult[] = [];
    let warmCacheSeed: WarmCacheSeed | undefined;
    for (const scenario of selectedScenarios(options.scenarios)) {
      if (scenario === "warm-cache-fresh" && !warmCacheSeed) {
        warmCacheSeed = await createWarmCacheSeed(
          source.installScriptPath,
          root,
          sourceEnv,
          cleanup,
          selectedRevision,
        );
      }
      for (let runNumber = 1; runNumber <= options.runs; runNumber += 1) {
        samples.push(
          await runScenarioSample(
            source.installScriptPath,
            options,
            scenario,
            runNumber,
            root,
            sourceEnv,
            cleanup,
            warmCacheSeed,
            selectedRevision,
            upgradeRevision,
          ),
        );
      }
    }
    const firstPiVersion = samples.find((sample) => sample.piVersion)?.piVersion || null;
    const failureDiagnostics = samples.flatMap((sample) =>
      sample.failureDiagnostics.length > 0
        ? [`${sample.scenario} run ${sample.run}:`, ...sample.failureDiagnostics]
        : [],
    );
    return {
      schemaVersion: 1,
      benchmark: "installer-performance",
      generatedAt: new Date().toISOString(),
      platform: { os: process.platform, arch: process.arch },
      toolVersions: { node: process.versions.node, npm, pi: firstPiVersion },
      mode: options.mode,
      selectedRef: { requested: options.ref, resolved: selectedRevision },
      upgradeFromRef: options.upgradeFrom
        ? { requested: options.upgradeFrom, resolved: upgradeRevision }
        : null,
      supportCodeRevision: source.supportCodeRevision,
      supportCodeDirty: source.supportCodeDirty,
      pinChange,
      scenarios: options.scenarios,
      runs: options.runs,
      cacheConditions: {
        "cold-cache-fresh": scenarioCacheCondition("cold-cache-fresh"),
        "warm-cache-fresh": scenarioCacheCondition("warm-cache-fresh"),
        "unchanged-reinstall": scenarioCacheCondition("unchanged-reinstall"),
        "changed-pin-upgrade": scenarioCacheCondition("changed-pin-upgrade"),
        warmCacheSeed: warmCacheSeed
          ? { performed: true, ...warmCacheSeed.setup }
          : { performed: false, excludedFromMeasurements: true },
      },
      measurementScope: benchmarkScope(),
      samples,
      summary: summarizeSamples(samples),
      failureDiagnostics,
    };
  } finally {
    try {
      await cleanup.cleanup();
    } finally {
      cleanup.uninstall();
    }
  }
}

function formatMs(value: number | null): string {
  return value === null ? "unavailable" : `${value.toFixed(1)}ms`;
}

function printTextResult(result: BenchmarkResult): void {
  console.log("The Last Harness installer performance benchmark");
  console.log(`mode: ${result.mode}`);
  console.log(
    `selected ref: ${result.selectedRef.requested} (${result.selectedRef.resolved || "unresolved"})`,
  );
  if (result.upgradeFromRef) {
    console.log(
      `upgrade-from ref: ${result.upgradeFromRef.requested} (${result.upgradeFromRef.resolved || "unresolved"})`,
    );
  }
  console.log(`support-code revision: ${result.supportCodeRevision || "unresolved"}`);
  console.log(`platform: ${result.platform.os}/${result.platform.arch}`);
  console.log(
    `versions: node ${result.toolVersions.node}, npm ${result.toolVersions.npm || "unavailable"}, pi ${result.toolVersions.pi || "unavailable"}`,
  );
  console.log("");
  for (const sample of result.samples) {
    console.log(
      `sample ${sample.scenario} run ${sample.run}: installer ${formatMs(sample.installer?.success ? sample.installer.wallMs : null)}; launch ${formatMs(sample.launch?.ready ? sample.launch.wallMs : null)}; readiness ${sample.readinessOutcome}`,
    );
    console.log(`  cache: ${sample.cacheCondition}`);
    console.log(
      `  observed installed revision: ${sample.observedInstalledRevision || "unavailable"}`,
    );
    const reconciliation = sample.installer?.reconciliation;
    if (reconciliation?.available) {
      console.log(
        `  reconciliation: Pi ${reconciliation.piReconciliations}; TLH repairs ${reconciliation.tlhRepairs}; TLH repair skips ${reconciliation.tlhRepairSkips}; TLH fetches ${reconciliation.tlhGitFetches}; TLH package-manager installs ${reconciliation.tlhPackageManagerInstalls}`,
      );
    } else if (!sample.installer) {
      console.log("  reconciliation: unavailable (installer was not run)");
    } else if (reconciliation?.availability === "no-summary") {
      console.log(
        "  reconciliation: unavailable (managed-checkout-summary was not observed; summary-derived TLH work counters are unavailable)",
      );
    } else {
      console.log(
        "  reconciliation: unavailable (installer ran without the opt-in trace; support may predate instrumentation or have failed before managed checkout)",
      );
    }
    for (const diagnostic of sample.failureDiagnostics.slice(0, 4)) {
      console.log(`  diagnostic: ${diagnostic}`);
    }
  }
  const summary = result.summary as JsonRecord;
  const installer = summary.installerWallMs as JsonRecord;
  const launch = summary.firstUsableLaunchMs as JsonRecord;
  console.log("");
  console.log(
    `summary installer median: ${formatMs(typeof installer.median === "number" ? installer.median : null)}`,
  );
  console.log(
    `summary first usable launch median: ${formatMs(typeof launch.median === "number" ? launch.median : null)}`,
  );
  console.log(
    "phase timings are approximate progress observations; unavailable phases are not treated as zero",
  );
  const phaseSummaries = isJsonRecord(summary.phasesMs) ? summary.phasesMs : {};
  console.log("phase medians:");
  for (const phaseName of [
    "bootstrap",
    "runtime",
    "package-reconciliation",
    "defaults",
    "managed-tools",
    "wrapper",
  ]) {
    const phase = phaseSummaries[phaseName];
    const median = isJsonRecord(phase) && typeof phase.median === "number" ? phase.median : null;
    console.log(`  ${phaseName}: ${formatMs(median)} median`);
  }
  console.log(`scope: ${String(result.measurementScope.installerWallTime)}`);
  console.log(`phase composition: ${String(result.measurementScope.phaseComposition)}`);
  console.log(`setup provenance: ${String(result.measurementScope.setupProvenance)}`);
  console.log(`launch environment: ${String(result.measurementScope.offline)}`);
  const failedSamples = summary.failedSamples;
  if (typeof failedSamples === "number" && failedSamples > 0)
    console.log(`failed samples: ${failedSamples}`);
}

function createCleanupController(): CleanupController {
  const stops = new Set<CleanupStop>();
  const roots = new Set<string>();
  const handlers = new Map<NodeJS.Signals, () => void>();
  let cleanupPromise: Promise<void> | undefined;
  let signalInProgress = false;

  const cleanup = async (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        await Promise.allSettled(Array.from(stops, (stop) => Promise.resolve().then(() => stop())));
        let cleanupFailed = false;
        let cleanupError: unknown;
        for (const root of roots) {
          try {
            if (existsSync(root)) removeOwnedWorkspace(root);
          } catch (error) {
            if (!cleanupFailed) cleanupError = error;
            cleanupFailed = true;
          } finally {
            roots.delete(root);
          }
        }
        if (cleanupFailed) throw cleanupError;
      })();
    }
    return cleanupPromise;
  };

  const uninstall = (): void => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    handlers.clear();
  };

  return {
    install(): void {
      if (handlers.size > 0) return;
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const handler = (): void => {
          if (signalInProgress) return;
          signalInProgress = true;
          void cleanup()
            .catch(() => undefined)
            .finally(() => {
              uninstall();
              try {
                process.kill(process.pid, signal);
              } catch {
                process.exit(signal === "SIGINT" ? 130 : 143);
              }
            });
        };
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
    },
    uninstall,
    registerStop(stop: CleanupStop): () => void {
      stops.add(stop);
      return () => stops.delete(stop);
    },
    registerWorkspace(root: string): () => void {
      roots.add(root);
      return () => roots.delete(root);
    },
    cleanup,
  };
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: BenchmarkOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (argv.some((arg) => arg === "--json" || arg.startsWith("--json="))) {
      console.log(JSON.stringify({ benchmark: "installer-performance", error: message }));
    } else console.error(`error: ${message}`);
    return 1;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  try {
    const result = await runBenchmark(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printTextResult(result);
    return result.failureDiagnostics.length > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json)
      console.log(JSON.stringify({ benchmark: "installer-performance", error: message }));
    else console.error(`error: ${message}`);
    return 1;
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  }
}

if (isMainModule()) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

export {
  DEFAULT_MODE,
  DEFAULT_REF,
  DEFAULT_RUNS,
  DEFAULT_SCENARIOS,
  INSTALL_TIMEOUT_MS,
  LAUNCH_TIMEOUT_MS,
  REPOSITORY,
  assertOwnedWorkspacePath,
  benchmarkScope,
  buildChildEnvironment,
  createBenchmarkWorkspace,
  createCleanupController,
  createReadinessObserver,
  diagnoseReadinessFailure,
  main,
  runProcess,
  parseArgs,
  printTextResult,
  runBenchmark,
  summarizeSamples,
  observeReadinessChunk,
  selectedScenarios,
  scenarioCacheCondition,
  usage,
  writeCredentialFreeTrustMetadata,
};
