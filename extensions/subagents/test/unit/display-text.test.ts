import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  BINARY_CONTENT_PLACEHOLDER,
  safeTerminalDocument,
  safeTerminalText,
} from "../../src/shared/display-text.ts";
import {
  formatAsyncRunList,
  type AsyncRunSummary,
} from "../../src/runs/background/async-status.ts";
import {
  formatAsyncResultTranscript,
  formatAsyncRunTranscript,
  formatNestedRunTranscript,
  inspectSubagentFleet,
} from "../../src/runs/background/fleet-view.ts";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { formatNestedRunStatusLines } from "../../src/runs/shared/nested-render.ts";
import { formatForegroundNativeSubagentResult } from "../../src/intercom/result-intercom.ts";
import type { AsyncJobStep, AsyncStatus, NestedRunSummary } from "../../src/shared/types.ts";

const unsafe = "visible \x1b[31mred\x1b[0m\x07tail";

function assertTerminalSafe(text: string): void {
  assert.equal(text.includes("\x1b"), false, `unexpected ESC in ${JSON.stringify(text)}`);
  assert.equal(text.includes("\x07"), false, `unexpected BEL in ${JSON.stringify(text)}`);
  assert.match(text, /visible red tail/);
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function makeStatus(overrides: Partial<AsyncStatus> = {}): AsyncStatus {
  return {
    runId: "run-display",
    state: "running",
    mode: "single",
    startedAt: 100,
    steps: [],
    ...overrides,
  } as AsyncStatus;
}

describe("safeTerminalText", () => {
  it("strips terminal sequences and unsafe controls while preserving readable Unicode", () => {
    assert.equal(safeTerminalText(unsafe), "visible red tail");
    assert.equal(safeTerminalText("echo\x01rm"), "echo rm");
    assert.equal(safeTerminalText("你好 ✅ café\tline\nnext"), "你好 ✅ café\tline\nnext");
    assert.equal(safeTerminalText("line\r\nnext\rfinal"), "line\nnext\nfinal");
  });

  it("consumes OSC sequences terminated by BEL and ST without adding spaces", () => {
    assert.equal(safeTerminalText("before\x1b]title\x07after"), "beforeafter");
    assert.equal(safeTerminalText("before\x1b]title\x1b\\after"), "beforeafter");
  });

  it("consumes C1 CSI and OSC introducers", () => {
    assert.equal(safeTerminalText("before\x9b31mafter"), "beforeafter");
    assert.equal(safeTerminalText("before\x9dtitle\x07after"), "beforeafter");
    assert.equal(safeTerminalText("before\x9dtitle\x9cafter"), "beforeafter");
  });

  it("separates bare controls and removes DEL without noisy ANSI spacing", () => {
    assert.equal(safeTerminalText("before\x01middle\x7fafter"), "before middle after");
    assert.equal(safeTerminalText("before\x1b[31mmiddle\x1b[0mafter"), "beforemiddleafter");
  });

  it("uses a binary placeholder for NUL and control-dense leaf content", () => {
    assert.equal(safeTerminalText("prefix\x00suffix"), BINARY_CONTENT_PLACEHOLDER);
    assert.equal(safeTerminalText("\x01\x02\x03\x04\x05\x06abcd"), BINARY_CONTENT_PLACEHOLDER);
    assert.equal(safeTerminalDocument("prefix\x00suffix"), "prefix suffix");
    assert.equal(safeTerminalDocument("\x01\x02\x03\x04\x05\x06abcd"), "abcd");
  });
});

describe("background display boundaries", () => {
  it("sanitizes async-status list fields without mutating the summary", () => {
    const run: AsyncRunSummary = {
      id: "run-display",
      asyncDir: "/tmp/display-run",
      state: "running",
      mode: "single",
      startedAt: 100,
      error: unsafe,
      steps: [
        {
          index: 0,
          agent: unsafe,
          status: "failed",
          error: unsafe,
          currentTool: unsafe,
          currentPath: `/tmp/${unsafe}`,
        },
      ],
    };
    const snapshot = structuredClone(run);

    const rendered = formatAsyncRunList([run]);

    assertTerminalSafe(rendered);
    assert.deepEqual(run, snapshot);
  });

  it("sanitizes fleet-view output while leaving persisted status bytes untouched", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-display-fleet-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const resultsRoot = path.join(root, "results");
      const asyncDir = path.join(asyncRoot, "run-fleet");
      fs.mkdirSync(asyncDir, { recursive: true });
      const statusPath = path.join(asyncDir, "status.json");
      const statusText = JSON.stringify({
        runId: "run-fleet",
        state: "running",
        mode: "single",
        startedAt: 100,
        lastUpdate: 200,
        error: unsafe,
        steps: [
          {
            agent: "worker",
            status: "running",
            recentOutput: [unsafe],
          },
        ],
      });
      fs.writeFileSync(statusPath, statusText, "utf8");
      const before = fs.readFileSync(statusPath);

      const result = inspectSubagentFleet(
        {},
        { asyncDirRoot: asyncRoot, resultsDir: resultsRoot, kill: () => true, now: () => 250 },
      );

      assertTerminalSafe(textContent(result));
      assert.deepEqual(fs.readFileSync(statusPath), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes run-status output for top-level and step diagnostics", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-display-status-"));
    try {
      const asyncRoot = path.join(root, "runs");
      const asyncDir = path.join(asyncRoot, "run-status");
      fs.mkdirSync(asyncDir, { recursive: true });
      fs.writeFileSync(
        path.join(asyncDir, "status.json"),
        JSON.stringify({
          runId: "run-status",
          state: "failed",
          mode: "single",
          startedAt: 100,
          lastUpdate: 200,
          error: unsafe,
          turnBudget: { turnCount: 5, maxTurns: 10, graceTurns: 1, outcome: "bad\u0000outcome" },
          steps: [{ agent: "worker", status: "failed", error: unsafe }],
        }),
        "utf8",
      );

      const result = inspectSubagentStatus(
        { id: "run-status" },
        { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") },
      );

      const rendered = textContent(result);
      assertTerminalSafe(rendered);
      assert.match(rendered, /Error: visible red tail/);
      assert.match(rendered, /error: visible red tail/);
      assert.match(rendered, /Turn budget: 5\/10\+1 \(\[binary content\]\)/);
      assert.notEqual(rendered, BINARY_CONTENT_PLACEHOLDER);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes nested status and transcript text at their display boundaries", () => {
    const child = {
      id: "nested-display",
      parentRunId: "run-display",
      depth: 1,
      path: [],
      state: "failed" as const,
      agent: "nested-agent",
      error: unsafe,
      steps: [{ agent: "leaf", status: "failed" as const, error: unsafe }],
    } satisfies NestedRunSummary;
    assertTerminalSafe(formatNestedRunStatusLines([child]).join("\n"));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-display-transcript-"));
    try {
      const sessionFile = path.join(root, "session.jsonl");
      const sessionText = `${JSON.stringify({ message: { role: "assistant", content: unsafe } })}\n`;
      fs.writeFileSync(sessionFile, sessionText, "utf8");
      const before = fs.readFileSync(sessionFile);
      const rendered = formatNestedRunTranscript(
        { ...child, state: "complete", sessionFile },
        { sessionRoots: [root] },
      );
      assertTerminalSafe(rendered);
      assert.deepEqual(fs.readFileSync(sessionFile), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizes async transcript and result output without changing source payloads", () => {
    const step: AsyncJobStep = {
      agent: "worker",
      status: "running",
      recentOutput: [unsafe],
      index: 0,
    };
    const status = makeStatus({ steps: [step] });
    const statusSnapshot = structuredClone(status);
    assertTerminalSafe(formatAsyncRunTranscript(status, "/tmp/nonexistent-display-run"));
    assert.deepEqual(status, statusSnapshot);

    const data = {
      id: "result-display",
      state: "complete",
      output: unsafe,
    };
    const dataSnapshot = structuredClone(data);
    assertTerminalSafe(formatAsyncResultTranscript(data, "/tmp/result-display.json"));
    assert.deepEqual(data, dataSnapshot);
  });
});

describe("immediate foreground diagnostics", () => {
  it("sanitizes the returned diagnostic text while retaining child payload objects", () => {
    const child = {
      agent: unsafe,
      status: "failed" as const,
      summary: unsafe,
      index: 0,
      artifactPath: `/tmp/${unsafe}.log`,
    };
    const result = formatForegroundNativeSubagentResult({
      runId: "foreground-display",
      mode: "single",
      children: [child],
    });

    assertTerminalSafe(result.text);
    assert.equal(child.summary, unsafe);
    assert.equal(child.agent, unsafe);
  });
});
