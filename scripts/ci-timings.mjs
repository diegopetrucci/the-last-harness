#!/usr/bin/env node
/**
 * Opt-in CI test timing support.
 *
 * This module is contributor-only.  It deliberately keeps timing collection
 * outside the normal test path: callers opt in by setting
 * TLH_CI_TIMINGS_DIR to an absolute directory outside the test HOME/TMPDIR.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism as nodeAvailableParallelism, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { resolveTestConcurrency } from "./test-concurrency.mjs";

export const CI_TIMINGS_DIR_ENV = "TLH_CI_TIMINGS_DIR";
export const CI_TIMINGS_EVENT_FILE_ENV = "TLH_CI_TIMINGS_EVENT_FILE";
export const CI_TIMINGS_SUITE_ENV = "TLH_CI_TIMINGS_SUITE";
export const CI_TIMINGS_SHARD_ENV = "TLH_CI_TIMINGS_SHARD";
export const CI_TIMINGS_REPO_ROOT_ENV = "TLH_CI_TIMINGS_REPO_ROOT";
export const CI_TIMINGS_RUN_ID_ENV = "TLH_CI_TIMINGS_RUN_ID";

export const CI_TIMINGS_SCHEMA_VERSION = 1;
export const MAX_CI_TIMING_EVENT_BYTES = 1024 * 1024;
export const MAX_CI_TIMING_REPORT_BYTES = 2 * 1024 * 1024;

const REPORT_FILE_PREFIX = "tlh-ci-timings-";
const EVENT_FILE_SUFFIX = ".events.jsonl";
const REPORT_FILE_SUFFIX = ".json";

/**
 * @param {string} value
 * @returns {string}
 */
function canonicalPath(value) {
  const resolved = resolve(value);
  let current = resolved;
  const suffix = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }

  let canonical;
  try {
    canonical = realpathSync.native(current);
  } catch {
    canonical = current;
  }
  for (const component of suffix) canonical = join(canonical, component);
  return resolve(canonical);
}

/**
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isWithin(child, parent) {
  const childRelative = relative(parent, child);
  return childRelative === "" || (!childRelative.startsWith(`..${sep}`) && childRelative !== "..");
}

/**
 * Return a safe, bounded path component for an event filename.
 *
 * @param {string} value
 * @returns {string}
 */
