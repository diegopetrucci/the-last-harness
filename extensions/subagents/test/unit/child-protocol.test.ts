import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Buffer } from "node:buffer";
import {
  appendBoundedChildMessage,
  boundChildError,
  boundChildStderrError,
  claimChildTerminalReason,
  createBoundedBytePrefix,
  createBoundedByteTail,
  createBoundedLineReader,
  formatBoundedRawStdout,
  formatBoundedStderr,
  formatProtocolOutputLimit,
  formatStderrLineOverflow,
  formatStderrTailOverflow,
  isChildProtocolEvent,
  MAX_CHILD_ERROR_BYTES,
  MAX_CHILD_RAW_STDOUT_BYTES,
  MAX_CHILD_STDERR_BYTES,
  MAX_CHILD_STDERR_LINE_BYTES,
  parseChildProtocolLine,
} from "../../src/runs/shared/child-protocol.ts";
import type { Message } from "@earendil-works/pi-ai";
import type { ProtocolOutputLimit } from "../../src/shared/types.ts";

describe("child protocol validation", () => {
  it("accepts consumed event shapes and preserves unknown fields", () => {
    const event = parseChildProtocolLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          api: "pi-messages",
          provider: "mock",
          model: "mock/test-model",
          stopReason: "stop",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
          },
          timestamp: 1,
        },
        futureField: { retained: true },
      }),
    );

    assert.ok(event);
    assert.equal(event.type, "message_end");
    assert.ok(Array.isArray(event.message.content));
    assert.equal(event.message.content[0]?.type, "text");
    assert.deepEqual(event.futureField, { retained: true });
    assert.equal(
      isChildProtocolEvent({ type: "tool_execution_start", toolName: "read", args: {} }),
      true,
    );
  });

  it("rejects malformed and unknown protocol objects without throwing", () => {
    const malformed = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ type: "unknown_event" }),
      JSON.stringify({ type: "tool_execution_start", toolName: 42 }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: "not-array" } }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: 42 }] },
      }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [], usage: { input: "not-a-number" } },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "missing timestamp" }],
          api: "pi-messages",
          provider: "mock",
          model: "mock/test-model",
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "missing assistant usage" }],
          api: "pi-messages",
          provider: "mock",
          model: "mock/test-model",
          stopReason: "stop",
          timestamp: 1,
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "edit", arguments: {} }],
          api: "pi-messages",
          provider: "mock",
          model: "mock/test-model",
          stopReason: "toolUse",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: 1,
        },
      }),
      JSON.stringify({
        type: "tool_result_end",
        message: {
          role: "toolResult",
          toolName: "edit",
          content: [{ type: "text", text: "missing required fields" }],
          timestamp: 1,
        },
      }),
    ];

    for (const line of malformed) assert.equal(parseChildProtocolLine(line), undefined, line);
  });
});

describe("createBoundedLineReader", () => {
  it("splits complete and unterminated UTF-8 lines", () => {
    const lines: string[] = [];
    const reader = createBoundedLineReader({
      onLine: (line) => lines.push(line),
      onLimit: () => {},
    });
    const utf8 = Buffer.from("first\nsecond 😀", "utf8");
    reader.push(utf8.subarray(0, utf8.length - 2));
    reader.push(utf8.subarray(utf8.length - 2));
    reader.end();
    assert.deepEqual(lines, ["first", "second 😀"]);
  });

  it("reports one bounded protocol overflow and stops consuming lines", () => {
    const limits: ProtocolOutputLimit[] = [];
    const lines: string[] = [];
    const reader = createBoundedLineReader({
      maxPendingLineBytes: 5,
      onLine: (line) => lines.push(line),
      onLimit: (limit) => limits.push(limit),
    });
    reader.push(Buffer.from("ok\n123456\nafter\n", "utf8"));
    reader.end();

    assert.deepEqual(lines, ["ok"]);
    assert.equal(limits.length, 1);
    assert.equal(limits[0]?.code, "protocol_output_limit");
    assert.equal(limits[0]?.stream, "stdout");
    assert.equal(reader.exceeded(), true);
    const diagnostic = formatProtocolOutputLimit(limits[0]!);
    assert.match(diagnostic, /protocol_output_limit/);
    assert.match(diagnostic, /not retained in full/);
    assert.match(diagnostic, /bounded prefix and tail.*protocol_output_limit record/);
    assert.match(diagnostic, /subsequent input on that stream is dropped/);
    assert.doesNotMatch(diagnostic, /offending line was discarded/);
    assert.match(diagnostic, /artifacts\.mode.*debug/);
  });

  it("keeps protocol diagnostics bounded", () => {
    const limits: ProtocolOutputLimit[] = [];
    const reader = createBoundedLineReader({
      maxPendingLineBytes: 10,
      onLine: () => {},
      onLimit: (limit) => limits.push(limit),
    });
    reader.push(Buffer.from("a".repeat(100_000), "utf8"));
    const limit = limits[0]!;
    assert.ok(limit.diagnosticPrefix.length <= 4096);
    assert.ok(limit.diagnosticTail.length <= 4096);
  });
});

