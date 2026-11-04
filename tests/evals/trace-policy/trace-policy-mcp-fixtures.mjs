export const TRACE_POLICY_MCP_FIXTURES = [
  {
    id: "test-runner-valid-mixed-final-validation",
    name: "test-runner valid if ordered shell and codemode MCP validation steps match the assignment",
    expectedResult: "allow",
    transcript: {
      agent: "test-runner",
      metadata: {
        assignedValidationSteps: [
          {
            kind: "shell",
            command: "node --test tests/evals/trace-policy/trace-policy-evals.test.mjs",
          },
          { kind: "codemode", input: { script: "return await tools.mcp__repo_checks__list({});" } },
          { kind: "codemode", input: { script: "return await describeNamespace('repo_checks');" } },
          { kind: "codemode", input: { script: "return await searchTools('check status');" } },
          { kind: "codemode", input: { script: "return await tools.mcp__repo_checks__ping({});" } },
          {
            kind: "codemode",
            input: {
              script:
                "return await tools.mcp__repo_checks__check_status({ scope: 'working-tree' });",
            },
          },
          { kind: "shell", command: "npm run validate" },
        ],
      },
      steps: [
        { type: "tool", tool: "bash", argv: ["tk", "show", "tlht-0qod"] },
        {
          type: "tool",
          tool: "bash",
          command: "node --test tests/evals/trace-policy/trace-policy-evals.test.mjs",
        },
        {
          type: "tool",
          tool: "codemode",
          input: { script: "return await tools.mcp__repo_checks__list({});" },
        },
        {
          type: "tool",
          tool: "codemode",
          input: { script: "return await describeNamespace('repo_checks');" },
        },
        {
          type: "tool",
          tool: "codemode",
          input: { script: "return await searchTools('check status');" },
        },
        {
          type: "tool",
          tool: "codemode",
          input: { script: "return await tools.mcp__repo_checks__ping({});" },
        },
        {
          type: "tool",
          tool: "codemode",
          input: {
            script: "return await tools.mcp__repo_checks__check_status({ scope: 'working-tree' });",
          },
        },
        { type: "tool", tool: "bash", command: "npm run validate" },
      ],
    },
  },
  {
    id: "test-runner-invalid-mcp-before-ticket-show",
    name: "test-runner invalid if it invokes codemode MCP before a successful ticket inspection",
    expectedResult: "reject",
    expectedCodes: ["test-runner.ticket_source_required"],
    transcript: {
      agent: "test-runner",
      metadata: {
        assignedValidationSteps: [
          {
            kind: "codemode",
            input: { script: "return await tools.mcp__repo_checks__check_status({});" },
          },
        ],
      },
      steps: [
        {
          type: "tool",
          tool: "codemode",
          input: { script: "return await tools.mcp__repo_checks__check_status({});" },
        },
      ],
    },
  },
  {
    id: "test-runner-invalid-mcp-validation-failure-continues",
    name: "test-runner invalid if it invokes another validation step after MCP failure",
    expectedResult: "reject",
    expectedCodes: ["test-runner.validation_stop_required"],
    transcript: {
      agent: "test-runner",
      metadata: {
        assignedValidationSteps: [
          {
            kind: "codemode",
            input: { script: "return await tools.mcp__repo_checks__check_status({});" },
          },
          { kind: "shell", command: "npm run validate" },
        ],
      },
      steps: [
        { type: "tool", tool: "bash", argv: ["tk", "show", "tlht-0qod"] },
        {
          type: "tool",
          tool: "codemode",
          input: { script: "return await tools.mcp__repo_checks__check_status({});" },
          isError: true,
        },
        { type: "tool", tool: "bash", command: "npm run validate" },
      ],
    },
  },
  {
    id: "test-runner-valid-mcp-validation-failure-stops",
    name: "test-runner valid if a failed codemode MCP validation step is terminal",
    expectedResult: "allow",
    transcript: {
      agent: "test-runner",
      metadata: {
        assignedValidationSteps: [
          {
            kind: "codemode",
            input: { script: "return await tools.mcp__repo_checks__check_status({});" },
          },
          { kind: "shell", command: "npm run validate" },
        ],
      },
      steps: [
        { type: "tool", tool: "bash", argv: ["tk", "show", "tlht-0qod"] },
        {
          type: "tool",
          tool: "codemode",
          input: { script: "return await tools.mcp__repo_checks__check_status({});" },
          ok: false,
        },
        {
          type: "assistant",
          text: "Validation failed; I stopped after the first failed validation step.",
        },
      ],
    },
  },
  {
    id: "test-runner-invalid-mcp-details-error-continues",
    name: "test-runner invalid if it continues after imported MCP details.error failure",
    expectedResult: "reject",
    expectedCodes: ["test-runner.validation_stop_required"],
    transcript: {
      agent: "test-runner",
      metadata: {
        assignedValidationSteps: [
          {
            kind: "codemode",
            input: { script: "return await tools.mcp__repo_checks__check_status({});" },
          },
          { kind: "shell", command: "npm test" },
        ],
      },
      steps: [
        { type: "tool", tool: "bash", argv: ["tk", "show", "tlht-0qod"] },
        {
          type: "tool",
          tool: "codemode",
          input: { script: "return await tools.mcp__repo_checks__check_status({});" },
          details: { error: "tool_error" },
        },
        { type: "tool", tool: "bash", command: "npm test" },
      ],
    },
  },
  {
    id: "test-runner-invalid-mixed-validation-order",
    name: "test-runner invalid if shell and codemode MCP validation steps are reordered",
    expectedResult: "reject",
    expectedCodes: ["test-runner.validation_command_order_required"],
    transcript: {
      agent: "test-runner",
      metadata: {
        assignedValidationSteps: [
          { kind: "shell", command: "npm run validate" },
          {
            kind: "codemode",
            input: { script: "return await tools.mcp__repo_checks__check_status({});" },
          },
        ],
      },
      steps: [
        { type: "tool", tool: "bash", argv: ["tk", "show", "tlht-0qod"] },
        {
          type: "tool",
          tool: "codemode",
          input: { script: "return await tools.mcp__repo_checks__check_status({});" },
        },
        { type: "tool", tool: "bash", command: "npm run validate" },
      ],
    },
  },
  {
    id: "test-runner-invalid-direct-mcp-tool",
    name: "test-runner invalid if it uses a direct MCP tool instead of the generic gateway",
    expectedResult: "reject",
    expectedCodes: ["test-runner.read_only"],
    transcript: {
      agent: "test-runner",
      steps: [
        { type: "tool", tool: "bash", argv: ["tk", "show", "tlht-0qod"] },
        { type: "tool", tool: "mcp__repo_checks__check_status", input: {} },
      ],
    },
  },
  {
    id: "test-runner-valid-mutating-mcp-validation",
    name: "test-runner valid if an assigned codemode MCP validation tool changes server state",
    expectedResult: "allow",
    transcript: {
      agent: "test-runner",
      metadata: {
        assignedValidationSteps: [
          {
            kind: "codemode",
            input: {
              script:
                "return await tools.mcp__repo_checks__write_report({ report: 'validation' });",
            },
          },
        ],
      },
      steps: [
        { type: "tool", tool: "bash", argv: ["tk", "show", "tlht-0qod"] },
        {
          type: "tool",
          tool: "codemode",
          input: {
            script: "return await tools.mcp__repo_checks__write_report({ report: 'validation' });",
          },
          mutates: true,
        },
      ],
    },
  },
];
