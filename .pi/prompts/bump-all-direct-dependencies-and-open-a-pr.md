Refresh all direct npm dependencies and bundled default extensions to the latest compatible stable versions. Keep every package pin exact, retain any intentionally held-back pins with a short rationale (for example, peer-range or host-compatibility limits), update the lockfile reproducibly, run the relevant validation/tests, summarize the final versions plus any retained pins, and open a draft PR with the results.

Also audit the three pinned terminal-skill closures whenever dependencies or bundled resources are bumped. For each source below, compare the checked-in files byte-for-byte with the exact upstream commit, then update the closure and its documented provenance together when the source changes:

- Herdr: `herdrdev/herdr`, commit `346411fa21afd297f5ed3b3fa56f9e3fbf7654b7`, `skills/herdr/SKILL.md`.
- cmux CLI: `manaflow-ai/cmux-skills`, commit `c669666f8607529a39a1f74ac0e8462e922dd13f`, `skills/cmux-cli/SKILL.md` and `skills/cmux-cli/references/commands.md`.
- OpenClaw tmux: `openclaw/openclaw`, commit `793669c8f6ddfad07b40009068f532832685b7d6`, `skills/tmux/SKILL.md`, `skills/tmux/scripts/find-sessions.sh`, and `skills/tmux/scripts/wait-for-text.sh`.

When any skill pin changes, update the matching source link and commit in this prompt itself and in the README third-party attribution section, refresh `licenses/terminal-skills.txt`, and preserve the closure boundary: do not vendor upstream README files, `AGENTS.md`, agent metadata, or the cmux source-checkout-only `scripts/cmux-debug-cli.sh` helper. Recheck every skill-relative reference, shell syntax, shellcheck, package contents, and applicable formatting before opening the draft PR.