function safeComponent(value) {
  const safe = value.replace(/[^A-Za-z0-9._-]/gu, "_");
  return safe.length > 80 ? safe.slice(0, 80) : safe || "unknown";
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Keep durations readable without turning a report into a floating-point dump.
 *
 * @param {number} value
 * @returns {number}
 */
function roundMs(value) {
  return Number(value.toFixed(3));
}

/**
 * @param {string | undefined} configured
 * @param {string} label
 * @returns {string | undefined}
 */
function requireAbsolutePath(configured, label) {
  if (configured === undefined) return undefined;
  if (configured.length === 0 || configured.includes("\0")) {
    throw new Error(`${label} must be a non-empty absolute path`);
  }
  if (!isAbsolute(configured)) {
    throw new Error(`${label} must be an absolute path; received ${JSON.stringify(configured)}`);
  }
  return canonicalPath(configured);
}

/**
 * Validate the opt-in output directory without touching the filesystem.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string[]} [guardedRoots]
 * @returns {string | undefined}
 */
export function resolveCiTimingDirectory(env = process.env, guardedRoots = []) {
  const configured = env[CI_TIMINGS_DIR_ENV];
  if (configured === undefined) return undefined;

  const directory = requireAbsolutePath(configured, CI_TIMINGS_DIR_ENV);
  if (directory === undefined) return undefined;

  const roots = [
    ["HOME", env.HOME],
    ["TMPDIR", env.TMPDIR],
    ["TMP", env.TMP],
    ["TEMP", env.TEMP],
    ["system temporary directory", tmpdir()],
    ...guardedRoots.map((root) => ["guarded temporary directory", root]),
  ];
  for (const [label, root] of roots) {
    if (typeof root !== "string" || root.length === 0) continue;
    const canonicalRoot = canonicalPath(root);
    if (isWithin(directory, canonicalRoot)) {
      throw new Error(
        `${CI_TIMINGS_DIR_ENV} must be outside ${label}; received ${JSON.stringify(configured)}`,
      );
    }
  }
  return directory;
}

/**
 * Resolve the contributor-only timing configuration and create its explicitly
 * selected output directory.  An unset directory returns null and leaves the
 * caller's normal command and output path unchanged.
 *
 * @param {{
 *   env?: Record<string, string | undefined>;
 *   repoRoot?: string;
 *   shard?: string;
 *   guardedRoots?: string[];
 *   runId?: string;
 *   laneLayout?: string;
 *   availableParallelism?: () => number;
 * }} [options]
 * @returns {TimingConfig | null}
 */
export function createCiTimingConfig({
  env = process.env,
  repoRoot = process.cwd(),
  shard = "unknown",
  guardedRoots = [],
  runId = `${Date.now().toString(36)}-${process.pid}-${randomUUID().slice(0, 8)}`,
  laneLayout = "baseline",
  availableParallelism = nodeAvailableParallelism,
} = {}) {
  const directory = resolveCiTimingDirectory(env, guardedRoots);
  if (directory === undefined) return null;

  mkdirSync(directory, { recursive: true });
  if (!statSync(directory).isDirectory()) {
    throw new Error(`${CI_TIMINGS_DIR_ENV} is not a directory: ${JSON.stringify(directory)}`);
  }

  let availableCpuCount;
  try {
    availableCpuCount = availableParallelism();
  } catch {
    availableCpuCount = 1;
  }
  if (!Number.isSafeInteger(availableCpuCount) || availableCpuCount < 1) {
    availableCpuCount = 1;
  }

  const configuredConcurrency = resolveTestConcurrency({
    env,
    availableParallelism: () => availableCpuCount,
  });
  const concurrencySource =
    configuredConcurrency !== undefined
      ? env.TLH_TEST_CONCURRENCY === undefined
        ? "adaptive-local"
        : "explicit"
      : "node-default";
  const effectiveConcurrency =
    configuredConcurrency ??
    (concurrencySource === "node-default" ? Math.max(availableCpuCount - 1, 1) : availableCpuCount);

  return {
    enabled: true,
    directory,
    repoRoot: canonicalPath(repoRoot),
    shard,
    runId: safeComponent(runId),
    nodeVersion: process.version,
    laneLayout,
    availableCpuCount,
    effectiveConcurrency,
    concurrencySource,
  };
}

/**
 * @typedef {{
 *   enabled: true;
 *   directory: string;
 *   repoRoot: string;
 *   shard: string;
 *   runId: string;
 *   nodeVersion: string;
 *   laneLayout: string;
 *   availableCpuCount: number;
 *   effectiveConcurrency: number;
 *   concurrencySource: string;
 * }} TimingConfig
 */

/**
 * Build a unique raw event path for one test command.
 *
 * @param {TimingConfig} config
 * @param {{ lane: string; index: number; suite: string }} command
 * @returns {string}
 */
export function timingEventFile(config, { lane, index, suite }) {
  const filename = [
    REPORT_FILE_PREFIX + config.runId,
    safeComponent(config.shard),
    safeComponent(lane),
    String(index),
    safeComponent(suite),
  ].join("-");
  return join(config.directory, `${filename}${EVENT_FILE_SUFFIX}`);
}

/**
 * Build the environment passed to one timed test command.
 *
 * @param {TimingConfig} config
 * @param {{ suite: string; eventFile: string }} command
 * @returns {Record<string, string>}
 */
export function timingCommandEnvironment(config, { suite, eventFile }) {
  const canonicalEventFile = canonicalPath(eventFile);
  if (!isWithin(canonicalEventFile, config.directory)) {
    throw new Error("CI timing event files must remain inside TLH_CI_TIMINGS_DIR");
  }
  return {
    [CI_TIMINGS_DIR_ENV]: config.directory,
    [CI_TIMINGS_EVENT_FILE_ENV]: canonicalEventFile,
    [CI_TIMINGS_SUITE_ENV]: suite,
    [CI_TIMINGS_SHARD_ENV]: config.shard,
    [CI_TIMINGS_REPO_ROOT_ENV]: config.repoRoot,
    [CI_TIMINGS_RUN_ID_ENV]: config.runId,
  };
}

/**
 * Build additional Node test-runner arguments for the timing reporter.
 * The ordinary reporter remains first, so stdout retains its existing TAP or
 * dot output.  The custom reporter is sent to the explicitly configured event
 * file and never replaces normal diagnostics.
 *
 * @param {{ env?: Record<string, string | undefined>; reporterPath: string }} options
 * @returns {string[]}
 */
export function ciTimingReporterArgs({ env = process.env, reporterPath }) {
  const directory = env[CI_TIMINGS_DIR_ENV];
  const eventFile = env[CI_TIMINGS_EVENT_FILE_ENV];
  if (directory === undefined && eventFile === undefined) return [];
  if (directory === undefined || eventFile === undefined) {
    throw new Error(
      `${CI_TIMINGS_DIR_ENV} and ${CI_TIMINGS_EVENT_FILE_ENV} must be set together when timing is enabled`,
    );
  }
  const resolvedDirectory = requireAbsolutePath(directory, CI_TIMINGS_DIR_ENV);
  const resolvedEventFile = requireAbsolutePath(eventFile, CI_TIMINGS_EVENT_FILE_ENV);
  if (!resolvedDirectory || !resolvedEventFile || !isWithin(resolvedEventFile, resolvedDirectory)) {
    throw new Error(`${CI_TIMINGS_EVENT_FILE_ENV} must be inside ${CI_TIMINGS_DIR_ENV}`);
  }
  if (typeof reporterPath !== "string" || reporterPath.length === 0) {
    throw new Error("CI timing reporter path is required when timing is enabled");
  }
  return [
    `--test-reporter=${reporterPath}`,
    "--test-reporter-destination=stdout",
    `--test-reporter-destination=${resolvedEventFile}`,
  ];
}

/**
 * Read at most the event-file cap.  A child reporter is expected to enforce the
 * same bound, but the parent remains bounded if a malformed helper writes more.
 *
 * @param {string} eventFile
 * @returns {{ text: string; truncated: boolean }}
 */
function readBoundedEventFile(eventFile) {
  try {
    const size = statSync(eventFile).size;
    const truncated = size > MAX_CI_TIMING_EVENT_BYTES;
    if (!truncated) return { text: readFileSync(eventFile, "utf8"), truncated: false };

    const fd = openSync(eventFile, "r");
    try {
      const bytes = Buffer.alloc(MAX_CI_TIMING_EVENT_BYTES);
      const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
      return { text: bytes.subarray(0, bytesRead).toString("utf8"), truncated: true };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { text: "", truncated: false };
  }
}

/**
 * @param {string} value
 * @returns {string | null}
 */
function repositoryRelativeFile(value) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) return null;
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.includes("..") || normalized.startsWith("./") || normalized === ".") return null;
  return normalized;
}

