import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface MockPiResponse {
  output?: string;
  /** Raw stdout bytes written without appending a newline. */
  rawStdout?: string;
  stderr?: string;
  /** Raw stderr byte chunks, useful for testing split UTF-8 input. */
  stderrByteChunks?: number[][];
  exitCode?: number;
  delay?: number;
  keepAliveAfterFinalMessageMs?: number;
  ignoreSigterm?: boolean;
  ignoreSigint?: boolean;
  /** Cooperative child: write this marker on SIGTERM, then exit. */
  flushMarkerOnSigterm?: string;
  spawnStubbornDescendants?: boolean;
  /** Wait for this marker before spawning stubborn descendants. */
  stubbornDescendantStartMarker?: string;
  /** Wait for this marker after descendants start but before publishing the call. */
  stubbornDescendantCallMarker?: string;
  jsonl?: unknown[];
  /** Write a marker file at this path before any delay or jsonl output. */
  writeMarker?: string;
  /** Wait for a marker file at this path before any delay or jsonl output. */
  waitForMarker?: string;
  /** Write a marker file after the response output has been flushed. */
  writeMarkerAfter?: string;
  steps?: Array<{
    delay?: number;
    jsonl?: unknown[];
    stderr?: string;
    /** Write a marker file at this path before step delay/jsonl. */
    writeMarker?: string;
    /** Wait for a marker file at this path before step delay/jsonl. */
    waitForMarker?: string;
    /** Write a marker file after this step's output has been flushed. */
    writeMarkerAfter?: string;
  }>;
  echoEnv?: string[];
  matchArgIncludes?: string | string[];
}

export interface MockPi {
  readonly dir: string;
  install(): void;
  uninstall(): void;
  cleanup(): Promise<void>;
  onCall(response: MockPiResponse): void;
  reset(): void;
  callCount(): number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "mock-pi-script.mjs");
const CALL_PREFIX = "call-";
const DEFAULT_RESPONSE_FILE = "default-response.json";
const CURRENT_GENERATION_FILE = "current-generation.txt";
const QUEUED_PREFIX = "pending-";
const CLEANUP_INT_GRACE_MS = 250;
const CLEANUP_TERM_GRACE_MS = 250;
const CLEANUP_KILL_GRACE_MS = 2_000;
const CLEANUP_LATE_START_GRACE_MS = 500;
const CLEANUP_POLL_INTERVAL_MS = 25;

const CALL_RECORD_PATTERN = /^(?:call|stale-call)-\d+-(\d+)-.+\.json$/;
const DESCENDANT_RECORD_PATTERN = /^descendants-(\d+)\.json$/;
const OWNER_RECORD_PATTERN = /^owner-(\d+)\.json$/;
const EMERGENCY_EXIT_PATTERN = /^emergency-exit-(\d+)\.json$/;

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf-8");
  fs.chmodSync(filePath, 0o755);
}

function listQueueFiles(queueDir: string, prefix: string): string[] {
  try {
    return fs
      .readdirSync(queueDir)
      .filter((name) => name.startsWith(prefix))
      .sort();
  } catch {
    return [];
  }
}

function isMissingProcessError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ESRCH",
  );
}

function addOwnedPid(pids: Set<number>, value: unknown): void {
  const pid = typeof value === "string" ? Number(value) : value;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  pids.add(pid);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // Atomic publication may be in flight or the record may already be gone.
    return undefined;
  }
}

interface OwnershipScan {
  pids: Set<number>;
  pending: boolean;
  emergencyMarkers: string[];
}

function scanOwnership(queueDir: string): OwnershipScan {
  const scan: OwnershipScan = { pids: new Set(), pending: false, emergencyMarkers: [] };
  let entries: string[];
  try {
    entries = fs.readdirSync(queueDir);
  } catch {
    return scan;
  }

  for (const entry of entries) {
    const callMatch = entry.match(CALL_RECORD_PATTERN);
    if (callMatch) addOwnedPid(scan.pids, callMatch[1]);

    const ownerMatch = entry.match(OWNER_RECORD_PATTERN);
    if (ownerMatch) {
      addOwnedPid(scan.pids, ownerMatch[1]);
      const owner = readJsonRecord(path.join(queueDir, entry));
      if (owner?.state === "starting" || owner?.state === "spawning") scan.pending = true;
    }

    const descendantMatch = entry.match(DESCENDANT_RECORD_PATTERN);
    if (descendantMatch) {
      addOwnedPid(scan.pids, descendantMatch[1]);
      const record = readJsonRecord(path.join(queueDir, entry));
      if (record) {
        addOwnedPid(scan.pids, record.childPid);
        addOwnedPid(scan.pids, record.grandchildPid);
      }
    }

    if (EMERGENCY_EXIT_PATTERN.test(entry)) scan.emergencyMarkers.push(entry);
  }

  return scan;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) return false;
    throw error;
  }
}

