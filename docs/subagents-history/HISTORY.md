# First-party subagent provenance

This directory records the exact import checkpoint and integration lineage for TLH's first-party subagent runtime. The checkpoint intentionally precedes every Pi 0.83 compatibility change and every TLH build, lint, test, installer, migration, licensing, Gnosis, or user-documentation adaptation.

## Source identity

- Owned snapshot-history repository: <https://github.com/diegopetrucci/pi-subagents.git>
- Original repository: <https://github.com/nicobailon/pi-subagents.git>
- Source commit: `0eb7e255e5f9a3bfc694762ad09ebbcee38e11ff`
- Source tree: `7d728e04290a89e6febe435c9ab0212ea6c81500`
- Source commit date: `2026-08-04T16:39:14+01:00`
- Source commit subject: `Add macOS test CI`
- TLH import checkpoint commit: `4b7e052ff0ea6ccf63407085dd53a9dc6ba237de`

The owned snapshot-history repository is the reference for the complete pre-import history. TLH imported file blobs only: no source commit ancestry, Git bundle, refs, or tags were grafted into this repository. The anchored TLH commit above is the dedicated, single-parent snapshot checkpoint; all compatibility and product work belongs in later commits. This record does not assert that either source repository was deleted, archived, deprecated, or otherwise changed after absorption.

## Imported layout

| Source | TLH destination | Files | Disposition |
| --- | --- | ---: | --- |
| `src/**` | `extensions/subagents/src/**` | 101 | Functional snapshot |
| `agents/**` | `extensions/subagents/agents/**` | 8 | Functional snapshot |
| `test/**` | `extensions/subagents/test/**` | 124 | Functional snapshot |
| Approved standalone metadata and policy files | `docs/subagents-history/source/<source-path>` | 17 | Inert historical archive |

The archived paths preserve their source-relative names and bytes. In particular:

- `source/.gnosis/entries.jsonl` is the exact 29-entry historical ledger. It is not active TLH Gnosis and must not be merged into the repository-root `.gnosis/entries.jsonl`.
- `source/.upstream-ledger.jsonl` is the exact six-entry upstream-adoption ledger and is not active TLH policy.
- The archived package, lockfile, TypeScript, npm, installer, workflow, sync-policy, and release metadata are historical context only. Nothing under `source/` is active TLH configuration or current install, publish, release, pin-bump, or upstream-sync guidance.

Two handling caveats apply:

- npm's package builder omits `.npmrc` files, including archived `source/.npmrc`, from published tarballs. Exact verification of all 17 historical archive files therefore requires a source checkout; a package install is intentionally insufficient even though the manifest and remaining packaged history are available there.
- Archived `source/AGENTS.md` and `source/CLAUDE.md` retain instruction filenames for byte fidelity. Pi can load such files as project context when a session's working directory is inside the archive. Never launch TLH/Pi or dispatch a task with `cwd` beneath `docs/subagents-history/source/`; inspect the archive from the repository root with read-only file or Git commands instead.

`import-manifest.json` enumerates all 263 tracked source paths. Each of the 250 included files records its exact destination, source/destination Git mode, source blob OID, and SHA-256. Each of the 13 excluded paths records the source mode, blob OID, SHA-256, category, and reason. The exclusions are limited to root VCS/editor metadata, the unrelated `.pi` visual-explainer skill, and standalone banner artwork.

## First-party integration lineage

The import checkpoint remains the byte-parity reference. These later TLH commits establish the current first-party state:

| Commit | Purpose |
| --- | --- |
| `464f728808bd284761170a856929601b5800d5dd` | Anchor snapshot verification and the immutable manifest |
| `b32f3e547defa1e98e9d5a1697bf3d1155c37101` | Integrate the runtime as a root TLH extension |
| `070b503c115db2f999bc204bcf1a91b33008931d` | Adapt the imported runtime to the pinned Pi API |
| `bcb5e22028c68b8a764a5992d3a5fb0d4945edf1` | Retire the external default and add legacy-profile migration |
| `e86e22b7acfa881b2eac0c04ef6b1186161ee4a1` | Add migration/coexistence safety guards |
| `cc028bd50177dcdd945f192af683990a3e0b0062` | Preserve ownership evidence for cleanup retries |
| `44d304e5910f38c7bea762e7f4b3f233becb3e53` | Avoid redundant retired npm uninstalls |
| `375c08b6d9ae1e6fa364d594048182e382a6bf53` | Port imported unit/integration/E2E suites into TLH CI |

