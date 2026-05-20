---
id: tlhm-zt41
status: open
deps: []
links: []
created: 2026-05-20T12:23:21Z
type: chore
priority: 2
assignee: Diego Petrucci
tags: [footer, robustness]
---
# FooterGitCache reliability: trailing-debounce, SIGKILL escalation, stdout cap (C3, C4a, C4b)

Three oracle-flagged reliability concerns on FooterGitCache. None impact normal usage; together they harden the cache against rapid branch switches, stuck subprocesses, and megarepo memory blowups. Bundle into one ticket because they all touch the refresh/runner subprocess path and share test scaffolding.

## Design

C3 — Branch-change trailing-edge dropped (footer-git-cache.ts::refresh).
In-flight-promise sharing dedupes overlap correctly but drops trailing edges: three branch-change callbacks during one in-flight refresh all return the same promise (which captured pre-change state). After it resolves, no follow-up is scheduled until the 8s interval ticks → footer lags up to 8s during rapid git switch / bisect / rebase.

Fix (trailing-debounce):
  private pendingRefresh = false;
  // in refresh(), when refreshInFlight exists: this.pendingRefresh = true; return this.refreshInFlight;
  // in the .finally: if (this.pendingRefresh && !this.disposed) { this.pendingRefresh = false; void this.refresh(); }
Add test: fast successive tick()s observe both branch states.

C4a — No SIGKILL escalation (defaultRunner::onAbort).
onAbort sends SIGTERM and resolves immediately. SIGTERM-trapping children (askpass GUIs, gh during TLS handshake, credential helpers) and any grandchildren outlive the cache → orphan accumulation per stall.

Fix: after child.kill('SIGTERM'), schedule a SIGKILL fallback:
  const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 250);
  (kill as unknown as { unref?: () => void }).unref?.();
Cancel the SIGKILL timer when the child actually exits (track in finish() / settled path). Add test with a recording runner that simulates a SIGTERM-ignoring child + verifies SIGKILL was scheduled.

C4b — Unbounded stdout (defaultRunner data handler).
stdout += chunk.toString('utf8') has no cap. git status --porcelain=v2 --branch on a megarepo with millions of untracked artifacts can produce 100+ MB before the 1.5s timeout fires — abort signal does not help until the buffer is already in heap.

Fix: track a running byte count; when it crosses ~1 MB cap, call controller.abort() and stop appending. Pick the cap conservatively (1 MB easily fits porcelain-v2 for any realistic working tree). Add test that asserts cap-exceeded path aborts cleanly without OOM.

## Acceptance Criteria

Trailing-debounce: a refresh() invocation while one is in-flight schedules exactly one follow-up refresh after settle (not N follow-ups). Test asserts: two successive branch-change ticks (the second arriving mid-flight of the first) cause exactly two underlying git invocations, second observing post-change state. SIGKILL escalation: aborting a runner that simulates a SIGTERM-ignoring child results in SIGKILL being scheduled within 250ms and the SIGKILL timer is cancelled on natural exit. Test asserts both paths. Stdout cap: a runner whose child emits >1 MB of stdout triggers controller.abort(), no further appending occurs, and runCommandSafely returns undefined without retaining unbounded memory. Existing 106+ tests still pass (count grows with the new tests). No public API change. No new dependencies.

