import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatTracePolicyFixtureSkeleton,
  importTracePolicyFixtureFromText,
} from "./trace-policy-fixture-importer.mjs";
import { evaluateTracePolicy } from "./trace-policy-checker.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const importerPath = join(
  repoRoot,
  "tests",
  "evals",
  "trace-policy",
  "trace-policy-fixture-importer.mjs",
);

test("trace-policy fixture importer redacts volatile paths ids timestamps and secret-like values", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      transcript: {
        agent: "developer",
        steps: [
          {
            type: "assistant",
            text: "Checking /Users/alice/.the-last-harness/agent on 2026-07-07T17:11:04.123Z with run_a1b2c3d4e5f6 and 123e4567-e89b-12d3-a456-426614174000",
            timestamp: "2026-07-07T17:11:04.123Z",
          },
          {
            type: "tool",
            tool: "bash",
            command:
              "OPENAI_API_KEY=sk-test password=lower-secret api_key='quoted-secret' bearer=unused printenv HOME && cat /var/folders/xx/yy/T/session-123/output.log && echo Bearer secret-token",
            path: "/Users/alice/project/tests/evals/trace-policy/fixture.json",
            input: {
              env: {
                HOME: "/Users/alice",
                TMPDIR: "/private/tmp/tlh-123",
                OPENAI_API_KEY: "sk-test",
              },
              traceId: "toolu_01HZX3R5J2N7QP9KJ3ZXCVBNM1",
              nested: {
                sessionToken: "very-secret",
                reportPath: "/tmp/tlh-456/report.json",
              },
            },
            id: "msg_01HZX3R5J2N7QP9KJ3ZXCVBNM1",
          },
        ],
      },
    }),
  );

  assert.equal(fixture.id, "imported-trace");
  assert.equal(fixture.transcript.agent, "developer");
  assert.deepEqual(fixture.transcript.steps[0], {
    type: "assistant",
    text: "Checking <HOME>/.the-last-harness/agent on <TIMESTAMP> with <ID> and <UUID>",
  });
  assert.deepEqual(fixture.transcript.steps[1], {
    type: "tool",
    tool: "bash",
    command:
      "OPENAI_API_KEY=<REDACTED> password=<REDACTED> api_key=<REDACTED> bearer=<REDACTED> printenv HOME && cat <TMP>/session-123/output.log && echo Bearer <REDACTED>",
    path: "<HOME>/project/tests/evals/trace-policy/fixture.json",
    input: {
      env: {
        HOME: "<HOME>",
        TMPDIR: "<TMP>/tlh-123",
        OPENAI_API_KEY: "<REDACTED>",
      },
      traceId: "<ID>",
      nested: {
        sessionToken: "<REDACTED>",
        reportPath: "<TMP>/tlh-456/report.json",
      },
    },
  });
  assert.match(formatTracePolicyFixtureSkeleton(fixture), /expectedResult: "allow"/);
});

test("trace-policy fixture importer quotes unsafe object keys in skeleton output", () => {
  const skeleton = formatTracePolicyFixtureSkeleton({
    safeKey: true,
    "x-api-key": "<REDACTED>",
    "tool-call": {
      "nested value": "ok",
    },
  });

  assert.match(skeleton, /safeKey: true/);
  assert.match(skeleton, /"x-api-key": "<REDACTED>"/);
  assert.match(skeleton, /"tool-call":/);
  assert.match(skeleton, /"nested value": "ok"/);
});

test("trace-policy fixture importer normalizes assistant content array object text", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      agent: "developer",
      steps: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Opened /Users/alice/project at 2026-07-07T17:11:04Z" },
            { output_text: "API_TOKEN=super-secret" },
            { output_text: "password=lower-secret api_key='quoted-secret'" },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(fixture.transcript.steps, [
    {
      type: "assistant",
      text: "Opened <HOME>/project at <TIMESTAMP>\nAPI_TOKEN=<REDACTED>\npassword=<REDACTED> api_key=<REDACTED>",
    },
  ]);
});

