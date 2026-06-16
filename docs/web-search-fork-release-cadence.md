# Web-search fork release cadence

This document covers the pinned fork/tag workflow for `pi-web-access`. Durable web-search / web-scout policy decisions live in repo-local Gnosis entries `ywsuwh` and `gbmehw`.

## Where the fork lives

Fork: <https://github.com/diegopetrucci/pi-web-access>
Upstream: `nicobailon/pi-web-access`

## Tag naming

TLH release tags follow the form `tlh-vX.Y.Z-N`:

- `X.Y.Z` mirrors the upstream version from `nicobailon/pi-web-access`.
- `N` is the TLH revision for changes made on top of the same upstream version (1, 2, 3, …).

Example: `tlh-v0.10.7-1` is the first TLH revision on top of upstream `v0.10.7`.

## Current TLH pin

Every TLH fork tag records the upstream commit SHA in `NOTICE` for auditability.

- TLH fork tag: `tlh-v0.10.7-1`
- Upstream version: `v0.10.7`
- Upstream commit SHA: `076bf0db5e739b200286ca37486e4edd8d19123c`
- Tag audit: annotated, currently unsigned; tag SHA `863cb9fa1746eb2cb35543e20440508fd57fc85b`; tagged `2026-05-22`
- Branch HEAD at tag: `cf224b77ed45bb4826f30898dfb8f559fb69622f`

## Bump process

Follow these steps the next time a tag is rolled:

1. Fetch upstream tags in your fork checkout:
   ```sh
   git fetch upstream --tags
   ```

2. Decide the target upstream version. Identify its commit SHA:
   ```sh
   git rev-parse vX.Y.Z^{}
   ```

3. Rebase or merge the TLH trim/safety patches onto the new upstream commit on a fresh branch
   named `tlh-vX.Y.Z-1`.

4. Re-run the full fork test suite:
   ```sh
   npm test
   ```
   Fix any regressions surfaced by upstream changes — typically request-guard call-site shifts or
   new code paths needing guard plumbing.

5. Update:
   - `NOTICE` — new upstream commit SHA.
   - `CHANGELOG.md` — new entry.
   - `README.md`'s "What leaves the machine" section if MCP behavior changed.

6. Tag annotated (or signed if a key is available):
   ```sh
   git tag -a tlh-vX.Y.Z-1 -m "TLH fork of pi-web-access vX.Y.Z, revision 1"
   # or: git tag -s tlh-vX.Y.Z-1 -m "TLH fork of pi-web-access vX.Y.Z, revision 1"
   ```

7. Push branch and tag explicitly (branch and tag share the same name, so fully qualify
   both refspecs):
   ```sh
   git push origin refs/heads/tlh-vX.Y.Z-1:refs/heads/tlh-vX.Y.Z-1 refs/tags/tlh-vX.Y.Z-1:refs/tags/tlh-vX.Y.Z-1
   ```

8. In the TLH repo:
   - Update this document's current pin section with the new tag and upstream commit SHA.
   - Bump `config/default-extensions.json` entry for `pi-web-access` (`source`) to the new tag.
   - Update `tests/default-extensions.test.mjs` to pin the new tag string.

9. Run `npm run validate` in the TLH repo and fix any fallout. That TLH-repo validation flow uses
   the quiet `npm test` dot reporter for passing runs; if you need the full Node test reporter while
   diagnosing TLH-side failures, rerun `npm run test:verbose` in the TLH repo.

## Notes

- The branch and tag intentionally share the same name (`tlh-vX.Y.Z-1`). When pushing both,
  fully qualify each ref (`refs/heads/...` and `refs/tags/...`) so Git does not need to infer which
  same-name ref you meant.
- Running the upstream `pi-web-access` extension alongside the TLH fork at the same time is
  unsupported. Tool names are unchanged (`web_search`, `fetch_content`, `get_search_content`) and
  conflicts will occur if both are active.
