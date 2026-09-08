/**
 * Tests for parsePersistedChildLocationSnapshot (ts-o2mn / PR 623 item 1).
 *
 * Ensures that a malformed childLocation read from status.json is rejected at
 * the I/O boundary and never forwarded to the renderer, which dereferences
 * loc.displayPath and passes it to safeTerminalText (a function that calls
 * string methods).  A bad value would throw inside the render path, breaking
 * restoration or rendering repeatedly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePersistedChildLocationSnapshot } from "../../src/shared/child-location.ts";
import type { ChildLocationSnapshot } from "../../src/shared/child-location.ts";

// ---------------------------------------------------------------------------
// Valid fixture used across round-trip assertions
// ---------------------------------------------------------------------------

const validFull: ChildLocationSnapshot = {
  childCwd: "/repos/myrepo/packages/api",
  displayPath: "packages/api",
  branch: "feature-x",
  repoName: "myrepo",
  linkedWorktree: true,
};

const validMinimal: ChildLocationSnapshot = {
  childCwd: "/tmp/scratch",
  displayPath: "~/tmp/scratch",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate persisted JSON by round-tripping through JSON serialisation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function persisted(value: unknown) {
  // Return type is intentionally inferred as `any` from JSON.parse so callers
  // can pass the result directly to the validator under test (which accepts
  // unknown).
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parsePersistedChildLocationSnapshot", () => {
  // --- absent / non-object values are dropped ---

  it("returns undefined for undefined", () => {
    assert.equal(parsePersistedChildLocationSnapshot(undefined), undefined);
  });

  it("returns undefined for null", () => {
    assert.equal(parsePersistedChildLocationSnapshot(null), undefined);
  });

  it("returns undefined for a string", () => {
    assert.equal(parsePersistedChildLocationSnapshot("bad"), undefined);
  });

  it("returns undefined for an array", () => {
    assert.equal(parsePersistedChildLocationSnapshot([]), undefined);
  });

  it("returns undefined for a number", () => {
    assert.equal(parsePersistedChildLocationSnapshot(42), undefined);
  });

  // --- missing required fields ---

  it("returns undefined when childCwd is missing", () => {
    assert.equal(parsePersistedChildLocationSnapshot({ displayPath: "packages/api" }), undefined);
  });

  it("returns undefined when displayPath is missing", () => {
    assert.equal(
      parsePersistedChildLocationSnapshot({ childCwd: "/repos/myrepo/packages/api" }),
      undefined,
    );
  });

  it("returns undefined for an empty object ({})", () => {
    assert.equal(parsePersistedChildLocationSnapshot({}), undefined);
  });

  // --- required fields with wrong types ---

  it("returns undefined when childCwd is not a string", () => {
    assert.equal(
      parsePersistedChildLocationSnapshot({ childCwd: 123, displayPath: "packages/api" }),
      undefined,
    );
  });

  it("returns undefined when displayPath is not a string", () => {
    assert.equal(
      parsePersistedChildLocationSnapshot({ childCwd: "/repo", displayPath: {} }),
      undefined,
    );
  });

  // --- optional fields with wrong types are dropped entirely ---

  it("returns undefined when branch is present but not a string", () => {
    assert.equal(
      parsePersistedChildLocationSnapshot({
        childCwd: "/repo",
        displayPath: "repo",
        branch: 42,
      }),
      undefined,
    );
  });

  it("returns undefined when detachedHead is present but not a string", () => {
    assert.equal(
      parsePersistedChildLocationSnapshot({
        childCwd: "/repo",
        displayPath: "repo",
        detachedHead: true,
      }),
      undefined,
    );
  });

  it("returns undefined when repoName is present but not a string", () => {
    assert.equal(
      parsePersistedChildLocationSnapshot({
        childCwd: "/repo",
        displayPath: "repo",
        repoName: [],
      }),
      undefined,
    );
  });

  it("returns undefined when linkedWorktree is present but not the literal true", () => {
    assert.equal(
      parsePersistedChildLocationSnapshot({
        childCwd: "/repo",
        displayPath: "repo",
        linkedWorktree: "yes",
      }),
      undefined,
    );
  });

  it("returns undefined when notAGitRepo is present but not the literal true", () => {
    assert.equal(
      parsePersistedChildLocationSnapshot({
        childCwd: "/repo",
        displayPath: "repo",
        notAGitRepo: 1,
      }),
      undefined,
    );
  });

  // --- round-trip: valid values survive unchanged ---

  it("round-trips a minimal valid snapshot", () => {
    assert.deepEqual(parsePersistedChildLocationSnapshot(persisted(validMinimal)), validMinimal);
  });

  it("round-trips a full valid snapshot", () => {
    assert.deepEqual(parsePersistedChildLocationSnapshot(persisted(validFull)), validFull);
  });

  it("round-trips a snapshot with detachedHead", () => {
    const snap: ChildLocationSnapshot = {
      childCwd: "/repos/myrepo",
      displayPath: "~/repos/myrepo",
      detachedHead: "abc1234",
    };
    assert.deepEqual(parsePersistedChildLocationSnapshot(persisted(snap)), snap);
  });

  it("round-trips a snapshot with notAGitRepo flag", () => {
    const snap: ChildLocationSnapshot = {
      childCwd: "/tmp/scratch",
      displayPath: "~/tmp/scratch",
      notAGitRepo: true,
    };
    assert.deepEqual(parsePersistedChildLocationSnapshot(persisted(snap)), snap);
  });

  // --- unknown extra fields are silently dropped (not copied) ---

  it("ignores unknown extra fields in the persisted object", () => {
    const result = parsePersistedChildLocationSnapshot({
      childCwd: "/repo",
      displayPath: "repo",
      unknownField: "surprise",
      anotherField: 999,
    });
    assert.ok(result !== undefined);
    assert.equal("unknownField" in result, false);
    assert.equal("anotherField" in result, false);
  });
});