test("trace-policy fixture importer redacts nested sensitive values", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      agent: "developer",
      steps: [
        {
          type: "tool",
          tool: "bash",
          input: {
            apiKeys: ["sk-one", { backup: "sk-two" }],
            auth: { bearer: "token", nested: { refresh: "secret" } },
            bearer: "direct-token",
            cookie: ["a=b", "c=d"],
            session: { id: "session_abcdef123456", file: "/Users/alice/session.json" },
            nonSensitive: { path: "/Users/alice/project" },
          },
        },
      ],
    }),
  );

  assert.deepEqual(fixture.transcript.steps[0].input, {
    apiKeys: "<REDACTED>",
    auth: "<REDACTED>",
    bearer: "<REDACTED>",
    cookie: "<REDACTED>",
    session: "<REDACTED>",
    nonSensitive: { path: "<HOME>/project" },
  });
});

test("trace-policy fixture importer redacts bearer assignments in normalized strings", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      agent: "developer",
      steps: [
        {
          type: "assistant",
          text: "Set bearer=plain-token and Bearer='quoted-token' before echo Bearer session-token",
        },
      ],
    }),
  );

  assert.deepEqual(fixture.transcript.steps, [
    {
      type: "assistant",
      text: "Set bearer=<REDACTED> and Bearer=<REDACTED> before echo Bearer <REDACTED>",
    },
  ]);
});

test("trace-policy fixture importer drops snake_case volatile fields and normalizes generated ids", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      agent: "developer",
      steps: [
        {
          type: "tool",
          tool: "bash",
          input: {
            created_at: 1783450000000,
            updated_at: "2026-07-07T17:11:04Z",
            timestamp_ms: 1783450000000,
            trace_id: "trace_abcdef123456",
            request_id: "req_abcdef123456",
            keptText: "request req_abcdef123456 and trace trace-abcdef123456 finished",
          },
        },
      ],
    }),
  );

  assert.deepEqual(fixture.transcript.steps[0].input, {
    keptText: "request <ID> and trace <ID> finished",
  });
});

test("trace-policy fixture importer accepts standalone assistant, user, and tool records", () => {
  const cases = [
    {
      name: "assistant",
      input: { type: "assistant", text: "I read /Users/alice/project at 2026-07-07T17:11:04Z" },
      expectedAgent: "developer",
      expectedSteps: [{ type: "assistant", text: "I read <HOME>/project at <TIMESTAMP>" }],
    },
    {
      name: "user",
      input: { role: "user", content: "Please inspect /Users/alice/project" },
      expectedAgent: "developer",
      expectedSteps: [{ type: "user", text: "Please inspect <HOME>/project" }],
    },
    {
      name: "tool",
      input: { type: "tool", tool: "read", path: "/tmp/tlh-live-evals-123/input.json" },
      expectedAgent: "developer",
      expectedSteps: [{ type: "tool", tool: "read", path: "<TMP>/tlh-live-evals-123/input.json" }],
    },
    {
      name: "agent override",
      input: {
        role: "assistant",
        agent: "architect",
        content: "Please inspect /Users/alice/project",
      },
      expectedAgent: "architect",
      expectedSteps: [{ type: "assistant", text: "Please inspect <HOME>/project" }],
    },
  ];

  for (const { name, input, expectedAgent, expectedSteps } of cases) {
    const fixture = importTracePolicyFixtureFromText(JSON.stringify(input), { agent: "developer" });
    assert.equal(fixture.transcript.agent, expectedAgent, `${name} agent`);
    assert.deepEqual(fixture.transcript.steps, expectedSteps, name);
  }
});

test("trace-policy fixture importer preserves named wrapper role-based agent extraction", () => {
  const cases = [
    {
      name: "steps wrapper",
      input: {
        role: "architect",
        name: "wrapper-agent",
        steps: [{ role: "assistant", content: "Ready" }],
      },
    },
    {
      name: "events wrapper",
      input: {
        role: "architect",
        name: "wrapper-agent",
        events: [{ role: "assistant", content: "Ready" }],
      },
    },
    {
      name: "messages wrapper",
      input: {
        role: "architect",
        name: "wrapper-agent",
        messages: [{ message: { role: "assistant", content: "Ready" } }],
      },
    },
    {
      name: "transcript steps wrapper",
      input: {
        transcript: {
          role: "architect",
          name: "wrapper-agent",
          steps: [{ role: "assistant", content: "Ready" }],
        },
      },
    },
  ];

  for (const { name, input } of cases) {
    const fixture = importTracePolicyFixtureFromText(JSON.stringify(input), { agent: "developer" });
    assert.equal(fixture.transcript.agent, "architect", `${name} agent`);
    assert.deepEqual(
      fixture.transcript.steps,
      [
        {
          type: "assistant",
          text: "Ready",
        },
      ],
      name,
    );
  }
});