/**
 * @param {string} eventFile
 * @returns {{ files: TimingFile[]; truncated: boolean }}
 */
function parseTimingEvents(eventFile) {
  const { text, truncated } = readBoundedEventFile(eventFile);
  /** @type {TimingFile[]} */
  const files = [];
  let markerSeen = false;
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "truncated") {
      markerSeen = true;
      continue;
    }
    if (!event || event.type !== "file") continue;
    const file = repositoryRelativeFile(event.file);
    const durationMs = finiteNonNegative(event.durationMs);
    if (file === null || durationMs === null) continue;
    files.push({
      suite: typeof event.suite === "string" ? event.suite : "unknown",
      file,
      durationMs: roundMs(durationMs),
      status: event.status === "passed" ? "passed" : "not-passed",
    });
  }
  files.sort(
    (left, right) => right.durationMs - left.durationMs || left.file.localeCompare(right.file),
  );
  return { files, truncated: truncated || markerSeen };
}

/**
 * @typedef {{ suite: string; file: string; durationMs: number; status: string }} TimingFile
 */

/**
 * @param {TimingCommandRecord} command
 * @returns {{ files: TimingFile[]; cumulativeFileTimeMs: number; eventDataTruncated: boolean }}
 */
function commandFiles(command) {
  const parsed = parseTimingEvents(command.eventFile);
  const cumulativeFileTimeMs = roundMs(
    parsed.files.reduce((total, file) => total + file.durationMs, 0),
  );
  return {
    files: parsed.files,
    cumulativeFileTimeMs,
    eventDataTruncated: parsed.truncated,
  };
}

/**
 * @typedef {{
 *   lane: string;
 *   suite: string;
 *   index: number;
 *   eventFile: string;
 *   startedAt: number;
 *   endedAt: number | null;
 *   status: string | null;
 * }} TimingCommandRecord
 */

