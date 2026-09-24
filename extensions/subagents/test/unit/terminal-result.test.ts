import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SUBAGENT_TERMINAL_ATTEMPTS,
  MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES,
  MAX_SUBAGENT_WORKSPACE_EVIDENCE_BYTES,
  parseSubagentTerminalResult,
  terminalResultForStatusStep,
} from "../../src/shared/terminal-result.ts";
function availableSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    status: "available",
    statusPorcelainZ: " M src/main.ts\0?? notes.txt\0",
    worktreeDiffStat: " src/main.ts | 2 +−\n 1 file changed",
    indexDiffStat: "",
    ...overrides,
  };
}

function validTerminalResult(overrides: Record<string, unknown> = {}) {
  return {
    state: "completed",
    facts: {
      attempts: [
        {
          attempt: 1,
          exit: { code: 0, signal: null },
          durationMs: 125.5,
          providerTokens: {
            status: "available",
            usage: { input: 12, output: 8, total: 20 },
          },
          requestedToolCalls: { edit: 1, write: 2, bash: 3 },
          workspace: {
            baseline: availableSnapshot(),
            post: availableSnapshot({ statusPorcelainZ: " M src/main.ts\0" }),
            attribution: "exclusive",
          },
        },
      ],
    },
    ...overrides,
  };
}

function assertInvalid(value: unknown): void {
  assert.equal(parseSubagentTerminalResult(value), undefined);
}