test("trace-policy fixture importer keeps named assistant messages as assistant steps", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      agent: "developer",
      steps: [
        {
          role: "assistant",
          name: "assistant-alias",
          content: "I read /Users/alice/project at 2026-07-07T17:11:04Z",
        },
      ],
    }),
  );

  assert.deepEqual(fixture.transcript.steps, [
    {
      type: "assistant",
      text: "I read <HOME>/project at <TIMESTAMP>",
    },
  ]);
});

test("trace-policy fixture importer emits tool steps from assistant toolCall blocks while preserving assistant text", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      agent: "developer",
      steps: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Editing /Users/alice/project at 2026-07-07T17:11:04Z" },
            { type: "toolCall", name: "edit", arguments: { path: "src/greeter.mjs" } },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(fixture.transcript.steps, [
    {
      type: "assistant",
      text: "Editing <HOME>/project at <TIMESTAMP>",
    },
    {
      type: "tool",
      tool: "edit",
      path: "src/greeter.mjs",
    },
  ]);
});

test("trace-policy fixture importer correlates Pi toolResult failures onto the canonical tool call", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      agent: "developer",
      messages: [
        {
          type: "message",
          id: "assistant-1",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Escalating blocker from /Users/alice/project" },
              {
                type: "toolCall",
                id: "call_contact_supervisor_01HZX3R5J2N7QP9KJ3ZXCVBNM1",
                name: "contact_supervisor",
                arguments: {
                  reason: "need_decision",
                  message: "Need approval for /Users/alice/project",
                },
              },
            ],
          },
        },
        {
          type: "message",
          id: "tool-result-1",
          message: {
            role: "toolResult",
            toolCallId: "call_contact_supervisor_01HZX3R5J2N7QP9KJ3ZXCVBNM1",
            toolName: "contact_supervisor",
            isError: true,
            content: [
              {
                type: "text",
                text: "raw sensitive output /Users/alice/.config/token.txt api_key=secret",
              },
            ],
            details: {
              exitCode: 7,
              status: "failed",
              error: "blocking reply unavailable",
            },
          },
        },
        {
          type: "message",
          id: "assistant-2",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Trying another tool anyway." }],
          },
        },
        {
          type: "message",
          id: "assistant-3",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_read_2",
                name: "read",
                arguments: { path: "tests/evals/trace-policy/trace-policy-checker.mjs" },
              },
            ],
          },
        },
      ],
    }),
  );

  assert.deepEqual(fixture.transcript.steps, [
    {
      type: "assistant",
      text: "Escalating blocker from <HOME>/project",
    },
    {
      type: "tool",
      tool: "contact_supervisor",
      status: "failed",
      exitCode: 7,
      ok: false,
      details: { error: "blocking reply unavailable" },
      input: {
        reason: "need_decision",
        message: "Need approval for <HOME>/project",
      },
    },
    {
      type: "assistant",
      text: "Trying another tool anyway.",
    },
    {
      type: "tool",
      tool: "read",
      path: "tests/evals/trace-policy/trace-policy-checker.mjs",
    },
  ]);
  assert.equal(JSON.stringify(fixture.transcript.steps).includes("raw sensitive output"), false);
  assert.deepEqual(
    evaluateTracePolicy(fixture.transcript).violations.map((violation) => violation.code),
    ["developer.blocking_escalation_stop_required"],
  );
});

