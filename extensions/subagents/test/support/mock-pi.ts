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
  spawnStubbornDescendants?: boolean;
  jsonl?: unknown[];
  /** Write a marker file at this path before any delay or jsonl output. */
  writeMarker?: string;
  /** Wait for a marker file at this path before any delay or jsonl output. */
  waitForMarker?: string;
  steps?: Array<{
    delay?: number;
    jsonl?: unknown[];
    stderr?: string;
    /** Write a marker file at this path before step delay/jsonl. */
    writeMarker?: string;
    /** Wait for a marker file at this path before step delay/jsonl. */
    waitForMarker?: string;
  }>;
  echoEnv?: string[];
  matchArgIncludes?: string | string[];
}

export interface MockPi {
  readonly dir: string;
  install(): void;
  uninstall(): void;
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

  const publishGeneration = () => {
    ensureDir(queueDir);
    fs.writeFileSync(path.join(queueDir, CURRENT_GENERATION_FILE), String(generation), "utf-8");
    process.env.MOCK_PI_GENERATION = String(generation);
  };

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
      installed = false;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalQueueEnv === undefined) delete process.env.MOCK_PI_QUEUE_DIR;
      else process.env.MOCK_PI_QUEUE_DIR = originalQueueEnv;
      if (originalGenerationEnv === undefined) delete process.env.MOCK_PI_GENERATION;
      else process.env.MOCK_PI_GENERATION = originalGenerationEnv;
      if (originalArgv1 === undefined) delete process.argv[1];
      else process.argv[1] = originalArgv1;
      try {
        fs.rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // Test cleanup is best effort.
      }
    },
    onCall(response) {
      ensureDir(queueDir);
      nextSequence += 1;
      const fileName = `${QUEUED_PREFIX}${String(nextSequence).padStart(6, "0")}.json`;
      const tempPath = path.join(queueDir, `${fileName}.tmp-${process.pid}-${Date.now()}`);
      const finalPath = path.join(queueDir, fileName);
      fs.writeFileSync(tempPath, JSON.stringify(response), "utf-8");
      fs.renameSync(tempPath, finalPath);
      fs.writeFileSync(
        path.join(queueDir, DEFAULT_RESPONSE_FILE),
        JSON.stringify(response),
        "utf-8",
      );
    },
    reset() {
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
