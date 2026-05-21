---
id: tlha-r5ob
status: open
deps: []
links: []
created: 2026-05-20T12:38:54Z
type: task
priority: 3
assignee: Diego Petrucci
---
# Add explicit opt-out for subscription-usage footer fetches

README disclosure in tlha-0s0w accurately tells users the footer queries undocumented vendor endpoints, but only offers a stub mitigation ('explicit disable mechanism is out of scope for this release'). Either tighten the phrasing to point users at switching off the affected OAuth provider as a current workaround, OR implement a /usage subscription off|on toggle that persists into tlh.usageLimits.subscriptionEnabled and short-circuits the service. The toggle approach is preferred long-term — it follows the same pattern as /usage weekly. Deferred from final review of session-usage branch.

## Design

Mirror /usage weekly: add a 'subscription' subcommand handler in extensions/the-last-harness/usage-limits.ts that writes tlh.usageLimits.subscriptionEnabled. The service consults this on each refresh() / isEligible() and returns false / undefined when disabled. Default ON to preserve current behavior.

## Acceptance Criteria

1) Either README phrasing is tightened with a clear today-current workaround, OR a new /usage subscription off|on|toggle command is implemented with the same safety properties as /usage weekly (locked write, timestamped backup, idempotency). 2) Tests cover the new toggle (if implemented). 3) README and CHANGELOG updated.