test("trace-policy fixture importer preserves MCP details.error and validation stops on it", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      agent: "test-runner",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_bash_1",
              name: "bash",
              arguments: { command: "tk show tlht-0qod" },
            },
            {
              type: "toolCall",
              id: "call_mcp_1",
              name: "mcp",
              arguments: {
                server: "repo-checks",
                tool: "check_status",
                args: "{}",
              },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_mcp_1",
          toolName: "mcp",
          details: { error: "tool_error" },
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
        },
      ],
    }),
  );

  assert.deepEqual(fixture.transcript.steps, [
    { type: "tool", tool: "bash", command: "tk show tlht-0qod" },
    {
      type: "tool",
      tool: "mcp",
      input: { server: "repo-checks", tool: "check_status", args: "{}" },
      ok: false,
      status: "failed",
      details: { error: "tool_error" },
    },
    { type: "tool", tool: "bash", command: "npm test" },
  ]);
  fixture.transcript.metadata = {
    assignedValidationSteps: [
      { kind: "mcp", input: { server: "repo-checks", tool: "check_status", args: "{}" } },
      { kind: "shell", command: "npm test" },
    ],
  };
  assert.deepEqual(
    evaluateTracePolicy(fixture.transcript).violations.map((violation) => violation.code),
    ["test-runner.validation_stop_required"],
  );
});

test("trace-policy fixture importer keeps MCP non-failure details stable across re-import", () => {
  for (const error of [
    "auth_required",
    "not_connected",
    "not_found",
    "empty_query",
    "tool_not_found",
    "connect_failed",
  ]) {
    const firstImport = importTracePolicyFixtureFromText(
      JSON.stringify({
        agent: "test-runner",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_bash_1",
                name: "bash",
                arguments: { command: "tk show tlht-0qod" },
              },
              {
                type: "toolCall",
                id: "call_mcp_1",
                name: "mcp",
                arguments: { server: "repo-checks" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_mcp_1",
            toolName: "mcp",
            details: { error },
          },
        ],
      }),
    );
    const reimport = importTracePolicyFixtureFromText(JSON.stringify(firstImport));
    const expectedSteps = [
      { type: "tool", tool: "bash", command: "tk show tlht-0qod" },
      {
        type: "tool",
        tool: "mcp",
        input: { server: "repo-checks" },
        details: { error },
      },
    ];

    assert.deepEqual(firstImport.transcript.steps, expectedSteps, error);
    assert.deepEqual(reimport.transcript.steps, expectedSteps, error);
    for (const imported of [firstImport, reimport]) {
      imported.transcript.metadata = {
        assignedValidationSteps: [{ kind: "mcp", input: { server: "repo-checks" } }],
      };
      assert.deepEqual(evaluateTracePolicy(imported.transcript).violations, [], error);
    }
  }
});

test("trace-policy fixture importer keeps nested MCP failure when top-level error is falsy", () => {
  for (const error of [false, 0, "", null]) {
    const firstImport = importTracePolicyFixtureFromText(
      JSON.stringify({
        agent: "test-runner",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_bash_1",
                name: "bash",
                arguments: { command: "tk show tlht-0qod" },
              },
              {
                type: "toolCall",
                id: "call_mcp_1",
                name: "mcp",
                arguments: { server: "repo-checks" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_mcp_1",
            toolName: "mcp",
            error,
            details: { error: "tool_error" },
          },
        ],
      }),
    );
    const reimport = importTracePolicyFixtureFromText(JSON.stringify(firstImport));

    for (const imported of [firstImport, reimport]) {
      assert.deepEqual(
        imported.transcript.steps,
        [
          { type: "tool", tool: "bash", command: "tk show tlht-0qod" },
          {
            type: "tool",
            tool: "mcp",
            input: { server: "repo-checks" },
            ok: false,
            status: "failed",
            details: { error: "tool_error" },
          },
        ],
        String(error),
      );
      imported.transcript.metadata = {
        assignedValidationSteps: [
          { kind: "mcp", input: { server: "repo-checks" } },
          { kind: "shell", command: "npm test" },
        ],
      };
      assert.deepEqual(
        evaluateTracePolicy({
          ...imported.transcript,
          steps: [
            ...imported.transcript.steps,
            { type: "tool", tool: "bash", command: "npm test" },
          ],
        }).violations.map((violation) => violation.code),
        ["test-runner.validation_stop_required"],
        String(error),
      );
    }
  }
});

