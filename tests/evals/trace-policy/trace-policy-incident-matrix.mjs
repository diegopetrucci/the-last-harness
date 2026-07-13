export const TRACE_POLICY_INCIDENT_MATRIX = [
	{
		id: "gh-205-final-validation-no-edit",
		incident: "gh-205",
		invariant: "Validation-only/final-validation developer runs may complete successfully with no source edits when validation passes and the task explicitly says not to edit unless validation fails in scope.",
		sourceKind: "synthetic",
		coverage: {
			status: "covered",
			fixtureIds: ["developer-valid-final-validation-no-edit"],
			ownerTicket: "tlht-4ufp",
		},
	},
	{
		id: "gh-217-subagent-agentdirs-preserved",
		incident: "gh-217",
		invariant: "TLH install/update/settings merge must preserve or repair bundled subagents.agentDirs without clobbering overrides.",
		sourceKind: "settings-fixture",
		coverage: {
			status: "planned",
			owner: "future installer/settings work",
		},
	},
	{
		id: "architect-direct-source-mutation-boundary",
		incident: "gh-241",
		invariant: "Architect may not directly mutate source files; implementation belongs to developer after approvals.",
		sourceKind: "synthetic",
		coverage: {
			status: "covered",
			fixtureIds: [
				"architect-invalid-direct-source-edit",
				"architect-invalid-direct-source-write",
			],
			ownerTicket: "tlht-sp6g",
		},
	},
	{
		id: "architect-ticket-approval-boundary",
		incident: "gh-241",
		invariant: "Architect may not delegate to developer until tickets are approved.",
		sourceKind: "synthetic",
		coverage: {
			status: "covered",
			fixtureIds: ["architect-invalid-developer-before-ticket-approval"],
			ownerTicket: "tlht-sp6g",
		},
	},
	{
		id: "architect-paused-subagent-recovery-boundary",
		incident: "gh-241",
		invariant: "A paused or interrupted developer dispatch is recoverable state, not authorization for architect to edit directly; architect must resume, re-dispatch, ask, or stop.",
		sourceKind: "synthetic",
		coverage: {
			status: "covered",
			fixtureIds: [
				"architect-valid-paused-developer-redispatch",
				"architect-invalid-direct-edit-after-paused-developer",
				"architect-invalid-direct-write-after-interrupted-developer",
			],
			ownerTicket: "tlhf-hsdl",
		},
	},
	{
		id: "architect-review-digest-boundary",
		incident: "gh-241",
		invariant: "Architect must digest code-reviewer output into its own review summary instead of relaying raw reviewer text.",
		sourceKind: "synthetic",
		coverage: {
			status: "covered",
			fixtureIds: [
				"architect-valid-digested-review-summary",
				"architect-invalid-raw-reviewer-relay",
			],
			ownerTicket: "tlhf-hsdl",
		},
	},
	{
		id: "developer-ticket-source-before-edit",
		incident: "gh-241",
		invariant: "Developer must run and obey tk show <id> before editing, and must stop if the assigned ticket cannot be shown.",
		sourceKind: "synthetic",
		coverage: {
			status: "covered",
			fixtureIds: [
				"developer-valid-ticket-show-before-edit",
				"developer-invalid-edit-before-ticket-show",
				"developer-valid-ticket-show-failure-stops",
				"developer-invalid-ticket-show-failure-continues",
				"developer-valid-final-validation-no-edit",
			],
			ownerTicket: "tlht-4ufp",
		},
	},
	{
		id: "code-reviewer-read-only-diff-inspection",
		incident: "gh-241",
		invariant: "Code-reviewer remains read-only and inspects VCS diff inputs before findings.",
		sourceKind: "synthetic",
		coverage: {
			status: "covered",
			fixtureIds: [
				"code-reviewer-valid-read-only-diff-review",
				"code-reviewer-invalid-findings-before-diff-inspection",
				"code-reviewer-invalid-mutating-command",
			],
			ownerTicket: "tlht-4ufp",
		},
	},
	{
		id: "web-scout-citation-discipline",
		incident: "gh-241",
		invariant: "Web-scout output includes URL, UTC retrieval timestamp, and short verbatim quote/source evidence using deterministic mechanical citation checks only.",
		sourceKind: "synthetic",
		coverage: {
			status: "covered",
			fixtureIds: [
				"web-scout-valid-search-budget",
				"web-scout-invalid-missing-citation-url",
				"web-scout-invalid-missing-citation-timestamp",
				"web-scout-invalid-missing-citation-quote",
				"web-scout-invalid-over-budget-quote",
			],
			ownerTicket: "tlht-ab6p",
		},
	},
	{
		id: "installer-profile-isolation-safety",
		incident: "gh-241",
		invariant: "TLH install/update/eval tooling must use isolated temp/profile paths and must not mutate normal ~/.pi/agent.",
		sourceKind: "live-smoke",
		coverage: {
			status: "planned",
			owner: "future installer/eval safety work",
		},
	},
];
