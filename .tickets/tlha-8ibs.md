---
id: tlha-8ibs
status: open
deps: []
links: []
created: 2026-05-20T12:39:07Z
type: task
priority: 3
assignee: Diego Petrucci
---
# Scope subscription-usage token-hash key by provider

accessTokenFingerprint() returns sha256(token) with no provider prefix. Collision space is effectively zero, but scoping the throttle key to include the provider (e.g. provider + tab + token-hash) would make the throttle isolation explicit and remove the need to reason about cross-provider bearer collisions. Defensive cleanup, not a regression. Deferred from final review of session-usage branch.

## Acceptance Criteria

1) lastAccessTokenAttempts key is provider-scoped. 2) Existing rotation and throttle tests still pass without modification, or are updated to match the new key shape. 3) No leak of the bearer or its hash in error messages or logs.