test("trace-policy fixture importer preserves top-level and details status=error failures", () => {
  for (const result of [{ status: "error" }, { details: { status: "error" } }]) {
    const fixture = importTracePolicyFixtureFromText(
      JSON.stringify({
        agent: "test-runner",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_bash_1",
                name: "bash",
                arguments: { command: "tk show tlht-0qod" },
              },
              {
                type: "toolCall",
                id: "call_mcp_1",
                name: "mcp",
                arguments: { server: "repo-checks", tool: "check_status", args: "{}" },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_mcp_1",
            toolName: "mcp",
            ...result,
          },
          {
            role: "assistant",
            content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
          },
        ],
      }),
    );
    fixture.transcript.metadata = {
      assignedValidationSteps: [
        { kind: "mcp", input: { server: "repo-checks", tool: "check_status", args: "{}" } },
        { kind: "shell", command: "npm test" },
      ],
    };

    assert.deepEqual(fixture.transcript.steps, [
      { type: "tool", tool: "bash", command: "tk show tlht-0qod" },
      {
        type: "tool",
        tool: "mcp",
        input: { server: "repo-checks", tool: "check_status", args: "{}" },
        ok: false,
        status: "error",
      },
      { type: "tool", tool: "bash", command: "npm test" },
    ]);
    assert.deepEqual(
      evaluateTracePolicy(fixture.transcript).violations.map((violation) => violation.code),
      ["test-runner.validation_stop_required"],
    );
  }
});

test("trace-policy fixture importer narrows nested failure details and redacts retained values", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      agent: "test-runner",
      steps: [
        {
          type: "tool",
          tool: "mcp",
          input: { server: "repo-checks", tool: "check_status", args: "{}" },
          details: {
            ok: false,
            status: "error",
            exitCode: 7,
            error: {
              message: "failed at /Users/alice/project",
              apiToken: "secret-value",
            },
            output: "raw output /Users/alice/private.log",
            results: [{ output: "unrelated tool result" }],
            session: { token: "another-secret" },
          },
        },
      ],
    }),
  );

  assert.deepEqual(fixture.transcript.steps[0].details, {
    ok: false,
    status: "error",
    exitCode: 7,
    error: {
      message: "failed at <HOME>/project",
      apiToken: "<REDACTED>",
    },
  });
  assert.deepEqual(Object.keys(fixture.transcript.steps[0].details), [
    "ok",
    "status",
    "exitCode",
    "error",
  ]);
  assert.equal(JSON.stringify(fixture.transcript.steps).includes("unrelated tool result"), false);
  assert.equal(JSON.stringify(fixture.transcript.steps).includes("another-secret"), false);
});

test("trace-policy fixture importer preserves top-level failure flags through re-import", () => {
  const input = {
    server: "repo-checks",
    tool: "check_status",
    args: "{}",
  };
  const cases = [
    { name: "isError", failure: { isError: true } },
    {
      name: "error",
      failure: { error: "top-level API_TOKEN=secret at /Users/alice/project" },
    },
  ];

  for (const { name, failure } of cases) {
    const firstImport = importTracePolicyFixtureFromText(
      JSON.stringify({
        agent: "test-runner",
        steps: [
          { type: "tool", tool: "bash", argv: ["tk", "show", "tlht-0qod"] },
          { type: "tool", tool: "mcp", input, ...failure },
          { type: "tool", tool: "bash", command: "npm test" },
        ],
      }),
    );
    const reimport = importTracePolicyFixtureFromText(JSON.stringify(firstImport));

    assert.deepEqual(reimport.transcript.steps, firstImport.transcript.steps, name);
    if (name === "isError") {
      assert.equal(reimport.transcript.steps[1].isError, true);
    } else {
      assert.equal(
        reimport.transcript.steps[1].error,
        "top-level API_TOKEN=<REDACTED> at <HOME>/project",
      );
    }

    for (const imported of [firstImport, reimport]) {
      imported.transcript.metadata = {
        assignedValidationSteps: [
          { kind: "mcp", input },
          { kind: "shell", command: "npm test" },
        ],
      };
      assert.deepEqual(
        evaluateTracePolicy(imported.transcript).violations.map((violation) => violation.code),
        ["test-runner.validation_stop_required"],
        name,
      );
    }
  }
});

test("trace-policy fixture importer ignores falsy tool-result errors", () => {
  const cases = [
    { name: "false", error: false },
    { name: "zero", error: 0 },
    { name: "empty string", error: "" },
    { name: "null", error: null },
    { name: "undefined", error: undefined },
  ];

  for (const { name, error } of cases) {
    const toolCallId = `call_mcp_${name.replaceAll(" ", "-")}`;
    const fixture = importTracePolicyFixtureFromText(
      JSON.stringify({
        agent: "test-runner",
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: toolCallId, name: "mcp", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId,
            toolName: "mcp",
            error,
          },
        ],
      }),
    );

    assert.deepEqual(fixture.transcript.steps, [{ type: "tool", tool: "mcp" }], name);
  }
});

