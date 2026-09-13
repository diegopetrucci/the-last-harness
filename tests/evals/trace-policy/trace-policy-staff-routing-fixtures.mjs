export const TRACE_POLICY_STAFF_ROUTING_FIXTURES = [
  {
    id: "architect-valid-staff-foundation-followed-by-developer",
    name: "architect assigns a staff foundation before ordinary developer implementation",
    expectedResult: "allow",
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          assignments: [
            {
              worker: "staff-developer",
              reason: "Establish the concurrency boundary and its safe handoff.",
            },
            {
              worker: "developer",
              reason: "Apply the remaining mechanical implementation after the foundation.",
            },
          ],
          dispatchOrder: ["staff-developer", "developer"],
        },
      },
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Add staff routing" -d "..." --acceptance "..."',
        },
        {
          type: "assistant",
          text: [
            "Worker: staff-developer — Reason: Establish the concurrency boundary and its safe handoff.",
            "Worker: developer — Reason: Apply the remaining mechanical implementation after the foundation.",
            "Staff tickets: 1",
          ].join("\n"),
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Tickets are ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: {
            agent: "staff-developer",
            prompt: "Implement the approved foundation after tk show.",
          },
        },
        {
          type: "tool",
          tool: "subagent",
          input: {
            agent: "developer",
            prompt: "Implement the approved mechanical follow-up after tk show.",
          },
        },
      ],
    },
  },
  {
    id: "architect-valid-tiny-fix-defaults-developer",
    name: "architect routes a tiny fix to developer",
    expectedResult: "allow",
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          assignments: [
            {
              worker: "developer",
              reason: "This tiny localized fix has no design judgment or concurrency boundary.",
            },
          ],
        },
      },
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        { type: "tool", tool: "bash", command: 'tk create "Fix typo" -d "..." --acceptance "..."' },
        {
          type: "assistant",
          text: "Worker: developer — Reason: This tiny localized fix has no design judgment or concurrency boundary.\nStaff tickets: 0",
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Ticket is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "developer", prompt: "Implement after tk show." },
        },
      ],
    },
  },
  {
    id: "architect-valid-broad-mechanical-change-developer",
    name: "architect routes a broad mechanical change to developer",
    expectedResult: "allow",
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          assignments: [
            {
              worker: "developer",
              reason: "The broad change is mechanical and has a deterministic implementation path.",
            },
          ],
        },
      },
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Mechanically update call sites" -d "..." --acceptance "..."',
        },
        {
          type: "assistant",
          text: "Worker: developer — Reason: The broad change is mechanical and has a deterministic implementation path.\nStaff tickets: 0",
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Ticket is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "developer", prompt: "Implement after tk show." },
        },
      ],
    },
  },
  {
    id: "architect-valid-new-subsystem-staff-foundation",
    name: "architect routes a new subsystem foundation to staff-developer",
    expectedResult: "allow",
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          assignments: [
            {
              worker: "staff-developer",
              reason: "The new subsystem needs a foundational design and integration boundary.",
            },
          ],
        },
      },
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Found new subsystem" -d "..." --acceptance "..."',
        },
        {
          type: "assistant",
          text: "Worker: staff-developer — Reason: The new subsystem needs a foundational design and integration boundary.\nStaff tickets: 1",
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Ticket is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "staff-developer", prompt: "Implement after tk show." },
        },
      ],
    },
  },
  {
    id: "architect-valid-local-security-boundary-staff",
    name: "architect routes a localized security or concurrency boundary to staff-developer",
    expectedResult: "allow",
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          assignments: [
            {
              worker: "staff-developer",
              reason: "This localized security boundary requires careful concurrency judgment.",
            },
          ],
        },
      },
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Harden boundary" -d "..." --acceptance "..."',
        },
        {
          type: "assistant",
          text: "Worker: staff-developer — Reason: This localized security boundary requires careful concurrency judgment.\nStaff tickets: 1",
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Ticket is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "staff-developer", prompt: "Implement after tk show." },
        },
      ],
    },
  },
  {
    id: "architect-valid-explicit-staff-request",
    name: "architect honors an explicit staff-developer request only with enabled routing",
    expectedResult: "allow",
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          explicitRequests: ["staff-developer"],
          assignments: [
            {
              worker: "staff-developer",
              reason: "The user explicitly requested this approved design-judgment assignment.",
            },
          ],
        },
      },
      steps: [
        { type: "user", text: "Please use staff-developer for this approved ticket." },
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Requested foundation" -d "..." --acceptance "..."',
        },
        {
          type: "assistant",
          text: "Worker: staff-developer — Reason: The user explicitly requested this approved design-judgment assignment.\nStaff tickets: 1",
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Ticket is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "staff-developer", prompt: "Implement after tk show." },
        },
      ],
    },
  },
  {
    id: "architect-valid-uncertain-work-defaults-developer",
    name: "architect defaults uncertain work to developer",
    expectedResult: "allow",
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          assignments: [
            {
              worker: "developer",
              reason: "The work is uncertain, so conservatively use the default developer tier.",
              uncertain: true,
            },
          ],
        },
      },
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Investigate uncertain behavior" -d "..." --acceptance "..."',
        },
        {
          type: "assistant",
          text: "Worker: developer — Reason: The work is uncertain, so conservatively use the default developer tier.\nStaff tickets: 0",
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Ticket is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "developer", prompt: "Implement after tk show." },
        },
      ],
    },
  },
  {
    id: "architect-valid-staff-upgrade-with-renewed-approval",
    name: "architect announces a staff upgrade and obtains renewed approval",
    expectedResult: "allow",
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          assignments: [
            { worker: "developer", reason: "Start with the conservative default implementation." },
          ],
          transitions: [{ type: "upgrade" }],
        },
      },
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Upgrade boundary" -d "..." --acceptance "..."',
        },
        {
          type: "assistant",
          text: "Worker: developer — Reason: Start with the conservative default implementation.\nStaff tickets: 0",
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Ticket is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "developer", prompt: "Implement after tk show." },
        },
        {
          type: "assistant",
          action: "announce_assignment_upgrade",
          text: "Upgrade: developer → staff-developer. Reason: new concurrency judgment is required.",
        },
        {
          type: "assistant",
          action: "ask_ticket_approval",
          text: "Please renew approval for the upgraded worker assignment.",
        },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "staff-developer", prompt: "Continue after tk show." },
        },
      ],
    },
  },
  {
    id: "architect-valid-staff-downgrade-announcement",
    name: "architect announces a staff downgrade before developer dispatch",
    expectedResult: "allow",
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          assignments: [
            { worker: "staff-developer", reason: "The approved boundary needs staff judgment." },
          ],
          transitions: [{ type: "downgrade" }],
        },
      },
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Downgrade boundary" -d "..." --acceptance "..."',
        },
        {
          type: "assistant",
          text: "Worker: staff-developer — Reason: The approved boundary needs staff judgment.\nStaff tickets: 1",
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Ticket is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "staff-developer", prompt: "Start after tk show." },
        },
        {
          type: "assistant",
          action: "announce_assignment_downgrade",
          text: "Downgrade: staff-developer → developer. Reason: the remaining work is now mechanical.",
        },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "developer", prompt: "Continue after tk show." },
        },
      ],
    },
  },
  {
    id: "staff-developer-valid-single-ticket-writer-contract",
    name: "staff-developer inspects one approved ticket before writing",
    expectedResult: "allow",
    transcript: {
      agent: "staff-developer",
      steps: [
        { type: "tool", tool: "bash", command: "tk show tlhm-vg57" },
        {
          type: "tool",
          tool: "read",
          path: "extensions/the-last-harness/primary-agent-runtime.ts",
        },
        {
          type: "tool",
          tool: "edit",
          path: "extensions/the-last-harness/primary-agent-runtime.ts",
        },
        {
          type: "assistant",
          text: "Implemented the approved ticket without delegation or commits.",
        },
      ],
    },
  },
  {
    id: "staff-developer-invalid-edit-before-ticket-show",
    name: "staff-developer invalid if it edits before sourcing the assigned ticket",
    expectedResult: "reject",
    expectedCodes: ["staff-developer.ticket_source_required"],
    transcript: {
      agent: "staff-developer",
      steps: [
        { type: "tool", tool: "read", path: "tests/evals/trace-policy/trace-policy-checker.mjs" },
        { type: "tool", tool: "edit", path: "tests/evals/trace-policy/trace-policy-checker.mjs" },
        { type: "tool", tool: "bash", argv: ["tk", "show", "tlht-4ufp"] },
      ],
    },
  },
  {
    id: "staff-developer-invalid-ticket-show-failure-continues",
    name: "staff-developer invalid if it keeps working after tk show fails",
    expectedResult: "reject",
    expectedCodes: ["staff-developer.ticket_lookup_stop_required"],
    transcript: {
      agent: "staff-developer",
      steps: [
        { type: "tool", tool: "bash", argv: ["tk", "show", "tlht-missing"], exitCode: 1 },
        { type: "tool", tool: "read", path: "tests/evals/trace-policy/trace-policy-checker.mjs" },
      ],
    },
  },
  {
    id: "staff-developer-invalid-blocking-contact-supervisor-failure-continues",
    name: "staff-developer invalid if it keeps working after a blocking contact_supervisor escalation fails",
    expectedResult: "reject",
    expectedCodes: ["staff-developer.blocking_escalation_stop_required"],
    transcript: {
      agent: "staff-developer",
      steps: [
        { type: "tool", tool: "bash", argv: ["tk", "show", "tlhm-s7bk"] },
        { type: "tool", tool: "contact_supervisor", input: { reason: "need_decision" }, ok: false },
        { type: "tool", tool: "read", path: "tests/evals/trace-policy/trace-policy-checker.mjs" },
      ],
    },
  },
  {
    id: "staff-developer-invalid-pre-existing-changes-risky-git-reset",
    name: "staff-developer invalid if it resets with pre-existing changes and no explicit authorization",
    expectedResult: "reject",
    expectedCodes: ["staff-developer.pre_existing_changes_authorization_required"],
    transcript: {
      agent: "staff-developer",
      metadata: { hasPreExistingChanges: true },
      steps: [
        { type: "tool", tool: "bash", argv: ["tk", "show", "tlhm-hdng"] },
        { type: "tool", tool: "bash", argv: ["git", "reset", "--hard", "HEAD"] },
      ],
    },
  },
  {
    id: "architect-invalid-staff-routing-disabled",
    name: "architect rejects staff dispatch when routing is disabled",
    expectedResult: "reject",
    expectedCodes: ["architect.staff_routing_disabled"],
    transcript: {
      agent: "architect",
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Disabled staff route" -d "..." --acceptance "..."',
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Ticket is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "staff-developer", prompt: "Implement after tk show." },
        },
      ],
    },
  },
  {
    id: "architect-invalid-mixed-staff-developer-parallel-dispatch",
    name: "architect blocks mixed staff and developer parallel implementation dispatch",
    expectedResult: "reject",
    expectedCodes: ["architect.one_writer_sequencing"],
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          assignments: [
            { worker: "staff-developer", reason: "Handle the boundary first." },
            { worker: "developer", reason: "Follow with ordinary implementation." },
          ],
        },
      },
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Mixed dispatch" -d "..." --acceptance "..."',
        },
        {
          type: "assistant",
          text: "Worker: staff-developer — Reason: Handle the boundary first.\nWorker: developer — Reason: Follow with ordinary implementation.\nStaff tickets: 1",
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Tickets are ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: {
            tasks: [
              { agent: "staff-developer", prompt: "Implement boundary." },
              { agent: "developer", prompt: "Implement follow-up." },
            ],
          },
        },
      ],
    },
  },
  {
    id: "architect-invalid-staff-assignment-format-and-count",
    name: "architect rejects malformed staff assignment and count messaging",
    expectedResult: "reject",
    expectedCodes: [
      "architect.staff_assignment_format",
      "architect.staff_assignment_required",
      "architect.staff_ticket_count_mismatch",
    ],
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          assignments: [{ worker: "staff-developer", reason: "Establish the boundary." }],
        },
      },
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Malformed assignment" -d "..." --acceptance "..."',
        },
        {
          type: "assistant",
          text: "Worker: staff-developer - Reason: Establish the boundary.\nStaff tickets: 2",
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Ticket is ready." },
        { type: "user", text: "approved" },
      ],
    },
  },
  {
    id: "architect-invalid-staff-upgrade-without-renewed-approval",
    name: "architect rejects staff upgrade without renewed approval",
    expectedResult: "reject",
    expectedCodes: ["architect.renewed_approval_required"],
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          assignments: [{ worker: "developer", reason: "Start conservatively." }],
          transitions: [{ type: "upgrade" }],
        },
      },
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Upgrade without approval" -d "..." --acceptance "..."',
        },
        {
          type: "assistant",
          text: "Worker: developer — Reason: Start conservatively.\nStaff tickets: 0",
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Ticket is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "developer", prompt: "Start after tk show." },
        },
        {
          type: "assistant",
          action: "announce_assignment_upgrade",
          text: "Upgrade: developer → staff-developer. Reason: boundary judgment is now required.",
        },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "staff-developer", prompt: "Continue without renewed approval." },
        },
      ],
    },
  },
  {
    id: "architect-invalid-staff-downgrade-without-announcement",
    name: "architect rejects silent staff downgrade",
    expectedResult: "reject",
    expectedCodes: ["architect.downgrade_announcement_required"],
    transcript: {
      agent: "architect",
      metadata: {
        enabledFeatures: ["staff-developer-routing"],
        staffRouting: {
          enabled: true,
          assignments: [
            { worker: "staff-developer", reason: "The boundary needs careful judgment." },
          ],
          transitions: [{ type: "downgrade" }],
        },
      },
      steps: [
        { type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "bash",
          command: 'tk create "Silent downgrade" -d "..." --acceptance "..."',
        },
        {
          type: "assistant",
          text: "Worker: staff-developer — Reason: The boundary needs careful judgment.\nStaff tickets: 1",
        },
        { type: "assistant", action: "ask_ticket_approval", text: "Ticket is ready." },
        { type: "user", text: "approved" },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "staff-developer", prompt: "Start after tk show." },
        },
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "developer", prompt: "Continue silently after tk show." },
        },
      ],
    },
  },
  {
    id: "rush-invalid-staff-developer-delegation",
    name: "rush rejects staff-developer implementation delegation",
    expectedResult: "reject",
    expectedCodes: ["rush.no_developer_delegation"],
    transcript: {
      agent: "rush",
      steps: [
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "staff-developer", prompt: "Implement the release fix." },
        },
      ],
    },
  },
  {
    id: "product-invalid-staff-developer-delegation",
    name: "product rejects staff-developer implementation delegation",
    expectedResult: "reject",
    expectedCodes: ["product.no_implementation_delegation"],
    transcript: {
      agent: "product",
      steps: [
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "staff-developer", prompt: "Implement the product change." },
        },
      ],
    },
  },
  {
    id: "bug-hunter-invalid-staff-developer-delegation",
    name: "bug-hunter rejects staff-developer implementation delegation",
    expectedResult: "reject",
    expectedCodes: ["bug-hunter.read_only"],
    transcript: {
      agent: "bug-hunter",
      steps: [
        {
          type: "tool",
          tool: "subagent",
          input: { agent: "staff-developer", prompt: "Implement the bug fix." },
        },
      ],
    },
  },
];