function signalOwnedPids(pids: Iterable<number>, signal: NodeJS.Signals): Set<number> {
  const signaled = new Set<number>();
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      signaled.add(pid);
    } catch (error) {
      if (isMissingProcessError(error)) continue;
      throw error;
    }
  }
  return signaled;
}

async function waitForOwnedPidsExit(
  queueDir: string,
  pids: Set<number>,
  timeoutMs: number,
  signal: NodeJS.Signals,
  signaledPids: Set<number>,
): Promise<number[]> {
  const deadline = Date.now() + Math.max(timeoutMs, CLEANUP_LATE_START_GRACE_MS);
  let noLiveSince: number | undefined;
  while (true) {
    const scan = scanOwnership(queueDir);
    for (const pid of scan.pids) pids.add(pid);
    const live = [...pids].filter(isPidAlive);
    const lateLivePids = live.filter((pid) => !signaledPids.has(pid));
    for (const pid of signalOwnedPids(lateLivePids, signal)) signaledPids.add(pid);
    if (live.length === 0) {
      if (!scan.pending) return [];
      noLiveSince ??= Date.now();
      if (Date.now() - noLiveSince >= CLEANUP_LATE_START_GRACE_MS) return [];
    } else {
      noLiveSince = undefined;
    }
    if (Date.now() >= deadline) return live;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(CLEANUP_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))),
    );
  }
}

function throwIfEmergencyExpiry(queueDir: string): void {
  const markers = scanOwnership(queueDir).emergencyMarkers;
  if (markers.length > 0) {
    throw new Error(`Mock Pi descendant emergency expiry observed: ${markers.join(", ")}`);
  }
}

async function cleanupOwnedPids(queueDir: string): Promise<void> {
  const initialScan = scanOwnership(queueDir);
  const ownedPids = initialScan.pids;
  if (ownedPids.size === 0) {
    throwIfEmergencyExpiry(queueDir);
    return;
  }

  let signaledPids = signalOwnedPids(ownedPids, "SIGINT");
  let live = await waitForOwnedPidsExit(
    queueDir,
    ownedPids,
    CLEANUP_INT_GRACE_MS,
    "SIGINT",
    signaledPids,
  );
  if (live.length === 0) {
    throwIfEmergencyExpiry(queueDir);
    return;
  }

  const termScan = scanOwnership(queueDir);
  for (const pid of termScan.pids) ownedPids.add(pid);
  live = [...ownedPids].filter(isPidAlive);
  signaledPids = signalOwnedPids(live, "SIGTERM");
  live = await waitForOwnedPidsExit(
    queueDir,
    ownedPids,
    CLEANUP_TERM_GRACE_MS,
    "SIGTERM",
    signaledPids,
  );
  if (live.length === 0) {
    throwIfEmergencyExpiry(queueDir);
    return;
  }

  const killScan = scanOwnership(queueDir);
  for (const pid of killScan.pids) ownedPids.add(pid);
  live = [...ownedPids].filter(isPidAlive);
  signaledPids = signalOwnedPids(live, "SIGKILL");
  live = await waitForOwnedPidsExit(
    queueDir,
    ownedPids,
    CLEANUP_KILL_GRACE_MS,
    "SIGKILL",
    signaledPids,
  );
  if (live.length > 0) {
    throw new Error(`Mock Pi fixture could not reap owned processes: ${live.join(", ")}`);
  }
  throwIfEmergencyExpiry(queueDir);
}

function writeAtomicJson(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tempPath, JSON.stringify(value), "utf-8");
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the publication error if cleanup also fails.
    }
    throw error;
  }
}

