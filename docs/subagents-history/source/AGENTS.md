# AGENTS.md

## Repository Role

- This repository is Diego's fork of `nicobailon/pi-subagents`.
- It exists to serve The Last Harness (`tlh`) and is bundled/pinned by TLH automation; treat TLH compatibility as a first-class requirement.
- Preserve end-user usage docs, but do not position this fork as a general standalone distribution target outside TLH unless the user explicitly asks for that change.
- The fork is TLH-first and deliberately diverges from upstream; staying close to upstream is not a goal. Do not overwrite fork-only behavior just because upstream differs.
- `origin` is the fork (`diegopetrucci/pi-subagents`); `upstream` is the original repository (`nicobailon/pi-subagents`).

## Fork Sync Policy

- Upstream (`nicobailon/pi-subagents`) is monitored only as a source of **bug fixes** and **feature ideas** worth reimplementing in fork style. No scheduled release/tag intakes; adoption is selective and per-change.
- When a fix or idea is worth porting, cherry-pick or reimplement it in the fork's style. Every such adoption gets one entry/line in `.upstream-ledger.jsonl` recording what was taken, the upstream ref, and why it was adopted.
- `docs/UPSTREAM-SYNC.md` is a historical document describing the retired intake model; it is kept for reference but no longer governs this fork.
- `docs/tlh-patch-inventory.md` remains the record of deliberate TLH deltas. Update it when adding or removing fork-only behavior.
- `git cherry` / `git patch-id` and `scripts/upstream-report.*` are useful signal for spotting relevant upstream commits, but `.upstream-ledger.jsonl` is the authoritative record of what has actually been adopted.
- Preserve TLH-specific tags and release pins such as `tlh-v*` unless the user explicitly asks to remove or rewrite them.
- When comparing GitHub state, use the `gh` CLI.
- If an upstream fix touches child process spawning, async run state, configured profile roots, packaged agents, or model fallback behavior, review the TLH fork behavior carefully before porting.

## Important Local Delta

- Child subagents must spawn with the resolved parent/private Pi runtime when available, not blindly through ambient `PATH`.
- The key implementation is `src/runs/shared/pi-spawn.ts`.
- The focused coverage is `test/unit/pi-spawn.test.ts`.
- This matters because TLH can run Pi from its private runtime under `~/.the-last-harness/runtime/bin/pi`; child subagents must not accidentally fall through to a global Homebrew/runtime Pi.

## Development

- Use `python3`, not `python`.
- This is a Node ESM package with TypeScript source loaded directly by Node test commands.
- Run focused unit coverage with:

```bash
npm run test:unit
```

- Run the full local suite with:

```bash
npm run test:all
```

- For narrow changes, run the closest affected test file first, then broaden to `npm run test:unit` or `npm run test:all` depending on risk.
- Keep generated/profile/runtime state out of commits. Be especially careful around async-run status files and any local Pi/TLH runtime directories.

## Working Rules

- Do not revert or rewrite user changes unless explicitly asked.
- Keep changes scoped to the behavior requested; avoid unrelated upstream cleanup while preserving fork syncability.
- Commit and push relevant `.gnosis/entries.jsonl` updates with the related code/docs change, but keep ticket, session, and other generated state out of commits.
- When a change affects TLH behavior, say exactly which checkout and branch holds the edit, and mention any TLH follow-up needed for pins or validation.
- If adding or updating fork-only behavior, add focused tests that document why the fork needs it.
