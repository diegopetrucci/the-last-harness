import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { allocateChildSessionFile } from "../../src/runs/shared/session-path.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";
import { runSingleStep } from "../../src/runs/background/single-step-execution.ts";
import { createMockPi, makeRunnerStep, type MockPi } from "../support/helpers.ts";

describe("allocateChildSessionFile", () => {
  it("returns distinct canonical Pi-style paths without creating the file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-path-"));
    try {
      const link = path.join(root, "link");
      fs.mkdirSync(path.join(root, "real"));
      fs.symlinkSync(path.join(root, "real"), link);
      const now = new Date("2026-01-02T03:04:05.678Z");
      const first = allocateChildSessionFile(path.join(link, "nested"), now);
      const second = allocateChildSessionFile(path.join(link, "nested"), now);
      assert.notEqual(first, second);
      for (const file of [first, second]) {
        assert.equal(path.dirname(file), fs.realpathSync(path.join(root, "real", "nested")));
        assert.match(path.basename(file), /^2026-01-02T03-04-05-678Z_[0-9a-f-]{36}\.jsonl$/);
        assert.equal(fs.existsSync(file), false);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("launches Pi with --session for a pre-assigned path instead of --session-dir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-path-"));
    try {
      const file = allocateChildSessionFile(path.join(root, "dir"));
      const { args } = buildPiArgs({
        baseArgs: ["--mode", "json", "-p"],
        task: "t",
        sessionEnabled: true,
        sessionDir: path.join(root, "dir"),
        sessionFile: file,
        inheritProjectContext: false,
        inheritSkills: false,
      });
      assert.equal(args[args.indexOf("--session") + 1], file);
      assert.equal(args.includes("--session-dir"), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fresh child attempts", () => {
  let mockPi: MockPi;
  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });
  after(() => mockPi.uninstall());
  beforeEach(() => mockPi.reset());

  it("launch each fallback attempt with its own pre-assigned --session file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-path-run-"));
    try {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "primary failed" }],
              model: "mock/a",
              errorMessage: "rate limit exceeded",
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
            },
          },
        ],
        exitCode: 1,
      });
      mockPi.onCall({ output: "ok" });
      const sessionDir = path.join(root, "sessions");
      const reported: string[] = [];
      const result = await runSingleStep(
        makeRunnerStep("worker", "do it", { modelCandidates: ["mock/a", "mock/b"] }),
        {
          cwd: root,
          sessionEnabled: true,
          sessionDir,
          artifactConfig: {
            mode: "compact",
            enabled: false,
            includeInput: false,
            includeOutput: false,
            includeJsonl: false,
            includeTranscript: false,
            includeMetadata: false,
            includeChildEventProjections: false,
            cleanupDays: 7,
          },
          id: "session-path-run",
          flatIndex: 0,
          flatStepCount: 1,
          outputFile: path.join(root, "output.log"),
          onAttemptSessionFile: (file) => reported.push(file),
        },
        () => undefined,
      );

      const launched = fs
        .readdirSync(mockPi.dir)
        .filter((name) => name.startsWith("call-"))
        .map((name) => JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")).args)
        .map((args: string[]) => {
          assert.equal(args.includes("--session-dir"), false);
          return args[args.indexOf("--session") + 1];
        });
      assert.equal(launched.length, 2);
      assert.notEqual(launched[0], launched[1]);
      assert.deepEqual([...launched].sort(), [...reported].sort());
      assert.equal(result.sessionFile, reported[1]);
      for (const file of reported) {
        assert.equal(path.dirname(file), fs.realpathSync(sessionDir));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
