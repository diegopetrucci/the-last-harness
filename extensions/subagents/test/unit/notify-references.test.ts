import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundedReference } from "../../src/runs/background/notify.ts";

const MAX_REF = 500;

describe("boundedReference", () => {
  it("keeps a reference at the limit unchanged", () => {
    const prefix = "/Users/diego/.the-last-harness/agent/sessions/run-0/";
    const filename = "session.jsonl";
    const value = prefix + "x".repeat(MAX_REF - prefix.length - filename.length) + filename;
    assert.equal(value.length, MAX_REF);
    assert.equal(boundedReference(value), value);
  });

  it("preserves identifying path context when truncating a long reference", () => {
    const tail = "/428b3c62/run-0/session.jsonl";
    const value = `/Users/diego/.the-last-harness/agent/sessions/${"deeply-nested/".repeat(40)}${tail.slice(1)}`;
    const result = boundedReference(value);
    assert.ok(result.length <= MAX_REF);
    assert.ok(result.includes("428b3c62"));
    assert.ok(result.endsWith(tail));
    assert.ok(result.includes("… [reference truncated] …"));
  });

  it("falls back to a bounded marker when the final path segment is too long", () => {
    const result = boundedReference(`/tmp/${"x".repeat(MAX_REF + 20)}`);
    assert.ok(result.length <= MAX_REF);
    assert.ok(result.endsWith("… [reference truncated]"));
    assert.ok(!result.includes("… [reference truncated] …"));
  });

  it("sanitizes newlines and terminal controls before truncating", () => {
    const result = boundedReference("/tmp/one\n\u001b[31m/two" + "x".repeat(MAX_REF));
    assert.ok(result.length <= MAX_REF);
    assert.equal(result.includes("\n"), false);
    assert.equal(result.includes(String.fromCharCode(0x1b)), false);
  });

  it("does not emit a lone surrogate at a truncation boundary", () => {
    const emoji = "\uD83D\uDE00";
    const value = "a".repeat(476) + emoji + "a".repeat(100);
    const result = boundedReference(value);
    assert.ok(result.length <= MAX_REF);
    assert.ok(result.isWellFormed());
  });
});
