import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";
import {
  pausedCheckedAcceptance,
  skippedPausedAcceptanceLedger,
} from "../support/async-resume-fixtures.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import type {
  ContextPressureProjection,
  SubagentModelIdentity,
  SubagentModelResolution,
} from "../../src/shared/types.ts";

describe("async resume lookup", () => {
  it("resolves a completed single-child run from persisted status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-abc", "status.json"), {
        runId: "run-abc",
        mode: "single",
        state: "complete",
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 200,
        cwd: root,
        sessionFile,
        steps: [
          {
            agent: "worker",
            status: "complete",
            contextPressureCrossedThresholds: ["warning", "critical"],
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-a" },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );

      assert.equal(target.kind, "revive");
      assert.equal(target.runId, "run-abc");
      assert.equal(target.agent, "worker");
      assert.equal(target.sessionFile, sessionFile);
      assert.equal(target.cwd, root);
      assert.equal(target.continuationAcceptance, undefined);
      assert.deepEqual(target.contextPressureCrossedThresholds, ["warning", "critical"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries safe project provenance/config into resume targets and rejects corruption", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-project-agent-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      const projectAgent = {
        provenance: {
          projectRoot: root,
          sessionId: "session-project",
          generationId: "generation-project",
          processInstanceId: "process-project",
          source: "project" as const,
          agent: "embedded.worker",
          digest: "digest-project",
        },
        config: {
          name: "embedded.worker",
          description: "Captured project agent",
          systemPrompt: "Captured prompt",
          systemPromptMode: "replace" as const,
          inheritProjectContext: false,
          inheritSkills: false,
          source: "project" as const,
          filePath: path.join(root, ".tlh", "agents", "worker.md"),
          packageName: "embedded",
          tools: ["read"],
        },
      };
      writeJson(path.join(asyncRoot, "run-project", "status.json"), {
        runId: "run-project",
        mode: "single",
        state: "paused",
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 200,
        cwd: root,
        steps: [
          {
            agent: "embedded.worker",
            status: "paused",
            sessionFile,
            projectAgent,
            acceptance: skippedPausedAcceptanceLedger(),
          },
        ],
      });
      const target = resolveAsyncResumeTarget(
        { id: "run-project" },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
        { readOnly: true },
      );
      assert.deepEqual(target.projectAgent, projectAgent);

      writeJson(path.join(asyncRoot, "run-corrupt", "status.json"), {
        runId: "run-corrupt",
        mode: "single",
        state: "paused",
        startedAt: 100,
        cwd: root,
        steps: [
          {
            agent: "embedded.worker",
            status: "paused",
            sessionFile,
            projectAgent: { ...projectAgent, config: { ...projectAgent.config, source: "user" } },
            acceptance: skippedPausedAcceptanceLedger(),
          },
        ],
      });
      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-corrupt" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
            { readOnly: true },
          ),
        /projectAgent is invalid|project-agent capture/i,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores canonical child model identity from status and result-only artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-model-identity-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const statusSession = path.join(root, "status.jsonl");
      const resultSession = path.join(root, "result.jsonl");
      fs.writeFileSync(statusSession, "", "utf-8");
      fs.writeFileSync(resultSession, "", "utf-8");
      const identity: SubagentModelIdentity = {
        provider: "anthropic",
        model: "claude-sonnet-4",
        thinking: "high",
      };
      const resolution: SubagentModelResolution = {
        kind: "restored",
        original: identity,
        resumed: identity,
        reason: "Restored persisted child selection instead of the current parent model.",
      };
      writeJson(path.join(asyncRoot, "run-status-model", "status.json"), {
        runId: "run-status-model",
        mode: "single",
        state: "complete",
        startedAt: 100,
        lastUpdate: 200,
        cwd: root,
        steps: [
          {
            agent: "worker",
            status: "complete",
            sessionFile: statusSession,
            model: "anthropic/claude-sonnet-4:high",
            thinking: "high",
            modelIdentity: identity,
            modelResolution: resolution,
          },
        ],
      });
      const statusTarget = resolveAsyncResumeTarget(
        { id: "run-status-model" },
        { asyncDirRoot: asyncRoot, resultsDir },
      );
      assert.deepEqual(statusTarget.modelIdentity, identity);
      assert.deepEqual(statusTarget.modelResolution, resolution);

      writeJson(path.join(resultsDir, "run-result-model.json"), {
        id: "run-result-model",
        agent: "worker",
        success: true,
        state: "complete",
        cwd: root,
        results: [
          {
            agent: "worker",
            success: true,
            sessionFile: resultSession,
            model: "anthropic/claude-sonnet-4:high",
            thinking: "high",
            modelIdentity: identity,
            modelResolution: resolution,
          },
        ],
      });
      const resultTarget = resolveAsyncResumeTarget(
        { id: "run-result-model" },
        { asyncDirRoot: path.join(root, "missing-runs"), resultsDir },
      );
      assert.deepEqual(resultTarget.modelIdentity, identity);
      assert.deepEqual(resultTarget.modelResolution, resolution);

      writeJson(path.join(resultsDir, "run-result-model-strings.json"), {
        id: "run-result-model-strings",
        agent: "worker",
        success: true,
        state: "complete",
        cwd: root,
        results: [
          {
            agent: "worker",
            success: true,
            sessionFile: resultSession,
            model: "anthropic/claude-sonnet-4",
            thinking: "high",
          },
        ],
      });
      const derivedTarget = resolveAsyncResumeTarget(
        { id: "run-result-model-strings" },
        { asyncDirRoot: path.join(root, "missing-runs"), resultsDir },
      );
      assert.deepEqual(derivedTarget.modelIdentity, identity);
      assert.equal(derivedTarget.modelResolution, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes invalid result thinking while preserving nested model resolution identities", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-thinking-boundary-"));
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "legacy.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(resultsDir, "run-thinking-boundary.json"), {
        id: "run-thinking-boundary",
        agent: "worker",
        success: true,
        state: "complete",
        results: [
          {
            agent: "worker",
            sessionFile,
            thinking: "",
            modelIdentity: { provider: "openai", model: "gpt-5", thinking: "turbo" },
            modelResolution: {
              kind: "fallback",
              original: { provider: "openai", model: "gpt-5", thinking: "xhigh" },
              resumed: { provider: "anthropic", model: "claude-sonnet-4", thinking: "max" },
              reason: "provider fallback",
            },
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-thinking-boundary" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );

      assert.deepEqual(target.modelIdentity, { provider: "openai", model: "gpt-5" });
      assert.deepEqual(target.modelResolution, {
        kind: "fallback",
        original: { provider: "openai", model: "gpt-5", thinking: "xhigh" },
        resumed: { provider: "anthropic", model: "claude-sonnet-4", thinking: "max" },
        reason: "provider fallback",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes status model identity and nested resolution before resume target construction", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-status-boundary-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "status.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-status-boundary", "status.json"), {
        runId: "run-status-boundary",
        mode: "single",
        state: "complete",
        startedAt: 100,
        lastUpdate: 200,
        steps: [
          {
            agent: "worker",
            status: "complete",
            sessionFile,
            model: "openai/gpt-5",
            thinking: "turbo",
            modelIdentity: { provider: "openai", model: "gpt-5", thinking: "" },
            modelResolution: {
              kind: "fallback",
              original: { provider: "openai", model: "gpt-5", thinking: "turbo" },
              resumed: { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" },
              reason: "provider fallback",
            },
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-status-boundary" },
        { asyncDirRoot: asyncRoot, resultsDir },
      );

      assert.deepEqual(target.modelIdentity, { provider: "openai", model: "gpt-5" });
      assert.deepEqual(target.modelResolution, {
        kind: "fallback",
        original: { provider: "openai", model: "gpt-5" },
        resumed: { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" },
        reason: "provider fallback",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves cumulative active runtime without counting paused wall time", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-active-runtime-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "paused.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-paused", "status.json"), {
        runId: "run-paused",
        mode: "single",
        state: "paused",
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 10_000_000,
        cwd: root,
        sessionFile,
        pause: { kind: "awaiting_supervisor", pausedAt: 200 },
        steps: [
          {
            agent: "worker",
            status: "paused",
            sessionFile,
            activeRuntimeMs: 75,
            pause: { kind: "awaiting_supervisor", pausedAt: 200 },
            acceptance: skippedPausedAcceptanceLedger(),
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-paused" },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results"), now: () => 20_000_000 },
      );

      assert.equal(target.activeRuntimeMs, 75);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes each runtime field before applying per-field status/result fallback", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-runtime-precedence-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const statusSessionA = path.join(root, "status-a.jsonl");
      const statusSessionB = path.join(root, "status-b.jsonl");
      const resultSessionA = path.join(root, "result-a.jsonl");
      const resultSessionB = path.join(root, "result-b.jsonl");
      for (const sessionFile of [statusSessionA, statusSessionB, resultSessionA, resultSessionB]) {
        fs.writeFileSync(sessionFile, "", "utf-8");
      }
      writeJson(path.join(asyncRoot, "run-runtime-precedence", "status.json"), {
        runId: "run-runtime-precedence",
        mode: "parallel",
        state: "complete",
        startedAt: 100,
        cwd: root,
        steps: [
          {
            agent: "status-runtime",
            status: "complete",
            sessionFile: statusSessionA,
            activeRuntimeMs: 100.25,
            activeRuntimeCheckpointAt: -1,
          },
          {
            agent: "status-checkpoint",
            status: "complete",
            sessionFile: statusSessionB,
            activeRuntimeCheckpointAt: 200.75,
          },
        ],
      });
      writeJson(path.join(resultsDir, "run-runtime-precedence.json"), {
        id: "run-runtime-precedence",
        agent: "result-runtime",
        success: true,
        state: "complete",
        cwd: root,
        results: [
          {
            agent: "result-checkpoint",
            success: true,
            sessionFile: resultSessionA,
            activeRuntimeMs: 900.25,
            activeRuntimeCheckpointAt: 800.75,
          },
          {
            agent: "result-runtime",
            success: true,
            sessionFile: resultSessionB,
            activeRuntimeMs: 700.25,
            activeRuntimeCheckpointAt: 900.75,
          },
        ],
      });

      const statusRuntimeTarget = resolveAsyncResumeTarget(
        { id: "run-runtime-precedence", index: 0 },
        { asyncDirRoot: asyncRoot, resultsDir },
        { readOnly: true },
      );
      assert.equal(statusRuntimeTarget.activeRuntimeMs, 101);
      // The malformed status checkpoint is normalized away before the valid
      // result checkpoint is selected as the per-field fallback.
      assert.equal(statusRuntimeTarget.activeRuntimeCheckpointAt, 800);

      const statusCheckpointTarget = resolveAsyncResumeTarget(
        { id: "run-runtime-precedence", index: 1 },
        { asyncDirRoot: asyncRoot, resultsDir },
        { readOnly: true },
      );
      assert.equal(statusCheckpointTarget.activeRuntimeMs, 701);
      assert.equal(statusCheckpointTarget.activeRuntimeCheckpointAt, 200);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits malformed result-only runtime checkpoints without weakening valid runtime evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-checkpoint-"));
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "result-checkpoint.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(resultsDir, "run-result-checkpoint.json"), {
        id: "run-result-checkpoint",
        agent: "worker",
        success: true,
        state: "complete",
        cwd: root,
        results: [
          {
            agent: "worker",
            success: true,
            sessionFile,
            activeRuntimeMs: 125.25,
            activeRuntimeCheckpointAt: -1,
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-result-checkpoint" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      assert.equal(target.activeRuntimeMs, 126);
      assert.equal(target.activeRuntimeCheckpointAt, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports selected-child success independently of aggregate cohort state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-selected-success-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const successfulSession = path.join(root, "successful.jsonl");
      const failedSession = path.join(root, "failed.jsonl");
      fs.writeFileSync(successfulSession, "", "utf-8");
      fs.writeFileSync(failedSession, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-selected-success", "status.json"), {
        runId: "run-selected-success",
        mode: "parallel",
        state: "failed",
        startedAt: 100,
        cwd: root,
        steps: [
          { agent: "successful", status: "complete", sessionFile: successfulSession },
          { agent: "failed", status: "failed", sessionFile: failedSession },
        ],
      });

      const successfulTarget = resolveAsyncResumeTarget(
        { id: "run-selected-success", index: 0 },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
        { readOnly: true },
      );
      assert.equal(successfulTarget.successfulCompletion, true);

      const failedTarget = resolveAsyncResumeTarget(
        { id: "run-selected-success", index: 1 },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
        { readOnly: true },
      );
      assert.equal(failedTarget.successfulCompletion, false);

      writeJson(path.join(asyncRoot, "run-selected-failed-complete", "status.json"), {
        runId: "run-selected-failed-complete",
        mode: "parallel",
        state: "complete",
        startedAt: 100,
        cwd: root,
        steps: [{ agent: "failed", status: "failed", sessionFile: failedSession }],
      });
      const failedChildInCompleteRun = resolveAsyncResumeTarget(
        { id: "run-selected-failed-complete", index: 0 },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
        { readOnly: true },
      );
      assert.equal(failedChildInCompleteRun.successfulCompletion, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses result-only child success when no status artifact is available", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-success-"));
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "result-success.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(resultsDir, "run-result-success.json"), {
        id: "run-result-success",
        agent: "worker",
        success: false,
        state: "failed",
        cwd: root,
        results: [{ agent: "worker", success: true, sessionFile }],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-result-success" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      assert.equal(target.successfulCompletion, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to aggregate completion for legacy single-child result artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-legacy-success-"));
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "legacy-success.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(resultsDir, "run-legacy-success.json"), {
        id: "run-legacy-success",
        agent: "worker",
        success: true,
        state: "complete",
        cwd: root,
        sessionFile,
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-legacy-success" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      assert.equal(target.successfulCompletion, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous run id prefixes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-ambiguous-"));
    try {
      const asyncRoot = path.join(root, "runs");
      writeJson(path.join(asyncRoot, "run-aa", "status.json"), {
        runId: "run-aa",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "scout", status: "running" }],
      });
      writeJson(path.join(asyncRoot, "run-ab", "status.json"), {
        runId: "run-ab",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-a" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /Ambiguous async run id prefix 'run-a' matched: run-aa, run-ab/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects path-like ids and directories outside the async root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paths-"));
    try {
      const asyncRoot = path.join(root, "runs");
      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "../run" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /id must be an async run id or prefix, not a path/,
      );
      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { dir: path.join(root, "outside") },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /Async run directory must be inside/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps terminal follow-up resumes strict when the persisted session file is absent", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-async-resume-terminal-missing-session-"),
    );
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "missing.jsonl");
      writeJson(path.join(asyncRoot, "run-terminal-missing-session", "status.json"), {
        runId: "run-terminal-missing-session",
        mode: "single",
        state: "complete",
        startedAt: 100,
        lastUpdate: 200,
        sessionFile,
        steps: [{ agent: "worker", status: "complete", sessionFile }],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-terminal-missing-session" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /session file does not exist/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps completed children strict when an overall paused run has a missing session file", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-async-resume-paused-terminal-missing-session-"),
    );
    try {
      const asyncRoot = path.join(root, "runs");
      const completedSessionFile = path.join(root, "missing-completed.jsonl");
      const pausedSessionFile = path.join(root, "missing-paused.jsonl");
      writeJson(path.join(asyncRoot, "run-paused-terminal-missing-session", "status.json"), {
        runId: "run-paused-terminal-missing-session",
        mode: "parallel",
        state: "paused",
        startedAt: 100,
        lastUpdate: 200,
        steps: [
          { agent: "worker-a", status: "complete", sessionFile: completedSessionFile },
          {
            agent: "worker-b",
            status: "paused",
            sessionFile: pausedSessionFile,
            acceptance: { status: "skipped", effectiveAcceptance: { level: "checked" } },
          },
        ],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-paused-terminal-missing-session", index: 0 },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /session file does not exist/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-jsonl session files before reviving", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-session-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "session.txt");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-session", "status.json"), {
        runId: "run-session",
        mode: "single",
        state: "complete",
        startedAt: 100,
        lastUpdate: 200,
        sessionFile,
        steps: [{ agent: "worker", status: "complete" }],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-session" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /session file must be a \.jsonl file/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed result metadata before using session fields", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-result-"));
    try {
      const resultsDir = path.join(root, "results");
      writeJson(path.join(resultsDir, "run-result.json"), {
        id: "run-result",
        agent: "worker",
        success: true,
        state: "complete",
        results: [{ agent: "worker", sessionFile: { path: "session.jsonl" } }],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-result" },
            { asyncDirRoot: path.join(root, "runs"), resultsDir },
          ),
        /results\[0\].sessionFile must be a string/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes malformed optional result diagnostics during result-only recovery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-diagnostics-"));
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "legacy.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(resultsDir, "run-legacy.json"), {
        id: "run-legacy",
        agent: "worker",
        success: false,
        state: "paused",
        results: [
          {
            agent: "worker",
            interrupted: true,
            success: false,
            exitCode: 0,
            sessionFile,
            contextUsage: { contextTokens: "legacy-invalid" },
            terminationReason: "legacy-invalid",
            modelIdentity: { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" },
            modelResolution: { kind: "invalid", reason: 42 },
            acceptance: skippedPausedAcceptanceLedger(),
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-legacy" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      assert.equal(target.kind, "revive");
      assert.equal(target.state, "paused");
      assert.equal(target.sessionFile, sessionFile);
      assert.equal(target.contextUsage, undefined);
      assert.equal(target.terminationReason, undefined);
      assert.deepEqual(target.modelIdentity, {
        provider: "anthropic",
        model: "claude-sonnet-4",
        thinking: "high",
      });
      assert.equal(target.modelResolution, undefined);
      assert.deepEqual(target.continuationAcceptance, pausedCheckedAcceptance);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed status session ids", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-session-id-"));
    try {
      const asyncRoot = path.join(root, "runs");
      writeJson(path.join(asyncRoot, "run-session-id", "status.json"), {
        runId: "run-session-id",
        sessionId: { value: "session" },
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-session-id" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /sessionId must be a string/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed steps[].activeRuntimeMs in status (negative)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-bad-runtime-neg-"));
    try {
      const asyncRoot = path.join(root, "runs");
      writeJson(path.join(asyncRoot, "run-bad-runtime-neg", "status.json"), {
        runId: "run-bad-runtime-neg",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running", activeRuntimeMs: -1 }],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-bad-runtime-neg" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /steps\[0\]\.activeRuntimeMs must be a non-negative finite number/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed steps[].activeRuntimeMs in status (string)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-bad-runtime-str-"));
    try {
      const asyncRoot = path.join(root, "runs");
      // Write raw JSON directly: a string value is genuinely persistable and cannot
      // be expressed through the typed fixture helper.
      const dir = path.join(asyncRoot, "run-bad-runtime-str");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "status.json"),
        JSON.stringify({
          runId: "run-bad-runtime-str",
          mode: "single",
          state: "running",
          startedAt: 100,
          steps: [{ agent: "worker", status: "running", activeRuntimeMs: "500ms" }],
        }),
        "utf-8",
      );

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-bad-runtime-str" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /steps\[0\]\.activeRuntimeMs must be a non-negative finite number/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed steps[].activeRuntimeMs in status (null)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-bad-runtime-null-"));
    try {
      const asyncRoot = path.join(root, "runs");
      // Write raw JSON directly: null is the persistable form produced by
      // JSON.stringify for NaN/Infinity, covering the case where a corrupt writer
      // emits an explicit null budget field.
      const dir = path.join(asyncRoot, "run-bad-runtime-null");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "status.json"),
        JSON.stringify({
          runId: "run-bad-runtime-null",
          mode: "single",
          state: "running",
          startedAt: 100,
          steps: [{ agent: "worker", status: "running", activeRuntimeMs: null }],
        }),
        "utf-8",
      );

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-bad-runtime-null" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /steps\[0\]\.activeRuntimeMs must be a non-negative finite number/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed steps[].activeRuntimeMs in status (object)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-bad-runtime-obj-"));
    try {
      const asyncRoot = path.join(root, "runs");
      // Write raw JSON directly: an object shape is a genuinely persistable
      // non-integer value that a corrupt writer could produce.
      const dir = path.join(asyncRoot, "run-bad-runtime-obj");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "status.json"),
        JSON.stringify({
          runId: "run-bad-runtime-obj",
          mode: "single",
          state: "running",
          startedAt: 100,
          steps: [{ agent: "worker", status: "running", activeRuntimeMs: { ms: 500 } }],
        }),
        "utf-8",
      );

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-bad-runtime-obj" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /steps\[0\]\.activeRuntimeMs must be a non-negative finite number/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts valid steps[].activeRuntimeMs with malformed activeRuntimeCheckpointAt in status", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-valid-runtime-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "valid-runtime.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      // activeRuntimeCheckpointAt: -999 is a malformed (negative) but persistable
      // value. It must NOT be strictly rejected — it is only normalized away
      // (checkpoint metadata cannot widen a budget). Resume must still succeed
      // with activeRuntimeMs intact and the checkpoint omitted from the target.
      writeJson(path.join(asyncRoot, "run-valid-runtime", "status.json"), {
        runId: "run-valid-runtime",
        mode: "single",
        state: "complete",
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 200,
        cwd: root,
        sessionFile,
        steps: [
          {
            agent: "worker",
            status: "complete",
            activeRuntimeMs: 500,
            activeRuntimeCheckpointAt: -999,
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-valid-runtime" },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );
      assert.equal(target.kind, "revive");
      assert.equal(target.activeRuntimeMs, 500);
      // Malformed checkpoint is normalized to undefined, not strictly rejected.
      assert.equal(target.activeRuntimeCheckpointAt, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("revives a completed child by index while a sibling async child is still running", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-partial-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "done.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-partial", "status.json"), {
        runId: "run-partial",
        mode: "parallel",
        state: "running",
        startedAt: 100,
        lastUpdate: 200,
        steps: [
          { agent: "done", status: "complete", sessionFile },
          { agent: "active", status: "running" },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-partial", index: 0 },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );
      assert.equal(target.kind, "revive");
      assert.equal(target.agent, "done");
      assert.equal(target.sessionFile, sessionFile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects pending indexed children in still-running async runs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-pending-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const sessionFile = path.join(root, "pending.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-pending", "status.json"), {
        runId: "run-pending",
        mode: "parallel",
        state: "running",
        startedAt: 100,
        lastUpdate: 200,
        steps: [
          { agent: "active", status: "running" },
          { agent: "later", status: "pending", sessionFile },
        ],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-pending", index: 1 },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /pending and has not started yet/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a completed multi-child run when an index and per-child session file are available", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-multi-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const firstSession = path.join(root, "a.jsonl");
      const secondSession = path.join(root, "b.jsonl");
      fs.writeFileSync(firstSession, "", "utf-8");
      fs.writeFileSync(secondSession, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-multi", "status.json"), {
        runId: "run-multi",
        mode: "parallel",
        state: "complete",
        startedAt: 100,
        lastUpdate: 200,
        steps: [
          { agent: "a", status: "complete", sessionFile: firstSession },
          { agent: "b", status: "complete", sessionFile: secondSession },
        ],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-multi" },
            { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
          ),
        /Provide index to choose one/,
      );
      const target = resolveAsyncResumeTarget(
        { id: "run-multi", index: 1 },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );
      assert.equal(target.kind, "revive");
      assert.equal(target.agent, "b");
      assert.equal(target.index, 1);
      assert.equal(target.sessionFile, secondSession);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("result-only single revival falls back to sanitized root pressure diagnostics", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-root-pressure-"));
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "result-only-pressure.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      const contextPressure: ContextPressureProjection = {
        severity: "warning",
        crossedThreshold: "warning",
        contextTokens: 800,
        contextWindow: 1000,
        contextPercent: 80,
        remainingTokens: 200,
        warnedAt: 123,
      };
      writeJson(path.join(resultsDir, "run-root-pressure.json"), {
        id: "run-root-pressure",
        agent: "worker",
        success: true,
        state: "complete",
        cwd: root,
        sessionFile,
        contextPressure,
        contextPressureCrossedThresholds: ["warning", "warning"],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-root-pressure" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      assert.equal(target.kind, "revive");
      assert.deepEqual(target.contextPressure, contextPressure);
      assert.deepEqual(target.contextPressureCrossedThresholds, ["warning"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("result-only revival: non-interrupted child is not identified as paused", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-only-not-paused-"));
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "result-only-terminal.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(resultsDir, "run-result-only-terminal.json"), {
        id: "run-result-only-terminal",
        agent: "worker",
        success: false,
        state: "paused",
        cwd: root,
        results: [
          {
            agent: "worker",
            // success: false but NOT interrupted — should not be treated as paused
            success: false,
            exitCode: 1,
            sessionFile,
          },
        ],
      });

      // Without a status file, a non-interrupted child must not be misidentified as paused.
      // Since it is not paused, the fail-closed guard must not fire (no acceptance needed).
      const target = resolveAsyncResumeTarget(
        { id: "run-result-only-terminal" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      assert.equal(target.kind, "revive");
      assert.equal(target.continuationAcceptance, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
