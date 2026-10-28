import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";
import {
  resolveAsyncResumeTarget,
  resolveAsyncRunLocation,
} from "../../src/runs/background/async-resume.ts";
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
        // Prefix lookup is scoped to caller-owned runs, so the fixture needs an owner.
        sessionId: "owner-session",
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
            terminationReason: "legacy-retired-reason" as never,
            contextPressureCrossedThresholds: ["warning", "critical"],
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-a" },
        {
          asyncDirRoot: asyncRoot,
          resultsDir: path.join(root, "results"),
          callerKey: "owner-session",
        },
      );

      assert.equal(target.kind, "revive");
      assert.equal(target.runId, "run-abc");
      assert.equal(target.agent, "worker");
      assert.equal(target.sessionFile, sessionFile);
      assert.equal(target.cwd, root);
      assert.equal(target.promptVariant, "normal");
      assert.equal(target.terminationReason, undefined);
      assert.deepEqual(target.contextPressureCrossedThresholds, ["warning", "critical"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves an explicit ticket-free variant through status and result-only revival", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-prompt-variant-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-status-variant", "status.json"), {
        runId: "run-status-variant",
        mode: "single",
        state: "complete",
        startedAt: 100,
        steps: [{ agent: "worker", status: "complete", sessionFile, promptVariant: "ticket-free" }],
      });
      const statusTarget = resolveAsyncResumeTarget(
        { id: "run-status-variant" },
        { asyncDirRoot: asyncRoot, resultsDir },
        { readOnly: true },
      );
      assert.equal(statusTarget.promptVariant, "ticket-free");

      writeJson(path.join(resultsDir, "run-result-variant.json"), {
        id: "run-result-variant",
        agent: "worker",
        mode: "single",
        state: "complete",
        success: true,
        summary: "done",
        results: [{ agent: "worker", sessionFile, promptVariant: "ticket-free" }],
        exitCode: 0,
        timestamp: 200,
        durationMs: 100,
        asyncDir: path.join(asyncRoot, "run-result-variant"),
      });
      const resultTarget = resolveAsyncResumeTarget(
        { id: "run-result-variant" },
        { asyncDirRoot: asyncRoot, resultsDir },
        { readOnly: true },
      );
      assert.equal(resultTarget.promptVariant, "ticket-free");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed or conflicting prompt variant evidence before repair", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-prompt-invalid-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      const malformedStatusPath = path.join(asyncRoot, "run-malformed", "status.json");
      writeJson(malformedStatusPath, {
        runId: "run-malformed",
        mode: "single",
        state: "complete",
        startedAt: 100,
        steps: [
          {
            agent: "worker",
            status: "complete",
            sessionFile,
            promptVariant: "future" as never,
          },
        ],
      });
      const beforeMalformed = fs.readFileSync(malformedStatusPath);
      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-malformed" },
            { asyncDirRoot: asyncRoot, resultsDir },
          ),
        /promptVariant.*malformed/i,
      );
      assert.deepEqual(fs.readFileSync(malformedStatusPath), beforeMalformed);

      const conflictStatusPath = path.join(asyncRoot, "run-conflict", "status.json");
      writeJson(conflictStatusPath, {
        runId: "run-conflict",
        mode: "single",
        state: "complete",
        startedAt: 100,
        steps: [{ agent: "worker", status: "complete", sessionFile, promptVariant: "ticket-free" }],
      });
      writeJson(path.join(resultsDir, "run-conflict.json"), {
        id: "run-conflict",
        agent: "worker",
        mode: "single",
        state: "complete",
        success: true,
        summary: "done",
        results: [{ agent: "worker", sessionFile, promptVariant: "normal" }],
        exitCode: 0,
        timestamp: 200,
        durationMs: 100,
        asyncDir: path.join(asyncRoot, "run-conflict"),
      });
      const beforeConflict = fs.readFileSync(conflictStatusPath);
      assert.throws(
        () =>
          resolveAsyncResumeTarget({ id: "run-conflict" }, { asyncDirRoot: asyncRoot, resultsDir }),
        /promptVariant.*conflicts/i,
      );
      assert.deepEqual(fs.readFileSync(conflictStatusPath), beforeConflict);

      writeJson(path.join(resultsDir, "run-malformed-result.json"), {
        id: "run-malformed-result",
        agent: "worker",
        mode: "single",
        state: "complete",
        success: true,
        summary: "done",
        results: [
          {
            agent: "worker",
            sessionFile,
            promptVariant: { nested: true } as never,
          },
        ],
        exitCode: 0,
        timestamp: 200,
        durationMs: 100,
        asyncDir: path.join(asyncRoot, "run-malformed-result"),
      });
      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-malformed-result" },
            { asyncDirRoot: asyncRoot, resultsDir },
          ),
        /promptVariant.*normal.*ticket-free/i,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("gates follow-up resume from continuation metadata, not canonical completion labels", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-lifecycle-projection-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-completed-alias", "status.json"), {
        runId: "run-completed-alias",
        mode: "single",
        state: "completed",
        startedAt: 100,
        steps: [{ agent: "worker", status: "completed", sessionFile }],
      });
      const ordinary = resolveAsyncResumeTarget(
        { id: "run-completed-alias" },
        { asyncDirRoot: asyncRoot, resultsDir },
      );
      assert.equal(ordinary.kind, "revive");
      assert.equal(ordinary.state, "complete");

      writeJson(path.join(asyncRoot, "run-continued-alias", "status.json"), {
        runId: "run-continued-alias",
        mode: "single",
        state: "continued",
        startedAt: 100,
        steps: [{ agent: "worker", status: "continued", sessionFile }],
      });
      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-continued-alias" },
            { asyncDirRoot: asyncRoot, resultsDir },
          ),
        /already launched continuation 'unknown'/,
      );

      writeJson(path.join(asyncRoot, "run-continued-step", "status.json"), {
        runId: "run-continued-step",
        mode: "parallel",
        state: "complete",
        startedAt: 100,
        steps: [
          { agent: "worker", status: "continued", sessionFile },
          { agent: "reviewer", status: "complete", sessionFile },
        ],
      });
      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-continued-step", index: 0 },
            { asyncDirRoot: asyncRoot, resultsDir },
          ),
        /already launched continuation 'unknown'/,
      );
      const sibling = resolveAsyncResumeTarget(
        { id: "run-continued-step", index: 1 },
        { asyncDirRoot: asyncRoot, resultsDir },
      );
      assert.equal(sibling.kind, "revive");

      writeJson(path.join(asyncRoot, "run-failed-with-message", "status.json"), {
        runId: "run-failed-with-message",
        mode: "single",
        state: "failed",
        startedAt: 100,
        error:
          "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.",
        steps: [{ agent: "worker", status: "failed", sessionFile }],
      });
      const failedTarget = resolveAsyncResumeTarget(
        { id: "run-failed-with-message" },
        { asyncDirRoot: asyncRoot, resultsDir },
      );
      assert.equal(failedTarget.kind, "revive");
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
      const projectAgent = { slug: "worker", root, cwd: root };
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
            projectAgent: { ...projectAgent, slug: "Worker" },
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
        /projectAgent is invalid|project-agent identity/i,
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

  it("restores distinct per-child ticket ids from result-only artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-tickets-"));
    try {
      const resultsDir = path.join(root, "results");
      const firstSession = path.join(root, "first.jsonl");
      const secondSession = path.join(root, "second.jsonl");
      fs.writeFileSync(firstSession, "", "utf-8");
      fs.writeFileSync(secondSession, "", "utf-8");
      writeJson(path.join(resultsDir, "run-result-tickets.json"), {
        id: "run-result-tickets",
        agent: "developer",
        success: true,
        state: "complete",
        cwd: root,
        results: [
          {
            agent: "developer",
            success: true,
            sessionFile: firstSession,
            ticketId: "tlhm-child-a",
          },
          {
            agent: "developer",
            success: true,
            sessionFile: secondSession,
            ticketId: "tlhm-child-b",
          },
        ],
      });

      const firstTarget = resolveAsyncResumeTarget(
        { id: "run-result-tickets", index: 0 },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      const secondTarget = resolveAsyncResumeTarget(
        { id: "run-result-tickets", index: 1 },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );

      assert.equal(firstTarget.ticketId, "tlhm-child-a");
      assert.equal(secondTarget.ticketId, "tlhm-child-b");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits malformed per-child ticket ids during result-only recovery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-ticket-boundary-"));
    try {
      const resultsDir = path.join(root, "results");
      const firstSession = path.join(root, "first.jsonl");
      const secondSession = path.join(root, "second.jsonl");
      fs.writeFileSync(firstSession, "", "utf-8");
      fs.writeFileSync(secondSession, "", "utf-8");
      const malformedResult: unknown = {
        id: "run-result-ticket-boundary",
        agent: "developer",
        success: true,
        state: "complete",
        cwd: root,
        results: [
          {
            agent: "developer",
            success: true,
            sessionFile: firstSession,
            ticketId: "not a ticket",
          },
          {
            agent: "developer",
            success: true,
            sessionFile: secondSession,
            ticketId: 42,
          },
        ],
      };
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(
        path.join(resultsDir, "run-result-ticket-boundary.json"),
        JSON.stringify(malformedResult, null, 2),
        "utf-8",
      );

      const firstTarget = resolveAsyncResumeTarget(
        { id: "run-result-ticket-boundary", index: 0 },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      const secondTarget = resolveAsyncResumeTarget(
        { id: "run-result-ticket-boundary", index: 1 },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );

      assert.equal(firstTarget.ticketId, undefined);
      assert.equal(secondTarget.ticketId, undefined);
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
        sessionId: "owner-session",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "scout", status: "running" }],
      });
      writeJson(path.join(asyncRoot, "run-ab", "status.json"), {
        runId: "run-ab",
        sessionId: "owner-session",
        mode: "single",
        state: "running",
        startedAt: 100,
        steps: [{ agent: "worker", status: "running" }],
      });

      assert.throws(
        () =>
          resolveAsyncResumeTarget(
            { id: "run-a" },
            {
              asyncDirRoot: asyncRoot,
              resultsDir: path.join(root, "results"),
              callerKey: "owner-session",
            },
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

      const pausedTarget = resolveAsyncResumeTarget(
        { id: "run-paused-terminal-missing-session", index: 1 },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );
      assert.equal(pausedTarget.kind, "revive");
      assert.equal(pausedTarget.state, "paused");
      assert.equal(pausedTarget.index, 1);
      assert.equal(pausedTarget.sessionFile, undefined);
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

  it("sanitizes malformed optional result diagnostics, including terminalResult, during recovery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-diagnostics-"));
    try {
      const resultsDir = path.join(root, "results");
      const sessionFile = path.join(root, "legacy.jsonl");
      const malformedTerminalResult = {
        state: "completed" as const,
        facts: { attempts: [] },
      };
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
            terminalResult: malformedTerminalResult,
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
      const target = resolveAsyncResumeTarget(
        { id: "run-result-only-terminal" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      assert.equal(target.kind, "revive");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// BUG-02: per-child cwd revival — explicit step cwd, childLocation fallback,
// run-cwd fallback, and legacy artifact compatibility.
// ---------------------------------------------------------------------------

describe("revival cwd precedence (BUG-02)", () => {
  it("prefers explicit per-step cwd over run cwd when reviving a completed child", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-cwd-step-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const childCwd = path.join(root, "child-workdir");
      const runCwd = path.join(root, "run-workdir");
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-stepcwd", "status.json"), {
        runId: "run-stepcwd",
        mode: "single",
        state: "complete",
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 200,
        cwd: runCwd,
        steps: [
          {
            agent: "worker",
            status: "complete",
            sessionFile,
            cwd: childCwd,
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-stepcwd" },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );

      assert.equal(target.kind, "revive");
      assert.equal(
        target.cwd,
        childCwd,
        "revival cwd must be the per-step child cwd, not the run cwd",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to childLocation.childCwd when step cwd field is absent (legacy artifact)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-cwd-cloc-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const childCwd = path.join(root, "child-workdir");
      const runCwd = path.join(root, "run-workdir");
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-clocwd", "status.json"), {
        runId: "run-clocwd",
        mode: "single",
        state: "complete",
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 200,
        cwd: runCwd,
        steps: [
          {
            agent: "worker",
            status: "complete",
            sessionFile,
            childLocation: { childCwd, displayPath: "child-workdir" },
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-clocwd" },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );

      assert.equal(target.kind, "revive");
      assert.equal(
        target.cwd,
        childCwd,
        "revival cwd must fall back to childLocation.childCwd when step cwd is absent",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to run cwd when step has neither cwd nor childLocation (oldest artifacts)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-cwd-runcwd-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const runCwd = path.join(root, "run-workdir");
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-runcwd", "status.json"), {
        runId: "run-runcwd",
        mode: "single",
        state: "complete",
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 200,
        cwd: runCwd,
        steps: [
          {
            agent: "worker",
            status: "complete",
            sessionFile,
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-runcwd" },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );

      assert.equal(target.kind, "revive");
      assert.equal(
        target.cwd,
        runCwd,
        "revival cwd must fall back to run cwd for oldest artifacts",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("step cwd field is validated as a string at the I/O boundary; non-string is ignored", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-cwd-invalid-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const runCwd = path.join(root, "run-workdir");
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-cwdinvalid", "status.json"), {
        runId: "run-cwdinvalid",
        mode: "single",
        state: "complete",
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 200,
        cwd: runCwd,
        steps: [
          {
            agent: "worker",
            status: "complete",
            sessionFile,
            // @ts-expect-error -- intentionally testing runtime rejection of a non-string cwd
            cwd: 42,
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-cwdinvalid" },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );

      assert.equal(target.kind, "revive");
      assert.equal(
        target.cwd,
        runCwd,
        "a non-string step cwd must be dropped and fall back to run cwd",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("malformed childLocation.childCwd (non-string) falls through to next-tier cwd", () => {
    // Codex P2: childLocation.childCwd is used without validation in
    // buildTerminalAsyncResumeTarget; a non-string value must fall through to
    // the result-step or run-level cwd rather than being used as-is.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-cwd-clocbad-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const runCwd = path.join(root, "run-workdir");
      const sessionFile = path.join(root, "session.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(asyncRoot, "run-clocbadcwd", "status.json"), {
        runId: "run-clocbadcwd",
        mode: "single",
        state: "complete",
        startedAt: 100,
        endedAt: 200,
        lastUpdate: 200,
        cwd: runCwd,
        steps: [
          {
            agent: "worker",
            status: "complete",
            sessionFile,
            // step.cwd is absent; childLocation.childCwd is a number, not a string
            childLocation: {
              // @ts-expect-error -- intentionally testing runtime rejection of a non-string childCwd
              childCwd: 99,
              displayPath: "bad-child",
            },
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-clocbadcwd" },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );

      assert.equal(target.kind, "revive");
      assert.equal(
        target.cwd,
        runCwd,
        "a non-string childLocation.childCwd must be dropped and fall back to run cwd",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// BUG-02: result-only async revival must use per-child cwd from result item.
// These tests confirm that when status.json is absent (result-only revival),
// the revival target cwd is taken from the result step, not the run cwd.
// ---------------------------------------------------------------------------

describe("result-only revival cwd (BUG-02)", () => {
  it("result-only revival uses step cwd from result.json, not run cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-stepcwd-"));
    try {
      const resultsDir = path.join(root, "results");
      const childCwd = path.join(root, "child-workdir");
      const runCwd = path.join(root, "run-workdir");
      const sessionFile = path.join(root, "result-only-stepcwd.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(resultsDir, "run-result-stepcwd.json"), {
        id: "run-result-stepcwd",
        agent: "worker",
        success: true,
        state: "complete",
        cwd: runCwd,
        results: [
          {
            agent: "worker",
            success: true,
            exitCode: 0,
            sessionFile,
            cwd: childCwd,
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-result-stepcwd" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );

      assert.equal(target.kind, "revive");
      assert.equal(
        target.cwd,
        childCwd,
        "result-only revival must use the per-step cwd from result.json, not the run cwd",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("result-only revival: non-string result step cwd is ignored and falls back to run cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-cwdinval-"));
    try {
      const resultsDir = path.join(root, "results");
      const runCwd = path.join(root, "run-workdir");
      const sessionFile = path.join(root, "result-only-cwdinval.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      writeJson(path.join(resultsDir, "run-result-cwdinval.json"), {
        id: "run-result-cwdinval",
        agent: "worker",
        success: true,
        state: "complete",
        cwd: runCwd,
        results: [
          {
            agent: "worker",
            success: true,
            exitCode: 0,
            sessionFile,
            // @ts-expect-error -- intentionally testing runtime rejection of a non-string cwd
            cwd: 99,
          },
        ],
      });

      const target = resolveAsyncResumeTarget(
        { id: "run-result-cwdinval" },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );

      assert.equal(target.kind, "revive");
      assert.equal(
        target.cwd,
        runCwd,
        "a non-string result step cwd must be dropped and fall back to run cwd",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("result-only revival: step cwd takes precedence over run-level cwd when status is absent", () => {
    // Parallel run with two children: each step carries its own cwd.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-result-parallel-"));
    try {
      const resultsDir = path.join(root, "results");
      const runCwd = path.join(root, "run");
      const childCwd0 = path.join(root, "child0");
      const childCwd1 = path.join(root, "child1");
      const sess0 = path.join(root, "s0.jsonl");
      const sess1 = path.join(root, "s1.jsonl");
      fs.writeFileSync(sess0, "", "utf-8");
      fs.writeFileSync(sess1, "", "utf-8");
      writeJson(path.join(resultsDir, "run-result-parallel-cwd.json"), {
        id: "run-result-parallel-cwd",
        agent: "worker",
        success: true,
        state: "complete",
        cwd: runCwd,
        results: [
          { agent: "worker", success: true, exitCode: 0, sessionFile: sess0, cwd: childCwd0 },
          { agent: "worker", success: true, exitCode: 0, sessionFile: sess1, cwd: childCwd1 },
        ],
      });

      const target0 = resolveAsyncResumeTarget(
        { id: "run-result-parallel-cwd", index: 0 },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );
      const target1 = resolveAsyncResumeTarget(
        { id: "run-result-parallel-cwd", index: 1 },
        { asyncDirRoot: path.join(root, "runs"), resultsDir },
      );

      assert.equal(target0.cwd, childCwd0, "child 0 revival cwd must be its own child cwd");
      assert.equal(target1.cwd, childCwd1, "child 1 revival cwd must be its own child cwd");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("async resume lookup scoping", () => {
  it("scopes resolveAsyncRunLocation prefixes to the caller but leaves exact ids and dir unfiltered", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-location-scope-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsDir = path.join(root, "results");
      for (const [id, owner] of [
        ["run-aa", "other"],
        ["run-ab", "me"],
      ] as const)
        writeJson(path.join(asyncRoot, id, "status.json"), {
          runId: id,
          sessionId: owner,
          mode: "single",
          state: "running",
          startedAt: 1,
        });

      assert.equal(
        resolveAsyncRunLocation({ id: "run-a" }, asyncRoot, resultsDir, "me").resolvedId,
        "run-ab",
      );
      // Foreign-only prefix and missing caller key never match or name foreign ids.
      assert.equal(
        resolveAsyncRunLocation({ id: "run-aa".slice(0, 5) }, asyncRoot, resultsDir, "you")
          .asyncDir,
        null,
      );
      assert.equal(resolveAsyncRunLocation({ id: "run-a" }, asyncRoot, resultsDir).asyncDir, null);
      // Exact id and explicit dir resolve for a foreign caller (owner-checked later).
      assert.equal(
        resolveAsyncRunLocation({ id: "run-aa" }, asyncRoot, resultsDir, "me").resolvedId,
        "run-aa",
      );
      assert.equal(
        resolveAsyncRunLocation(
          { dir: path.join(asyncRoot, "run-aa") },
          asyncRoot,
          resultsDir,
          "me",
        ).resolvedId,
        "run-aa",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