describe("bounded child diagnostics", () => {
  it("does not mark an exact-size byte-tail chunk as truncated", () => {
    const tail = createBoundedByteTail(8);
    tail.push(Buffer.from("12345678", "utf8"));
    assert.equal(tail.text(), "12345678");
    assert.equal(tail.totalByteLength(), 8);
    assert.equal(tail.wasTruncated(), false);
    tail.push(Buffer.from("9", "utf8"));
    assert.equal(tail.wasTruncated(), true);
  });

  it("retains the final stderr bytes and reports truncation", () => {
    const tail = createBoundedByteTail(8);
    tail.push(Buffer.from("begin ", "utf8"));
    tail.push(Buffer.from("😀 end", "utf8"));
    assert.equal(tail.wasTruncated(), true);
    assert.equal(tail.byteLength() <= 8, true);
    assert.match(formatBoundedStderr(tail), /stderr truncated/);
    const diagnostic = formatStderrTailOverflow(tail);
    assert.match(diagnostic, /async output-N\.log.*raw stderr/);
    assert.match(
      diagnostic,
      /artifacts\.mode.*debug.*diagnostic child transcript.*surrounding child protocol/,
    );
    assert.doesNotMatch(diagnostic, /Exact raw stderr requires/);

    const lineLimits: ProtocolOutputLimit[] = [];
    const lineReader = createBoundedLineReader({
      stream: "stderr",
      maxPendingLineBytes: 4,
      onLine: () => {},
      onLimit: (limit) => lineLimits.push(limit),
    });
    lineReader.push(Buffer.from("12345", "utf8"));
    const lineDiagnostic = formatStderrLineOverflow(lineLimits[0]!);
    assert.match(lineDiagnostic, /events\.jsonl/);
    assert.match(lineDiagnostic, /async output-N\.log.*raw stderr/);
    assert.match(
      lineDiagnostic,
      /artifacts\.mode.*debug.*diagnostic child transcript.*surrounding child protocol/,
    );
    assert.doesNotMatch(lineDiagnostic, /exact raw stderr is required/);
    assert.match(tail.text(), /end/);
  });

  it("bounds surfaced errors without sanitizing their content", () => {
    const raw = `prefix\u001b[31m ${"x".repeat(20_000)} tail`;
    const error = boundChildError(raw);
    assert.ok(error);
    assert.ok(Buffer.byteLength(error, "utf8") <= MAX_CHILD_ERROR_BYTES);
    assert.match(error, /^prefix/);
    assert.match(error, /child error truncated/);
    assert.ok(error.includes("\u001b[31m"));

    const stderrError = boundChildStderrError(`begin ${"x".repeat(20_000)} 😀 stderr-tail`, true);
    assert.ok(Buffer.byteLength(stderrError, "utf8") <= MAX_CHILD_ERROR_BYTES);
    assert.match(stderrError, /stderr-tail/);
    assert.match(stderrError, /stderr truncated/);
    assert.equal(stderrError.includes("�"), false);
    const ordinaryStderrError = boundChildStderrError(
      `begin ${"x".repeat(20_000)} ordinary-tail`,
      false,
    );
    assert.match(ordinaryStderrError, /stderr error truncated/);
    assert.doesNotMatch(ordinaryStderrError, /earlier diagnostic bytes were dropped/);
    assert.ok(Buffer.byteLength(boundChildError("large", 4) ?? "", "utf8") <= 4);
    assert.ok(Buffer.byteLength(boundChildStderrError("large", false, 4), "utf8") <= 4);
  });

  it("formats raw stdout overflow as a bounded prefix with a visible marker", () => {
    const prefix = createBoundedBytePrefix(8);
    prefix.push("startup ");
    prefix.push("failure details");
    assert.equal(prefix.text(), "startup ");
    assert.equal(prefix.wasTruncated(), true);
    assert.equal(
      formatBoundedRawStdout(prefix),
      "startup \n[stdout truncated: showing the bounded prefix; later child output was dropped]",
    );
    assert.equal(MAX_CHILD_RAW_STDOUT_BYTES, 64 * 1024);
    assert.equal(MAX_CHILD_STDERR_BYTES, 128 * 1024);
    assert.equal(MAX_CHILD_STDERR_LINE_BYTES, 64 * 1024);
  });

  it("retains a complete UTF-8 code point ending exactly at the raw stdout cap", () => {
    const prefix = createBoundedBytePrefix(6);
    const input = "xx😀 later";
    prefix.push(input);

    assert.equal(prefix.text(), "xx😀");
    assert.equal(prefix.byteLength(), 6);
    assert.equal(prefix.totalByteLength(), Buffer.byteLength(input, "utf8"));
    assert.equal(prefix.wasTruncated(), true);
    assert.equal(prefix.text().includes("�"), false);
  });

  it("omits a UTF-8 code point split by the raw stdout cap without replacement", () => {
    const prefix = createBoundedBytePrefix(6);
    const input = "xxx😀 later";
    prefix.push(input);
    prefix.push("tail");

    assert.equal(prefix.text(), "xxx");
    assert.equal(prefix.byteLength(), 3);
    assert.equal(
      prefix.totalByteLength(),
      Buffer.byteLength(input, "utf8") + Buffer.byteLength("tail", "utf8"),
    );
    assert.equal(prefix.wasTruncated(), true);
    assert.equal(prefix.text().includes("�"), false);
  });

  it("keeps split UTF-8 bytes out of raw stdout text when chunks meet the cap", () => {
    const prefix = createBoundedBytePrefix(6);
    const input = Buffer.from("xxx😀tail", "utf8");

    prefix.push(input.subarray(0, 6));
    assert.equal(prefix.text(), "xxx");
    assert.equal(prefix.byteLength(), 3);
    assert.equal(prefix.totalByteLength(), 6);
    assert.equal(prefix.wasTruncated(), false);

    prefix.push(input.subarray(6));
    assert.equal(prefix.text(), "xxx");
    assert.equal(prefix.totalByteLength(), input.length);
    assert.equal(prefix.wasTruncated(), true);
    assert.equal(prefix.text().includes("�"), false);
  });

  it("keeps the bounded message ledger synchronized through evictions", () => {
    const messages: Message[] = [];
    const ledger = { bytes: 0, sizes: [] };
    const message = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
    appendBoundedChildMessage(messages, message("one"), 6, ledger, 10);
    appendBoundedChildMessage(messages, message("two"), 6, ledger, 10);
    assert.deepEqual(
      messages.map((item) => item.content),
      ["two"],
    );
    assert.deepEqual(ledger.sizes, [6]);
    assert.equal(ledger.bytes, 6);
    appendBoundedChildMessage(messages, message("three"), 4, ledger, 10);
    assert.deepEqual(
      messages.map((item) => item.content),
      ["two", "three"],
    );
    assert.deepEqual(ledger.sizes, [6, 4]);
    assert.equal(ledger.bytes, 10);
  });

  it("keeps protocol diagnostics on UTF-8 boundaries", () => {
    const limits: ProtocolOutputLimit[] = [];
    const reader = createBoundedLineReader({
      maxPendingLineBytes: 8,
      onLine: () => {},
      onLimit: (limit) => limits.push(limit),
    });
    reader.push(Buffer.from(`${"x".repeat(4095)}😀${"y".repeat(16)}`, "utf8"));
    const limit = limits[0]!;
    assert.equal(limit.diagnosticPrefix.includes("�"), false);
    assert.equal(limit.diagnosticTail.includes("�"), false);
    assert.ok(Buffer.byteLength(limit.diagnosticPrefix, "utf8") <= 4096);
    assert.ok(Buffer.byteLength(limit.diagnosticTail, "utf8") <= 4096);
  });

  it("retains a complete UTF-8 code point ending exactly at the diagnostic cutoff", () => {
    const limits: ProtocolOutputLimit[] = [];
    const reader = createBoundedLineReader({
      maxPendingLineBytes: 8,
      onLine: () => {},
      onLimit: (limit) => limits.push(limit),
    });
    const completePrefix = `${"x".repeat(4092)}😀`;
    reader.push(Buffer.from(`${completePrefix}overflow`, "utf8"));
    const limit = limits[0]!;
    assert.equal(limit.diagnosticPrefix, completePrefix);
    assert.equal(Buffer.byteLength(limit.diagnosticPrefix, "utf8"), 4096);
    assert.equal(limit.diagnosticPrefix.includes("�"), false);
  });

  it("drops a UTF-8 code point split by the diagnostic cutoff without replacement", () => {
    const limits: ProtocolOutputLimit[] = [];
    const reader = createBoundedLineReader({
      maxPendingLineBytes: 8,
      onLine: () => {},
      onLimit: (limit) => limits.push(limit),
    });
    const completePrefix = "x".repeat(4093);
    reader.push(Buffer.from(`${completePrefix}😀overflow`, "utf8"));
    const limit = limits[0]!;
    assert.equal(limit.diagnosticPrefix, completePrefix);
    assert.equal(Buffer.byteLength(limit.diagnosticPrefix, "utf8"), 4093);
    assert.equal(limit.diagnosticPrefix.includes("�"), false);
  });

  it("keeps the first terminal reason authoritative", () => {
    const timeout = {};
    assert.equal(claimChildTerminalReason(timeout, "timed_out"), true);
    assert.equal(claimChildTerminalReason(timeout, "output_limit"), false);
    const pause = {};
    assert.equal(claimChildTerminalReason(pause, "paused"), true);
    assert.equal(claimChildTerminalReason(pause, "output_limit"), false);
    const overflow = {};
    assert.equal(claimChildTerminalReason(overflow, "output_limit"), true);
    assert.equal(claimChildTerminalReason(overflow, "interrupted"), false);
  });
});