test("trace-policy fixture importer canonicalizes ordered MCP status calls", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      agent: "test-runner",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_bash_1",
              name: "bash",
              arguments: { command: "tk show tlht-0qod" },
            },
            {
              type: "toolCall",
              id: "call_mcp_status_1",
              name: "mcp",
              arguments: {},
            },
            {
              type: "toolCall",
              id: "call_mcp_call_1",
              name: "mcp",
              arguments: { tool: "check_status", args: "{}" },
            },
          ],
        },
      ],
    }),
  );
  fixture.transcript.metadata = {
    assignedValidationSteps: [
      { kind: "mcp", input: {} },
      { kind: "mcp", input: { tool: "check_status", args: "{}" } },
    ],
  };

  assert.deepEqual(fixture.transcript.steps, [
    { type: "tool", tool: "bash", command: "tk show tlht-0qod" },
    { type: "tool", tool: "mcp" },
    {
      type: "tool",
      tool: "mcp",
      input: { tool: "check_status", args: "{}" },
    },
  ]);
  assert.deepEqual(evaluateTracePolicy(fixture.transcript).violations, []);
});

test("trace-policy fixture importer preserves successful Pi toolCall imports without a duplicate result step", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      agent: "developer",
      messages: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_read_1",
                name: "read",
                arguments: { path: "/Users/alice/project/README.md" },
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call_read_1",
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: "README content" }],
            details: { exitCode: 0 },
          },
        },
      ],
    }),
  );

  assert.deepEqual(fixture.transcript.steps, [
    {
      type: "tool",
      tool: "read",
      path: "<HOME>/project/README.md",
    },
  ]);
});
test("trace-policy fixture importer normalizes Windows home and temp subpaths", () => {
  const fixture = importTracePolicyFixtureFromText(
    JSON.stringify({
      agent: "developer",
      steps: [
        {
          type: "tool",
          tool: "read",
          path: "C:\\Users\\alice\\project\\trace.json",
          input: {
            cachePath: "C:\\Users\\alice\\AppData\\Local\\Temp\\tlh-123\\trace.json",
          },
        },
      ],
    }),
  );

  assert.deepEqual(fixture.transcript.steps, [
    {
      type: "tool",
      tool: "read",
      path: "<HOME>/project/trace.json",
      input: {
        cachePath: "<TMP>/tlh-123/trace.json",
      },
    },
  ]);
});

test("trace-policy fixture importer CLI emits a reviewable skeleton from JSONL input", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-trace-policy-importer-"));
  const inputPath = join(tempDir, "sample-trace.jsonl");
  writeFileSync(
    inputPath,
    [
      JSON.stringify({
        type: "assistant",
        text: "Plan saved at /Users/alice/tmp on 2026-07-07T17:11:04Z",
      }),
      JSON.stringify({ type: "tool", tool: "read", path: "/tmp/tlh-live-evals-123/input.json" }),
    ].join("\n"),
    "utf8",
  );

  try {
    const result = spawnSync(
      process.execPath,
      [importerPath, inputPath, "--agent", "architect", "--reject"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /id: "sample-trace"/);
    assert.match(result.stdout, /name: "imported sample trace"/);
    assert.match(result.stdout, /expectedResult: "reject"/);
    assert.match(result.stdout, /agent: "architect"/);
    assert.match(result.stdout, /<HOME>\/tmp/);
    assert.match(result.stdout, /<TIMESTAMP>/);
    assert.match(result.stdout, /<TMP>\/tlh-live-evals-123\/input\.json/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("trace-policy fixture importer CLI prefers --id over the input filename", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-trace-policy-importer-"));
  const inputPath = join(tempDir, "sample-trace.jsonl");
  writeFileSync(inputPath, JSON.stringify([{ type: "assistant", text: "Ready" }]), "utf8");

  try {
    const result = spawnSync(process.execPath, [importerPath, inputPath, "--id", "custom-trace"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /id: "custom-trace"/);
    assert.match(result.stdout, /name: "imported custom trace"/);
    assert.doesNotMatch(result.stdout, /id: "sample-trace"/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
