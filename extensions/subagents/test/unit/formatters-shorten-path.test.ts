/**
 * Regression tests for shortenPath (ts-o2mn / PR 623 item 3).
 *
 * Before the fix, shortenPath abbreviated on a raw HOME prefix without
 * checking for a path separator, so a sibling directory such as
 * /home/ann-other would incorrectly render as ~-other when HOME=/home/ann.
 *
 * The fix requires the path to equal $HOME exactly, or to start with
 * $HOME followed by the platform path separator.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it, afterEach, beforeEach } from "node:test";
import { shortenPath } from "../../src/shared/formatters.ts";

// ---------------------------------------------------------------------------
// Test-local HOME override helpers
// ---------------------------------------------------------------------------

let savedHome: string | undefined;

function setHome(value: string): void {
  savedHome = process.env["HOME"];
  process.env["HOME"] = value;
}

function restoreHome(): void {
  if (savedHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = savedHome;
  }
  savedHome = undefined;
}

describe("shortenPath", () => {
  beforeEach(() => {
    setHome("/home/ann");
  });

  afterEach(() => {
    restoreHome();
  });

  it("abbreviates a normal path inside $HOME", () => {
    assert.equal(shortenPath("/home/ann/projects/foo"), "~/projects/foo");
  });

  it("abbreviates the exact $HOME path", () => {
    assert.equal(shortenPath("/home/ann"), "~");
  });

  it("does NOT abbreviate a sibling directory that merely starts with $HOME as a prefix", () => {
    // Regression: /home/ann-other must NOT become ~-other.
    assert.equal(shortenPath("/home/ann-other/repo"), "/home/ann-other/repo");
  });

  it("does NOT abbreviate a sibling directory whose name has HOME as a substring", () => {
    assert.equal(shortenPath("/home/annotation"), "/home/annotation");
  });

  it("returns the path unchanged when HOME is unset", () => {
    delete process.env["HOME"];
    assert.equal(shortenPath("/home/ann/projects"), "/home/ann/projects");
  });

  it("handles a deeply nested path inside $HOME", () => {
    assert.equal(
      shortenPath("/home/ann/a/b/c/d"),
      `~${path.sep}a${path.sep}b${path.sep}c${path.sep}d`,
    );
  });
});