describe("parseSubagentTerminalResult", () => {
  it("projects a canonical complete lifecycle step to terminal-result state", () => {
    const terminalResult = parseSubagentTerminalResult(validTerminalResult());
    assert.ok(terminalResult);
    const result = { terminalResult };
    const projected = terminalResultForStatusStep(result, "complete");

    assert.equal(projected?.state, "completed");
    assert.deepEqual(projected?.facts, terminalResult.facts);
    assert.notStrictEqual(projected, terminalResult);
  });

  it("parses every evidence field, including raw NUL-delimited porcelain", () => {
    const input = validTerminalResult();
    const parsed = parseSubagentTerminalResult(input);

    assert.deepEqual(parsed, input);
    assert.equal(
      parsed?.facts.attempts[0]?.workspace.baseline.statusPorcelainZ,
      " M src/main.ts\0?? notes.txt\0",
    );
    assert.notStrictEqual(parsed, input);
    assert.notStrictEqual(parsed?.facts, input.facts);
    assert.notStrictEqual(parsed?.facts.attempts[0], input.facts.attempts[0]);

    input.facts.attempts[0]!.workspace.baseline.statusPorcelainZ = "mutated\0";
    input.facts.attempts[0]!.providerTokens.usage.input = 99;
    assert.equal(
      parsed?.facts.attempts[0]?.workspace.baseline.statusPorcelainZ,
      " M src/main.ts\0?? notes.txt\0",
    );
    assert.equal(parsed?.facts.attempts[0]?.providerTokens.status, "available");
    if (parsed?.facts.attempts[0]?.providerTokens.status === "available") {
      assert.equal(parsed.facts.attempts[0].providerTokens.usage.input, 12);
    }
  });

  it("keeps unavailable usage and workspace reasons distinct from zero and empty evidence", () => {
    const value = validTerminalResult({
      state: "paused",
      facts: {
        attempts: [
          {
            attempt: 1,
            exit: { code: null, signal: "SIGTERM" },
            durationMs: 0,
            providerTokens: { status: "unavailable" },
            requestedToolCalls: { edit: 0, write: 0, bash: 0 },
            workspace: {
              baseline: { status: "unavailable", reason: "not_git_repository" },
              post: { status: "unavailable", reason: "command_failed" },
              attribution: "unknown",
            },
          },
        ],
      },
    });

    assert.deepEqual(parseSubagentTerminalResult(value), value);
  });

  it("requires contiguous one-based attempt sequencing", () => {
    const value = validTerminalResult();
    value.facts.attempts.push({
      ...value.facts.attempts[0]!,
      attempt: 3,
    });
    assertInvalid(value);

    const firstAttempt = validTerminalResult();
    firstAttempt.facts.attempts[0]!.attempt = 0;
    assertInvalid(firstAttempt);
  });

  it("accepts at most the bounded number of contiguous attempts", () => {
    const attempt = validTerminalResult().facts.attempts[0]!;
    const atLimit = validTerminalResult({
      facts: {
        attempts: Array.from({ length: MAX_SUBAGENT_TERMINAL_ATTEMPTS }, (_, index) => ({
          ...attempt,
          attempt: index + 1,
        })),
      },
    });
    assert.ok(parseSubagentTerminalResult(atLimit));

    const overLimit = validTerminalResult({
      facts: {
        attempts: Array.from({ length: MAX_SUBAGENT_TERMINAL_ATTEMPTS + 1 }, (_, index) => ({
          ...attempt,
          attempt: index + 1,
        })),
      },
    });
    assertInvalid(overLimit);
  });

  it("bounds aggregate workspace evidence across all snapshot fields", () => {
    const attempt = validTerminalResult().facts.attempts[0]!;
    const bytesPerField = Math.floor(MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES / 6);
    const remainder = MAX_SUBAGENT_TERMINAL_SNAPSHOT_BYTES % 6;
    const exactSizes = Array.from(
      { length: 6 },
      (_, index) => bytesPerField + (index < remainder ? 1 : 0),
    );
    const workspace = (sizes: number[]) => ({
      baseline: availableSnapshot({
        statusPorcelainZ: "x".repeat(sizes[0]!),
        worktreeDiffStat: "x".repeat(sizes[1]!),
        indexDiffStat: "x".repeat(sizes[2]!),
      }),
      post: availableSnapshot({
        statusPorcelainZ: "x".repeat(sizes[3]!),
        worktreeDiffStat: "x".repeat(sizes[4]!),
        indexDiffStat: "x".repeat(sizes[5]!),
      }),
      attribution: "exclusive",
    });
    const atLimit = validTerminalResult({
      facts: {
        attempts: [{ ...attempt, workspace: workspace(exactSizes) }],
      },
    });
    assert.ok(parseSubagentTerminalResult(atLimit));

    const overLimitSizes = [...exactSizes];
    overLimitSizes[0]! += 1;
    const overLimit = validTerminalResult({
      facts: {
        attempts: [{ ...attempt, workspace: workspace(overLimitSizes) }],
      },
    });
    assertInvalid(overLimit);
  });

  it("rejects unknown keys at every new-contract level", () => {
    const cases: unknown[] = [
      validTerminalResult({ extra: true }),
      validTerminalResult({
        facts: { ...validTerminalResult().facts, extra: true },
      }),
      validTerminalResult({
        facts: {
          attempts: [{ ...validTerminalResult().facts.attempts[0], extra: true }],
        },
      }),
      validTerminalResult({
        facts: {
          attempts: [
            {
              ...validTerminalResult().facts.attempts[0],
              exit: { code: 0, signal: null, extra: true },
            },
          ],
        },
      }),
      validTerminalResult({
        facts: {
          attempts: [
            {
              ...validTerminalResult().facts.attempts[0],
              providerTokens: { status: "unavailable", extra: true },
            },
          ],
        },
      }),
      validTerminalResult({
        facts: {
          attempts: [
            {
              ...validTerminalResult().facts.attempts[0],
              requestedToolCalls: { edit: 1, write: 2, bash: 3, extra: 4 },
            },
          ],
        },
      }),
      validTerminalResult({
        facts: {
          attempts: [
            {
              ...validTerminalResult().facts.attempts[0],
              workspace: {
                ...validTerminalResult().facts.attempts[0]!.workspace,
                extra: true,
              },
            },
          ],
        },
      }),
      validTerminalResult({
        facts: {
          attempts: [
            {
              ...validTerminalResult().facts.attempts[0],
              workspace: {
                ...validTerminalResult().facts.attempts[0]!.workspace,
                baseline: { ...availableSnapshot(), extra: true },
              },
            },
          ],
        },
      }),
      validTerminalResult({
        facts: {
          attempts: [
            {
              ...validTerminalResult().facts.attempts[0],
              workspace: {
                ...validTerminalResult().facts.attempts[0]!.workspace,
                post: { status: "unavailable", reason: "not_captured", extra: true },
              },
            },
          ],
        },
      }),
      validTerminalResult({
        facts: {
          attempts: [
            {
              ...validTerminalResult().facts.attempts[0],
              providerTokens: {
                status: "available",
                usage: { input: 12, output: 8, total: 20, extra: true },
              },
            },
          ],
        },
      }),
    ];
    for (const value of cases) assertInvalid(value);
  });

  it("rejects malformed numeric and tagged fields", () => {
    const attempt = validTerminalResult().facts.attempts[0]!;
    const cases: unknown[] = [
      validTerminalResult({ state: "complete" }),
      validTerminalResult({ state: "unknown" }),
      validTerminalResult({ facts: { attempts: [] } }),
      validTerminalResult({ facts: { attempts: "not-an-array" } }),
      validTerminalResult({ facts: { attempts: [null] } }),
      validTerminalResult({
        facts: { attempts: [{ ...attempt, attempt: 1.5 }] },
      }),
      validTerminalResult({
        facts: { attempts: [{ ...attempt, durationMs: -1 }] },
      }),
      validTerminalResult({
        facts: { attempts: [{ ...attempt, durationMs: Number.NaN }] },
      }),
      validTerminalResult({
        facts: {
          attempts: [{ ...attempt, exit: { code: -1, signal: null } }],
        },
      }),
      validTerminalResult({
        facts: {
          attempts: [{ ...attempt, exit: { code: 0, signal: "" } }],
        },
      }),
      validTerminalResult({
        facts: {
          attempts: [{ ...attempt, providerTokens: { status: "available", usage: "unknown" } }],
        },
      }),
      validTerminalResult({
        facts: {
          attempts: [{ ...attempt, requestedToolCalls: { edit: -1, write: 0, bash: 0 } }],
        },
      }),
      validTerminalResult({
        facts: {
          attempts: [
            {
              ...attempt,
              workspace: {
                ...attempt.workspace,
                attribution: "exclusive-ish",
              },
            },
          ],
        },
      }),
      validTerminalResult({
        facts: {
          attempts: [
            {
              ...attempt,
              workspace: {
                ...attempt.workspace,
                baseline: { status: "unavailable", reason: "invalid_output" },
              },
            },
          ],
        },
      }),
    ];
    for (const value of cases) assertInvalid(value);
  });

  it("bounds raw workspace evidence by UTF-8 byte length", () => {
    const exact = "x".repeat(MAX_SUBAGENT_WORKSPACE_EVIDENCE_BYTES);
    const over = `${exact}x`;
    const accepted = validTerminalResult({
      facts: {
        attempts: [
          {
            ...validTerminalResult().facts.attempts[0],
            workspace: {
              ...validTerminalResult().facts.attempts[0]!.workspace,
              baseline: availableSnapshot({ statusPorcelainZ: exact }),
            },
          },
        ],
      },
    });
    assert.ok(parseSubagentTerminalResult(accepted));

    const rejected = validTerminalResult({
      facts: {
        attempts: [
          {
            ...validTerminalResult().facts.attempts[0],
            workspace: {
              ...validTerminalResult().facts.attempts[0]!.workspace,
              baseline: availableSnapshot({ statusPorcelainZ: over }),
            },
          },
        ],
      },
    });
    assertInvalid(rejected);
  });
});
