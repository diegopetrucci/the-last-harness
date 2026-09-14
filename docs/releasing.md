# Releasing The Last Harness

Releases are GitHub tag based. Pushing a semver tag such as `v0.1.0` runs `.github/workflows/release.yml`, which:

1. verifies the tag commit is reachable from `origin/main`;
2. verifies the tag matches `package.json`;
3. runs the release checks;
4. builds an npm-style package tarball;
5. generates a pinned stage-0 `install.sh` asset with the tag and SHA-256 inventory for every stage-0 support fetch baked in, plus the `latest-release` update track for future updates;
6. creates a GitHub Release whose body is the matching `CHANGELOG.md` section, plus release assets.

There is no `stable` branch. A release is the immutable Git tag plus its GitHub Release assets. The stage-0 release asset verifies the bytes it fetches for stage 1 before executing them; explicitly repeating that asset's baked tag is still verified, while raw source/custom-ref/custom-base installers intentionally do not reuse another tag's hashes. The stage-1 installer (`scripts/tlh-install.mjs`) and `scripts/lib/` helpers must be present in both the tag and package tarball.

The release build fails closed if the stage-0 inventory is incomplete, duplicated, unsafe, out of sync with stage 1, or points at anything other than regular checkout files. `scripts/generate-release-installer.mjs` is the single generator used by CI; do not hand-edit `dist/install.sh` or copy the old manual fallback. If a required release support file reports an integrity failure, no stage-1 code is run and the temporary support root is cleaned up; optional or bundled subagent mismatches are removed, warned about, and stage 1 continues with those resources unavailable. Recover by rerunning the official latest-release installer or a known-good pinned tag; use the isolated settings backup to roll back an install if stage 1 had already completed.

## Installer compatibility boundary

Only the generated GitHub Release `install.sh` asset is pinned and integrity-verifiable for its tag: the release workflow bakes the matching tag and support-file SHA-256 inventory into that stage-0 asset, so later changes on `main` cannot silently change the verified bytes for that release. A matching generated asset is the canonical stage-0 handoff and verifies support files directly instead of self-refreshing; explicit matching `--ref`/`TLH_REF` values remain eligible for that direct path. Every raw source `install.sh`, including current and tag copies, defaults `REF` to `main` unless the caller passes the matching `--ref`; raw, mutable, custom, and local paths are not release-verified. The v0.27 boundary otherwise means remote/stale stage-0 installers self-refresh from the requested ref before any manifest-driven support-file downloads. This policy does not promise support for arbitrary old TLH runtimes.

Through **2026-09-29**, compatibility is retained only for locally saved **pre-v0.27 raw source installers from published/tagged releases whose baked manifests requested the retained query/librarian assets**. It excludes arbitrary snapshots of `main` or unreleased intermediate states, including the never-released profile-writer manifest window; this compatibility window does not extend support for every older TLH runtime. After **2026-09-29**, the supported recovery is to download and run the current installer rather than continuing to use the saved file:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s --
```

For pin-PR title and body conventions (PRs updating `config/default-extensions.json` fork tags), see [CONTRIBUTING.md — Pull requests and CI](../CONTRIBUTING.md#pull-requests-and-ci).

## Prepare a release

From a clean `main` branch with Node.js >=22.19.0:

```sh
version=0.1.0
# Skip this if package.json already has the release version.
npm version "$version" --no-git-tag-version
git diff -- package.json
```

Update `CHANGELOG.md` with a `## [$version] - YYYY-MM-DD` section.

Before validation, update release-sensitive docs that include concrete versioned install guidance or runtime pins:

- `docs/install.md`: pinned-tag install examples and the non-stable footer-label examples should use `v$version`.
- `README.md` and `docs/install.md`: any pinned Pi runtime version, minimum Node.js version, managed Gnosis version, managed `tk` version, or bundled default-extension behavior should match the release metadata and installer constants.
- `docs/releasing.md`: keep this checklist aligned when release validation adds or removes required documentation checks.

For architect-managed work, keep implementation-ticket checks narrow and ticket-scoped, then put the exact validation steps in a separate final-validation `tk` ticket and dispatch it to `test-runner`. The ticket must contain ordered shell commands (with arguments) and/or exact adapter-shaped generic MCP inputs containing only the fields required by the selected status, discovery, search, connect, or call operation; `server`, `tool`, and `args` are optional overall, and `args` is a JSON string for tool calls. Derive the steps from `VALIDATING.md` or repository discovery; assigned MCP calls may invoke tools that change server-side state. `test-runner` executes that list and reports the outcomes without planning, editing, installing dependencies, or fixing failures. Keep dependency installation and release-preparation commands outside the execution-only runner.

Then run the aggregate validation script and release-notes check:

```sh
npm install --no-package-lock
npm run validate
node scripts/release-notes.mjs --tag "v$version" --output /tmp/tlh-release-notes.md
```

Then run the startup performance checker as release-tier manual validation:

```sh
npm run check:startup-performance
```

Keep this separate from `npm run validate`: it measures TLH PTY startup timing, so results vary with the machine and current load. The release objective is a steady-state first TLH header mean below `1000ms`.

If the checker fails, investigate before release rather than treating it like a normal deterministic test failure.

Commit the release prep:

```sh
git add -A
git diff --cached --stat
git diff --cached
git commit -m "Release v$version"
```

## Tag and publish

Push `main` before pushing the tag: the release gate requires the tag commit to be reachable from `origin/main`.

```sh
git tag -a "v$version" -m "v$version"
git push origin main
git push origin "v$version"
```

After the workflow finishes, confirm the GitHub Release exists and includes:

- `install.sh` — generated stage-0 installer pinned to `v$version` and defaulting future updates to `latest-release`
- `uninstall.sh` — uninstaller script (published as-is from the repository root)
- `the-last-harness-$version.tgz` — package tarball from `npm pack`, including `scripts/tlh-install.mjs` and `scripts/lib/`

## Install checks

These are release-tier manual checks for published assets. They are separate from `npm run validate`, require a pushed tag or GitHub Release asset, and should normally stay in `--dry-run` mode so they leave no installed TLH state behind.

Latest release asset:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | bash -s -- --dry-run
```

Pinned release asset (default `latest-release` update track):

```sh
curl -fsSL "https://github.com/diegopetrucci/the-last-harness/releases/download/v$version/install.sh" | bash -s -- --dry-run
```

Raw tag fallback:

```sh
curl -fsSL "https://raw.githubusercontent.com/diegopetrucci/the-last-harness/v$version/install.sh" | bash -s -- --dry-run --ref "v$version" --track pinned-tag
```

## Manual fallback

If GitHub Actions is unavailable, create the release manually with GitHub CLI:

```sh
mkdir -p dist
node scripts/generate-release-installer.mjs --tag "v$version" --output dist/install.sh
chmod +x dist/install.sh
bash -n dist/install.sh
node scripts/release-notes.mjs --tag "v$version" --output release-notes.md
npm pack --json > pack-output.json
tarball="$(node -e "const fs = require('node:fs'); const [pkg] = JSON.parse(fs.readFileSync('pack-output.json', 'utf8')); console.log(pkg.filename);")"
gh release create "v$version" "$tarball" "dist/install.sh#install.sh" "uninstall.sh#uninstall.sh" --verify-tag --title "v$version" --notes-file release-notes.md
```
