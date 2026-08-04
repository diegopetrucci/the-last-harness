# pi-subagents snapshot history

This directory records the exact first-party import checkpoint for the former standalone TLH subagents fork. The checkpoint intentionally precedes every Pi 0.83 compatibility change and every TLH build, lint, test, installer, or user-documentation adaptation.

## Source identity

- Owned history repository: <https://github.com/diegopetrucci/pi-subagents.git>
- Source commit: `0eb7e255e5f9a3bfc694762ad09ebbcee38e11ff`
- Source tree: `7d728e04290a89e6febe435c9ab0212ea6c81500`
- TLH import checkpoint commit: `4b7e052ff0ea6ccf63407085dd53a9dc6ba237de`
- Commit date: `2026-08-04T16:39:14+01:00`
- Commit subject: `Add macOS test CI`

The owned source repository remains the reference for the complete pre-import history. TLH imported file blobs only: no source commit ancestry, Git bundle, refs, or tags were grafted into this repository. The anchored TLH commit above is the dedicated, single-parent snapshot checkpoint; compatibility work belongs in later commits.

## Imported layout

| Source | TLH destination | Files | Disposition |
| --- | --- | ---: | --- |
| `src/**` | `extensions/subagents/src/**` | 101 | Functional snapshot |
| `agents/**` | `extensions/subagents/agents/**` | 8 | Functional snapshot |
| `test/**` | `extensions/subagents/test/**` | 124 | Functional snapshot |
| Approved standalone metadata and policy files | `docs/subagents-history/source/<source-path>` | 17 | Inert historical archive |

The archived paths preserve their source-relative names and bytes. In particular:

- `source/.gnosis/entries.jsonl` is the exact 29-entry historical ledger. It is not active TLH Gnosis and must not be merged into the repository-root `.gnosis/entries.jsonl`.
- `source/.upstream-ledger.jsonl` is the exact six-entry upstream adoption ledger and is not active TLH policy.
- The archived package, lockfile, TypeScript, npm, installer, workflow, sync-policy, and release metadata are historical context only. Nothing under `source/` is active TLH configuration.

`import-manifest.json` enumerates all 263 tracked source paths. Each of the 250 included files records its exact destination, source/destination Git mode, source blob OID, and SHA-256. Each of the 13 excluded paths records the source mode, blob OID, SHA-256, category, and reason. The exclusions are limited to root VCS/editor metadata, the unrelated `.pi` visual-explainer skill, and standalone banner artwork.

## Verification

From the TLH repository root, point `SOURCE_REPO` at a checkout that contains the source commit, then run the committed verifier:

```sh
export SOURCE_REPO=/absolute/path/to/a-verified-pi-subagents-checkout
export SOURCE_COMMIT=0eb7e255e5f9a3bfc694762ad09ebbcee38e11ff
export TLH_IMPORT_COMMIT=4b7e052ff0ea6ccf63407085dd53a9dc6ba237de

test "$(git -C "$SOURCE_REPO" rev-parse "$SOURCE_COMMIT^{commit}")" = "$SOURCE_COMMIT"
test "$(git rev-parse "$TLH_IMPORT_COMMIT^{commit}")" = "$TLH_IMPORT_COMMIT"
git merge-base --is-ancestor "$TLH_IMPORT_COMMIT" HEAD
node docs/subagents-history/verify-import.mjs "$SOURCE_REPO"
```

The verifier checks the source commit/tree, the complete include/exclude partition, source blob OIDs, SHA-256 values, mapped destination bytes and modes stored in the anchored TLH import commit, ledger entry counts, and that no commit in the source checkpoint's ancestry is reachable from TLH refs. It also requires the import commit to be an ancestor of current `HEAD`. Later functional adaptations may change `extensions/subagents/{src,agents,test}/`; parity is always evaluated at the immutable import commit, while the current historical archive under `source/` must remain unchanged.

The deterministic checksum for the complete 263-file source tree—including excluded paths—is the SHA-256 of the unprefixed tar stream produced by `git archive`:

```sh
git -C "$SOURCE_REPO" archive --format=tar "$SOURCE_COMMIT" | shasum -a 256
```

Expected output:

```text
c832ad8cdb00db1d6f406c19fea4177e3d26604aa93bb8517cc494282ec24355  -
```

If this historical snapshot ever needs to be removed, revert its dedicated TLH import commit rather than editing the archived blobs in place.
