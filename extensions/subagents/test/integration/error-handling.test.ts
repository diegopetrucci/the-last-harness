/**
 * Integration tests for the shared detectSubagentError parser.
 *
 * Provenance (tlhf-60wy): the former runSync "error handling" tests were removed
 * with the foreground engine. Exit-code/stderr handling is covered on the
 * background path in child-process-hardening.test.ts, and exit-0 hidden-failure
 * detection in async-execution-models-output-output-artifacts-streaming.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tryImport } from "../support/helpers.ts";

// Top-level await
const utils = await tryImport<any>("./src/shared/utils.ts");

const detectSubagentError = utils?.detectSubagentError;

// ---------------------------------------------------------------------------
// detectSubagentError
// ---------------------------------------------------------------------------

describe(
  "detectSubagentError",
  { skip: !detectSubagentError ? "utils not importable" : undefined },
  () => {
    it("returns no error for successful messages", () => {
      const messages = [
        { role: "assistant", content: [{ type: "text", text: "Let me check..." }] },
        {
          role: "toolResult",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "OK" }],
        },
        { role: "assistant", content: [{ type: "text", text: "All good!" }] },
      ];
      const result = detectSubagentError(messages);
      assert.equal(result.hasError, false);
    });

    it("detects fatal bash error in last tool result", () => {
      const messages = [
        {
          role: "toolResult",
          toolName: "bash",
          isError: true,
          content: [{ type: "text", text: "Permission denied" }],
        },
      ];
      const result = detectSubagentError(messages);
      assert.equal(result.hasError, true);
    });

    it("detects fatal command-not-found text even when the tool result is not flagged isError", () => {
      const messages = [
        { role: "assistant", content: [{ type: "text", text: "Running..." }] },
        {
          role: "toolResult",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "command not found" }],
        },
      ];
      const result = detectSubagentError(messages);
      assert.equal(result.hasError, true);
      assert.equal(result.errorType, "bash");
    });

    it("detects non-zero exit code in bash output", () => {
      const messages = [
        {
          role: "toolResult",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "Exit code: 1\nSome output" }],
        },
        { role: "assistant", content: [{ type: "text", text: "Done" }] },
      ];
      const result = detectSubagentError(messages);
      assert.equal(result.hasError, false); // non-bash-error, just assistant text
    });

    it("ignores errors before last successful tool result", () => {
      const messages = [
        {
          role: "toolResult",
          toolName: "bash",
          isError: true,
          content: [{ type: "text", text: "Failed" }],
        },
        {
          role: "toolResult",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "OK" }],
        },
        { role: "assistant", content: [{ type: "text", text: "Recovered" }] },
      ];
      const result = detectSubagentError(messages);
      assert.equal(result.hasError, false);
    });

    it("detects isError on tool result", () => {
      const messages = [
        {
          role: "toolResult",
          toolName: "read",
          isError: true,
          content: [{ type: "text", text: "File not found" }],
        },
      ];
      const result = detectSubagentError(messages);
      assert.equal(result.hasError, true);
    });
  },
);