export function createMockPi(): MockPi {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mock-cli-"));
  const queueDir = path.join(rootDir, "queue");
  const binDir = path.join(rootDir, "bin");
  const packageRoot = path.join(rootDir, "pi-coding-agent");
  const cliScriptPath = path.join(packageRoot, "dist", "cli.mjs");
  ensureDir(queueDir);
  ensureDir(binDir);
  ensureDir(path.dirname(cliScriptPath));

  const shellScriptPath = path.join(binDir, "pi");
  const cmdScriptPath = path.join(binDir, "pi.cmd");
  writeExecutable(shellScriptPath, `#!/bin/sh\nexec "${process.execPath}" "${SCRIPT_PATH}" "$@"\n`);
  writeExecutable(cmdScriptPath, `@echo off\r\n"${process.execPath}" "${SCRIPT_PATH}" %*\r\n`);
  writeExecutable(
    cliScriptPath,
    `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(SCRIPT_PATH).href)};\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      bin: { pi: "dist/cli.mjs" },
    }),
    "utf-8",
  );

  let installed = false;
  let nextSequence = 0;
  let generation = 0;
  let originalPath: string | undefined;
  let originalArgv1: string | undefined;
  let originalQueueEnv: string | undefined;
  let originalGenerationEnv: string | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let cleanupFailed = false;

  const publishGeneration = () => {
    ensureDir(queueDir);
    fs.writeFileSync(path.join(queueDir, CURRENT_GENERATION_FILE), String(generation), "utf-8");
    process.env.MOCK_PI_GENERATION = String(generation);
  };

  const hasSurvivingOwnershipEvidence = (): boolean =>
    cleanupFailed || scanOwnership(queueDir).emergencyMarkers.length > 0;

  return {
    get dir() {
      return queueDir;
    },
    install() {
      if (installed) return;
      installed = true;
      originalPath = process.env.PATH;
      originalQueueEnv = process.env.MOCK_PI_QUEUE_DIR;
      originalGenerationEnv = process.env.MOCK_PI_GENERATION;
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
      process.env.MOCK_PI_QUEUE_DIR = queueDir;
      publishGeneration();
      originalArgv1 = process.argv[1];
      process.argv[1] = cliScriptPath;
    },
    uninstall() {
      if (!installed) return;
      const preserveEvidence = hasSurvivingOwnershipEvidence();
      installed = false;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalQueueEnv === undefined) delete process.env.MOCK_PI_QUEUE_DIR;
      else process.env.MOCK_PI_QUEUE_DIR = originalQueueEnv;
      if (originalGenerationEnv === undefined) delete process.env.MOCK_PI_GENERATION;
      else process.env.MOCK_PI_GENERATION = originalGenerationEnv;
      if (originalArgv1 === undefined) delete process.argv[1];
      else process.argv[1] = originalArgv1;
      if (preserveEvidence) return;
      try {
        fs.rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // Test cleanup is best effort.
      }
    },
    cleanup() {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = cleanupOwnedPids(queueDir)
        .then(() => {
          cleanupFailed = false;
        })
        .catch((error: unknown) => {
          cleanupFailed = true;
          throw error;
        })
        .finally(() => {
          cleanupPromise = undefined;
        });
      return cleanupPromise;
    },
    onCall(response) {
      ensureDir(queueDir);
      nextSequence += 1;
      const fileName = `${QUEUED_PREFIX}${String(nextSequence).padStart(6, "0")}.json`;
      const tempPath = path.join(queueDir, `${fileName}.tmp-${process.pid}-${Date.now()}`);
      const finalPath = path.join(queueDir, fileName);
      fs.writeFileSync(tempPath, JSON.stringify(response), "utf-8");
      fs.renameSync(tempPath, finalPath);
      writeAtomicJson(path.join(queueDir, DEFAULT_RESPONSE_FILE), response);
    },
    reset() {
      if (cleanupFailed) {
        throw new Error(
          "Mock Pi fixture cleanup failed; refusing to delete surviving ownership evidence.",
        );
      }
      nextSequence = 0;
      generation += 1;
      publishGeneration();
      for (const entry of fs.readdirSync(queueDir)) {
        if (entry === CURRENT_GENERATION_FILE) continue;
        try {
          fs.rmSync(path.join(queueDir, entry), { recursive: true, force: true });
        } catch {
          // A concurrent fixture cleanup may already have removed this entry.
        }
      }
    },
    callCount() {
      return listQueueFiles(queueDir, CALL_PREFIX).length;
    },
  };
}
