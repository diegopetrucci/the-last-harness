# Web-search fork release cadence

This document covers the source-audit, fork-tag, and scoped npm release workflow for `pi-web-access`. Durable web-search / web-scout policy decisions live in repo-local Gnosis entries `ywsuwh` and `gbmehw`.

## Where the source lives

Fork: <https://github.com/diegopetrucci/pi-web-access>
Upstream: `nicobailon/pi-web-access`

## Current TLH pin

TLH no longer installs `pi-web-access` from a git dependency. The bundled default extension source is:

- TLH bundled extension source: `npm:@diegopetrucci/pi-web-access@0.10.10`
- Source repository: <https://github.com/diegopetrucci/pi-web-access>
- Previous git-based TLH source retained for migration coverage: `git:github.com/diegopetrucci/pi-web-access@tlh-v0.10.7-1`

## Source tag naming

When TLH needs a durable source checkpoint in the fork, use tags of the form `tlh-vX.Y.Z-N`:

- `X.Y.Z` mirrors the upstream version from `nicobailon/pi-web-access`.
- `N` is the TLH revision for changes made on top of the same upstream version (1, 2, 3, …).

Example: `tlh-v0.10.7-1` is the first TLH revision on top of upstream `v0.10.7`.

These tags are provenance markers for reviewed fork source states. Once the scoped npm package is published, TLH should treat the npm package version as the live bundled pin and the `tlh-v...` tag as historical source provenance only.

## Bump process

Follow these steps the next time the scoped package pin is rolled:

1. Fetch upstream tags in your fork checkout:
   ```sh
   git fetch upstream --tags
   ```

2. Decide the target upstream version. Identify its commit SHA:
   ```sh
   git rev-parse vX.Y.Z^{}
   ```

3. Rebase or merge the TLH trim/safety patches onto the new upstream commit on a fresh review branch.

4. Re-run the full fork test suite:
   ```sh
   npm test
   ```
   Fix any regressions surfaced by upstream changes — typically request-guard call-site shifts or
   new code paths needing guard plumbing.

5. Update source-side release metadata as needed:
   - `NOTICE` — new upstream commit SHA.
   - `CHANGELOG.md` — new entry.
   - `README.md`'s "What leaves the machine" section if behavior changed.

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
   - Bump `config/default-extensions.json` entry for `pi-web-access` (`source`) to the new npm pin.
   - Keep the migration `replaces` list current when a prior TLH-managed source should be migrated forward.
   - Update `tests/default-extensions.test.mjs` to pin the new package version string.
   - Update `docs/web-search.md` if user-facing setup, privacy, or opt-out wording changed.

10. Run `npm run validate` in the TLH repo and fix any fallout. That TLH-repo validation flow uses
    the quiet `npm test` dot reporter for passing runs; if you need the full Node test reporter while
    diagnosing TLH-side failures, rerun `npm run test:verbose` in the TLH repo.

## Notes

- The branch and tag may intentionally share the same name (`tlh-vX.Y.Z-1`). When pushing both,
  fully qualify each ref (`refs/heads/...` and `refs/tags/...`) so Git does not need to infer which
  same-name ref you meant.
- Running the upstream `pi-web-access` extension alongside the TLH-managed package at the same time
  is unsupported. Tool names are unchanged (`web_search`, `fetch_content`, `get_search_content`) and
  conflicts will occur if both are active.