Use `git show <commit>` in this repository to inspect each adaptation. The current files under `extensions/subagents/` are allowed to differ from the checkpoint because they contain those reviewed adaptations; files under `docs/subagents-history/source/` are not.

## License and attribution

The imported checkpoint's root `package.json` and `package-lock.json` declared the implementation as MIT-licensed, but that checkpoint contained no root `LICENSE` file. The exact author notice was established in the original repository's separate history at commit `6e8266fb65c68d6e3d3392104450a8c9716d45f2` (`chore: add MIT LICENSE file`, authored by Nico Bailon). That commit is not claimed as part of the imported checkpoint's ancestry and its file is not inserted into the immutable archive.

TLH instead ships a byte-identical copy at `extensions/subagents/LICENSE`:

```text
Copyright (c) 2026 Nico Bailon
```

The notice's SHA-256 is `2d20dfacd9742706e564470dc77438608a1e54b0ed46959f080709389209093c`. It is additive to, and does not replace or modify, TLH's root `LICENSE` and Diego Petrucci copyright notice.

To inspect the independent licensing evidence from a checkout that contains the original-source commit:

```sh
export ORIGINAL_SOURCE_REPO=/absolute/path/to/a-nicobailon-pi-subagents-checkout
export LICENSE_COMMIT=6e8266fb65c68d6e3d3392104450a8c9716d45f2

test "$(git -C "$ORIGINAL_SOURCE_REPO" rev-parse "$LICENSE_COMMIT^{commit}")" = "$LICENSE_COMMIT"
git -C "$ORIGINAL_SOURCE_REPO" show -s --format=fuller "$LICENSE_COMMIT"
git -C "$ORIGINAL_SOURCE_REPO" show "$LICENSE_COMMIT:LICENSE" | shasum -a 256
cmp extensions/subagents/LICENSE <(git -C "$ORIGINAL_SOURCE_REPO" show "$LICENSE_COMMIT:LICENSE")
```

The `cmp` command uses Bash process substitution. The package-content gate independently checks that the notice ships in the root TLH tarball.

## Source-history inspection

A verified source checkout can be inspected without importing or rewriting its history:

```sh
export SOURCE_REPO=/absolute/path/to/a-verified-pi-subagents-checkout
export SOURCE_COMMIT=0eb7e255e5f9a3bfc694762ad09ebbcee38e11ff

# Confirm repository/remotes and the exact checkpoint.
git -C "$SOURCE_REPO" remote -v
test "$(git -C "$SOURCE_REPO" rev-parse "$SOURCE_COMMIT^{commit}")" = "$SOURCE_COMMIT"
test "$(git -C "$SOURCE_REPO" rev-parse "$SOURCE_COMMIT^{tree}")" = 7d728e04290a89e6febe435c9ab0212ea6c81500
git -C "$SOURCE_REPO" show -s --format=fuller "$SOURCE_COMMIT"

# Inspect history reachable from the checkpoint without changing either repo.
git -C "$SOURCE_REPO" log --graph --decorate --oneline "$SOURCE_COMMIT"
git -C "$SOURCE_REPO" log --format='%H %aI %an <%ae> %s' --reverse "$SOURCE_COMMIT"
```

These are read-only provenance commands, not a standalone fork-sync or release workflow.

## Snapshot verification

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

The verifier checks the source commit/tree, the complete include/exclude partition, source blob OIDs, SHA-256 values, mapped destination bytes and modes stored in the anchored TLH import commit, ledger entry counts, and that no commit in the source checkpoint's ancestry is reachable from TLH refs. It also requires the import commit to be an ancestor of current `HEAD`. Later functional adaptations may change `extensions/subagents/{src,agents,test}/`; parity is always evaluated at the immutable import commit, while the current historical archive under `source/` must remain unchanged. Run this exact 17-file archive check from a source checkout, not an npm-installed package, because npm omits the archived `.npmrc`.

The deterministic checksum for the complete 263-file source tree—including excluded paths—is the SHA-256 of the unprefixed tar stream produced by `git archive`:

```sh
git -C "$SOURCE_REPO" archive --format=tar "$SOURCE_COMMIT" | shasum -a 256
```

Expected output:

```text
c832ad8cdb00db1d6f406c19fea4177e3d26604aa93bb8517cc494282ec24355  -
```

If the historical snapshot ever needs to be removed, revert its dedicated TLH import commit in a reviewed change rather than editing archived blobs in place.
