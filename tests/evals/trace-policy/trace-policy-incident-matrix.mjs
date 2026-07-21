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
				"architect-invalid-pre-existing-changes-authorization-does-not-bypass-direct-mutation",
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
		id: "architect-deterministic-research-routing",
		incident: "gh-256",
		invariant: "Architect research routing follows explicit fixture metadata for unambiguous scenarios instead of natural-language intent classification.",
		sourceKind: "synthetic",
		coverage: {
			status: "covered",
			fixtureIds: [
				"architect-valid-github-history-routes-to-librarian",
				"architect-invalid-github-history-routes-to-web-scout",
				"architect-invalid-github-history-mixed-research-targets",
				"architect-valid-general-web-routes-to-web-scout",
				"architect-invalid-general-web-routes-to-repo-scout",
				"architect-valid-unfamiliar-repo-routes-to-repo-scout",
				"architect-invalid-unfamiliar-repo-routes-to-librarian",
			],
			ownerTicket: "tlhm-g0dz",
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
		id: "developer-blocking-contact-supervisor-stop-boundary",
		incident: "gh-256",
		invariant: "Developer must stop after a blocking contact_supervisor escalation fails or is unavailable; successful blocking escalation may continue, and a blocker report with no further tool work remains allowed.",
		sourceKind: "synthetic",
		coverage: {
			status: "covered",
			fixtureIds: [
				"developer-valid-blocking-contact-supervisor-success-continues",
				"developer-valid-blocking-contact-supervisor-failure-stops",
				"developer-valid-blocking-contact-supervisor-unavailable-stops",
				"developer-invalid-blocking-contact-supervisor-failure-continues",
			],
			ownerTicket: "tlhm-s7bk",
		},
	},
	{
		id: "developer-pre-existing-changes-preservation-boundary",
		incident: "gh-331",
		invariant: "The #331 pre-existing-changes boundary activates only when metadata.hasPreExistingChanges is exactly true. For Developer, risky Git commands that can overwrite or discard pre-existing changes require reviewed scoped authorization set to exact true; safe read-only Git variants and ordinary branch switches remain allowed, and bare checkout operand ambiguity stays documented as a syntax limitation. That authorization never bypasses other mutation boundaries, including Architect direct-source-mutation protection.",
		sourceKind: "synthetic",
		coverage: {
			status: "covered",
			fixtureIds: [
				"developer-invalid-pre-existing-changes-risky-git-reset",
				"developer-valid-pre-existing-changes-authorized-risky-git-reset",
				"developer-valid-pre-existing-changes-safe-git-variants",
				"developer-valid-pre-existing-changes-bare-checkout-ambiguity",
				"architect-invalid-pre-existing-changes-authorization-does-not-bypass-direct-mutation",
			],
			ownerTicket: "tlhm-hdng",
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
