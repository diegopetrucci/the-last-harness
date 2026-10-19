# Web-search fork release cadence

This document covers the source-audit, fork-tag, and scoped npm release workflow for `pi-web-access`. Durable web-search / web-scout policy decisions live in repo-local Gnosis entries `ywsuwh` and `gbmehw`.

## Where the source lives

Fork: <https://github.com/diegopetrucci/pi-web-access>
Upstream: `nicobailon/pi-web-access`

## Current TLH pin and capability boundary

TLH no longer installs `pi-web-access` from a git dependency. The current bundled default is the scoped npm package:

- TLH bundled extension source: `npm:@diegopetrucci/pi-web-access@0.29.2`
- Current scoped release tag: `tlh-v0.29.2` (the live npm release, not a git dependency)
- Source repository: <https://github.com/diegopetrucci/pi-web-access>
- Previous git-based TLH source retained for migration coverage: `git:github.com/diegopetrucci/pi-web-access@tlh-v0.10.7-1`

`0.29.2` is a selective TLH fork, not upstream feature parity. It registers exactly `web_search`, `fetch_content`, and `get_search_content`, and requires an absolute `PI_CODING_AGENT_DIR`. It intentionally excludes alternate providers and fallbacks, curator/search commands, the bundled research skill, GitHub cloning, PDF/video/browser-cookie workflows, hosted extraction, and local Exa usage accounting. Its settings and fetched-content cache stay under the isolated profile:

- `$PI_CODING_AGENT_DIR/extensions/pi-web-access/settings.json`
- `$PI_CODING_AGENT_DIR/cache/pi-web-access/`

The current package does not read a legacy `<agent>/web-search.json`; TLH must not add automatic migration or key persistence. User-facing migration guidance belongs in [`docs/web-search.md`](web-search.md).

## Source tag naming

When TLH needs a durable source checkpoint in the fork, use tags of the form `tlh-vX.Y.Z-N`:

- `X.Y.Z` mirrors the upstream version from `nicobailon/pi-web-access`.
- `N` is the TLH revision for changes made on top of the same upstream version (1, 2, 3, …).

Example: `tlh-v0.10.7-1` is the first TLH revision on top of upstream `v0.10.7`.

These tags are provenance markers for reviewed fork source states. Once the scoped npm package is published, TLH should treat the npm package version as the live bundled pin and the `tlh-v...` tag as historical source provenance only. The current scoped release tag `tlh-v0.29.2` identifies the live npm release and is distinct from the historical git dependency tag.

## Bump process

Follow these steps the next time the scoped package pin is rolled:

1. Fetch upstream tags in your fork checkout:
   ```sh
   git fetch upstream --tags
   ```

2. Decide the target upstream version and record the exact source commit:
   ```sh
   git rev-parse vX.Y.Z^{}
   ```

3. Rebase or merge the TLH trim/safety patches onto the new upstream commit on a fresh review branch. Preserve the selective three-tool surface and its SSRF/profile boundary; do not restore removed provider, curator, repository, media, browser, or bundled-skill workflows without a new product decision.

4. Re-run the full fork test suite:
   ```sh
   npm test
   ```
   Fix regressions surfaced by upstream changes, especially request-guard, settings, cache, and tool-registration call sites.

5. Update source-side release metadata as needed:
   - `NOTICE` — new upstream commit SHA.
   - `CHANGELOG.md` — new entry.
   - `README.md` — current tools, supported settings, isolation requirements, and the "What leaves the machine" behavior.

6. If you want a durable source checkpoint before publishing, cut an annotated (or signed) TLH tag:
   ```sh
   git tag -a tlh-vX.Y.Z-1 -m "TLH fork of pi-web-access vX.Y.Z, revision 1"
   # or: git tag -s tlh-vX.Y.Z-1 -m "TLH fork of pi-web-access vX.Y.Z, revision 1"
   ```

7. Publish the reviewed scoped package version from that source state. TLH's bundled install source should point at the resulting npm package version (for example `npm:@diegopetrucci/pi-web-access@X.Y.Z`), not at the git tag.

8. If you created a review branch and same-name tag, push both explicitly (fully qualified) so Git does not have to infer which ref you meant:
   ```sh
   git push origin refs/heads/tlh-vX.Y.Z-1:refs/heads/tlh-vX.Y.Z-1 refs/tags/tlh-vX.Y.Z-1:refs/tags/tlh-vX.Y.Z-1
   ```

9. In the TLH repo:
   - Update this document's current pin section with the new scoped npm package version.
   - Bump only the `pi-web-access` `source` in `config/default-extensions.json`.
   - Keep the migration `replaces` list current when a prior TLH-managed source should be migrated forward.
   - Keep the current manifest behavior covered by `tests/default-extensions-cli-settings.test.mjs`; preserve historical migration fixtures for prior upstream and TLH sources.
   - Update `docs/web-search.md` and `docs/commands.md` when the user-facing surface changes.

10. Run the ticket-local pin, manifest, smoke, and diff checks in the TLH repo, then run `npm run validate` before considering the pin bump ready.

## Rollback

To roll back this package independently, restore the prior TLH release/commit or restore the prior `pi-web-access` manifest pin (`npm:@diegopetrucci/pi-web-access@0.10.10`) in a controlled release checkout, then rerun the isolated TLH install/update. Keep the original `$PI_CODING_AGENT_DIR/web-search.json` untouched and do not overwrite an existing `$PI_CODING_AGENT_DIR/extensions/pi-web-access/settings.json`; package-pin rollback is not permission for automatic configuration migration. Preserve any settings needed by the selected package, and remove only reviewed package-owned cache/settings paths.

The same rule applies to a broader bundled-extension rollback: restore the previous TLH release rather than editing a user's normal `~/.pi/agent` profile. A rollback must preserve unrelated isolated settings and the normal-profile safety boundary.

## Notes

- The branch and tag may intentionally share the same name (`tlh-vX.Y.Z-1`). When pushing both, fully qualify each ref (`refs/heads/...` and `refs/tags/...`) so Git does not need to infer which same-name ref you meant.
- Running the upstream `pi-web-access` extension alongside the TLH-managed package is unsupported because their tool names conflict. Keep only one provider active in an isolated profile.