/**
 * Create the in-process collector used by the CI shard and lane runners.
 * It writes one bounded JSON report after normal completion or cancellation;
 * raw event files are removed only after the report has been written.
 *
 * @param {TimingConfig} config
 * @param {{ now?: () => number }} [options]
 * @returns {TimingCollector}
 */
export function createCiTimingCollector(config, { now = () => performance.now() } = {}) {
  const startedAt = now();
  /** @type {Map<string, { name: string; startedAt: number; endedAt: number | null; ok: boolean | null }>} */
  const laneRecords = new Map();
  /** @type {TimingCommandRecord[]} */
  const commandRecords = [];
  /** @type {Set<TimingCommandRecord>} */
  const activeCommands = new Set();
  let cancellationSignal = null;
  let finalized = false;
  let finalResult = null;

  const startLane = (name) => {
    if (!laneRecords.has(name)) {
      laneRecords.set(name, { name, startedAt: now(), endedAt: null, ok: null });
    }
  };

  const endLane = (name, ok) => {
    const record = laneRecords.get(name);
    if (!record) return;
    if (record.endedAt === null) record.endedAt = now();
    record.ok = ok;
  };

  const startCommand = ({ lane, suite, index, eventFile }) => {
    startLane(lane);
    const command = {
      lane,
      suite,
      index,
      eventFile,
      startedAt: now(),
      endedAt: null,
      status: null,
    };
    commandRecords.push(command);
    activeCommands.add(command);
    return command;
  };

  const endCommand = (command, { ok, cancelled = false }) => {
    if (!command || command.endedAt !== null) return;
    command.endedAt = now();
    command.status = cancelled ? "cancelled" : ok ? "passed" : "failed";
    activeCommands.delete(command);
  };

  const buildReport = (exitCode) => {
    const currentTime = now();
    const lanes = [...laneRecords.values()].map((lane) => {
      const commands = commandRecords
        .filter((command) => command.lane === lane.name)
        .map((command) => {
          const eventData = commandFiles(command);
          const status =
            command.status ?? (cancellationSignal !== null ? "cancelled" : "incomplete");
          return {
            suite: command.suite,
            status,
            elapsedWallMs: roundMs((command.endedAt ?? currentTime) - command.startedAt),
            cumulativeFileTimeMs: eventData.cumulativeFileTimeMs,
            eventDataTruncated: eventData.eventDataTruncated,
            files: eventData.files,
          };
        });
      const status =
        lane.ok === true
          ? "passed"
          : cancellationSignal !== null
            ? "cancelled"
            : lane.ok === false
              ? "failed"
              : "incomplete";
      return {
        name: lane.name,
        status,
        elapsedWallMs: roundMs((lane.endedAt ?? currentTime) - lane.startedAt),
        commands,
      };
    });

    const cumulativeFileTimeMs = roundMs(
      lanes.reduce(
        (total, lane) =>
          total +
          lane.commands.reduce(
            (commandTotal, command) => commandTotal + command.cumulativeFileTimeMs,
            0,
          ),
        0,
      ),
    );
    const status = cancellationSignal !== null ? "cancelled" : exitCode === 0 ? "passed" : "failed";
    return {
      schemaVersion: CI_TIMINGS_SCHEMA_VERSION,
      reportType: "tlh-ci-test-timings",
      generatedAt: new Date().toISOString(),
      runId: config.runId,
      shard: config.shard,
      nodeVersion: config.nodeVersion,
      laneLayout: config.laneLayout,
      platform: { os: process.platform, arch: process.arch },
      availableCpuCount: config.availableCpuCount,
      effectiveConcurrency: config.effectiveConcurrency,
      concurrencySource: config.concurrencySource,
      status,
      exitCode,
      ...(cancellationSignal === null ? {} : { cancellationSignal }),
      elapsedWallMs: roundMs(currentTime - startedAt),
      cumulativeFileTimeMs,
      timingQualityNote:
        "elapsedWallMs is process wall time; cumulativeFileTimeMs is the sum of per-file Node durations and may exceed wall time when files run concurrently",
      lanes,
    };
  };

  const boundedPayload = (report) => {
    let candidate = report;
    let payload = JSON.stringify(candidate, null, 2) + "\n";
    if (Buffer.byteLength(payload) <= MAX_CI_TIMING_REPORT_BYTES) return payload;

    candidate = JSON.parse(JSON.stringify(report));
    candidate.reportTruncated = true;
    candidate.truncationNote =
      "Only the slowest per-file timings are retained after the report size cap.";
    let droppedFiles = 0;
    while (Buffer.byteLength(payload) > MAX_CI_TIMING_REPORT_BYTES) {
      let longest = null;
      for (const lane of candidate.lanes ?? []) {
        for (const command of lane.commands ?? []) {
          if (
            command.files.length > 0 &&
            (longest === null || command.files.length > longest.files.length)
          ) {
            longest = command;
          }
        }
      }
      if (longest === null) break;
      longest.files.pop();
      droppedFiles += 1;
      candidate.droppedFileCount = droppedFiles;
      payload = JSON.stringify(candidate, null, 2) + "\n";
    }
    if (Buffer.byteLength(payload) <= MAX_CI_TIMING_REPORT_BYTES) return payload;

    const fallback = {
      schemaVersion: CI_TIMINGS_SCHEMA_VERSION,
      reportType: "tlh-ci-test-timings",
      generatedAt: report.generatedAt,
      runId: config.runId,
      shard: config.shard,
      nodeVersion: config.nodeVersion,
      laneLayout: config.laneLayout,
      platform: report.platform,
      availableCpuCount: config.availableCpuCount,
      effectiveConcurrency: config.effectiveConcurrency,
      status: report.status,
      exitCode: report.exitCode,
      reportTruncated: true,
      truncationNote: "Report metadata exceeded the size cap; per-file details were omitted.",
      lanes: [],
    };
    return JSON.stringify(fallback) + "\n";
  };

  const writeReport = (exitCode) => {
    const report = buildReport(exitCode);
    const reportPath = join(
      config.directory,
      `${REPORT_FILE_PREFIX}${config.runId}-${safeComponent(config.shard)}${REPORT_FILE_SUFFIX}`,
    );
    const temporaryPath = `${reportPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, boundedPayload(report), { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, reportPath);
      for (const command of commandRecords) rmSync(command.eventFile, { force: true });
      finalResult = { report, reportPath, written: true, error: null };
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      finalResult = {
        report,
        reportPath,
        written: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
      process.stderr.write(
        `[tlh] could not write CI timing report: ${finalResult.error.message}\n`,
      );
    }
    return finalResult;
  };

  const finalize = (exitCode, { cancellation } = {}) => {
    if (finalized) return finalResult;
    finalized = true;
    if (cancellation !== undefined) cancellationSignal = cancellation;
    for (const command of activeCommands) {
      command.status = cancellationSignal === null ? "incomplete" : "cancelled";
      command.endedAt = now();
    }
    activeCommands.clear();
    return writeReport(exitCode);
  };

  return {
    enabled: true,
    startLane,
    endLane,
    startCommand,
    endCommand,
    finalize,
    onCancellation(signal) {
      cancellationSignal = signal;
      finalize(1, { cancellation: signal });
    },
  };
}

/**
 * @typedef {{
 *   enabled: true;
 *   startLane: (name: string) => void;
 *   endLane: (name: string, ok: boolean) => void;
 *   startCommand: (command: { lane: string; suite: string; index: number; eventFile: string }) => TimingCommandRecord;
 *   endCommand: (command: TimingCommandRecord, result: { ok: boolean; cancelled?: boolean }) => void;
 *   finalize: (exitCode: number, options?: { cancellation?: string }) => TimingResult;
 *   onCancellation: (signal: string) => void;
 * }} TimingCollector
 */

/**
 * @typedef {{
 *   report: Record<string, unknown>;
 *   reportPath: string;
 *   written: boolean;
 *   error: Error | null;
 * }} TimingResult
 */

/**
 * @param {TimingConfig} config
 * @param {{ suite: string; eventFile?: string; lane?: string; index?: number }} command
 * @returns {Record<string, string>}
 */
export function timingEnvironmentForCommand(config, command) {
  const eventFile =
    command.eventFile ??
    timingEventFile(config, {
      lane: command.lane ?? "unknown",
      index: command.index ?? 0,
      suite: command.suite,
    });
  return timingCommandEnvironment(config, { suite: command.suite, eventFile });
}

/**
 * @param {TimingConfig} config
 * @returns {string}
 */
export function timingReporterPath(config) {
  return join(config.repoRoot, "scripts", "ci-timing-reporter.mjs");
}

/**
 * Exposed for focused tests and the contributor reporter.
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isRepositoryRelativeTimingFile(file) {
  return repositoryRelativeFile(file) !== null;
}
