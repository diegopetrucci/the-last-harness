import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  parseSessionFacts,
  parseSessionTokens,
  snapshotSessionFiles,
} from "../../src/shared/session-tokens.ts";
import { providerTokensForAttempt } from "../../src/runs/background/single-step-execution.ts";

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-session-facts-"));
  tempDirs.push(directory);
  return directory;
}

function message(content: unknown, usage?: Record<string, unknown>): string {
  return JSON.stringify({
    type: "message",
    message: { role: "assistant", content, ...(usage ? { usage } : {}) },
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("session tool-call facts", () => {
  it("counts requested edit/write/bash calls once by id and skips malformed lines", () => {
    const directory = tempDir();
    const file = path.join(directory, "session.jsonl");
    fs.writeFileSync(
      file,
      [
        "not json",
        message([{ type: "toolCall", id: "edit-1", name: "edit" }]),
        message([{ type: "toolCall", id: "write-1", name: "write" }]),
        message([{ type: "toolCall", id: "edit-1", name: "edit" }]),
        message([{ type: "toolCall", id: "other-1", name: "read" }]),
        message([{ type: "toolCall", name: "bash" }]),
      ].join("\n") + "\n",
      "utf8",
    );

    assert.deepEqual(parseSessionFacts(directory).requestedToolCalls, {
      edit: 1,
      write: 1,
      bash: 0,
    });
  });

  it("attributes appended resumed-session records to the new attempt", () => {
    const directory = tempDir();
    const file = path.join(directory, "session.jsonl");
    fs.writeFileSync(
      file,
      message([{ type: "toolCall", id: "old-edit", name: "edit" }], {
        input: 10,
        output: 2,
      }) + "\n",
      "utf8",
    );
    const baseline = snapshotSessionFiles(directory);

    fs.appendFileSync(
      file,
      [
        message([{ type: "toolCall", id: "old-edit", name: "edit" }], {
          input: 20,
          output: 4,
        }),
        message([{ type: "toolCall", id: "new-write", name: "write" }], {
          input: 30,
          output: 6,
        }),
        message([{ type: "toolCall", id: "new-bash", name: "bash" }]),
        "malformed resumed line",
      ].join("\n") + "\n",
      "utf8",
    );

    const facts = parseSessionFacts(directory, { baseline });
    assert.deepEqual(facts.requestedToolCalls, { edit: 0, write: 1, bash: 1 });
    assert.deepEqual(facts.tokens, { input: 50, output: 10, total: 60 });
    assert.equal(facts.hasUsage, true);
    assert.equal(facts.truncated, false);
  });

  it("streams cumulative token totals beyond the bounded attempt range", () => {
    const directory = tempDir();
    const file = path.join(directory, "long-session.jsonl");
    const records = Array.from({ length: 50_000 }, () => message([], { input: 1, output: 2 }));
    fs.writeFileSync(file, `${records.join("\n")}\n`, "utf8");

    assert.deepEqual(parseSessionTokens(directory), {
      input: 50_000,
      output: 100_000,
      total: 150_000,
    });
  });

  it("marks a truncated attempt range and withholds partial provider usage", () => {
    const directory = tempDir();
    const file = path.join(directory, "bounded-attempt.jsonl");
    fs.writeFileSync(file, message([], { input: 1, output: 1 }) + "\n", "utf8");
    const baseline = snapshotSessionFiles(directory);
    fs.appendFileSync(
      file,
      `${message([], { input: 2, output: 3 })}\n${"x".repeat(4 * 1024 * 1024)}\n`,
      "utf8",
    );

    const facts = parseSessionFacts(directory, { baseline });
    assert.equal(facts.truncated, true);
    assert.equal(facts.hasSession, true);
    assert.deepEqual(
      providerTokensForAttempt({
        sessionFacts: facts,
        runtimeUsage: { input: 99, output: 1 },
      }),
      { status: "unavailable" },
    );
  });
});
