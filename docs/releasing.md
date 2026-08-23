# Releasing The Last Harness

Releases are GitHub tag based. Pushing a semver tag such as `v0.1.0` runs `.github/workflows/release.yml`, which:

1. verifies the tag matches `package.json`;
2. runs the release checks;
3. builds an npm-style package tarball;
4. generates a pinned stage-0 `install.sh` asset with the tag baked in for support-file fetches and the `latest-release` update track baked in for future updates;
5. creates a GitHub Release whose body is the matching `CHANGELOG.md` section, plus release assets.

There is no `stable` branch. A release is the immutable Git tag plus its GitHub Release assets. The stage-1 installer (`scripts/tlh-install.mjs`) and `scripts/lib/` helpers must be present in both the tag and package tarball.

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
TAG="v$version" node <<'NODE'
const fs = require('node:fs');
const tag = process.env.TAG;
const source = fs.readFileSync('install.sh', 'utf8');
const replacements = [
  ['REF="${TLH_REF:-main}"', `REF="\${TLH_REF:-${tag}}"`],
  ['UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-}"', 'UPDATE_TRACK_INPUT="${TLH_UPDATE_TRACK:-latest-release}"'],
];
let output = source;
for (const [oldText, newText] of replacements) {
  if (!output.includes(oldText)) throw new Error(`Expected installer default line not found: ${oldText}`);
  output = output.replace(oldText, newText);
}
fs.writeFileSync('dist/install.sh', output, 'utf8');
NODE
chmod +x dist/install.sh
bash -n dist/install.sh
node scripts/release-notes.mjs --tag "v$version" --output release-notes.md
npm pack --json > pack-output.json
tarball="$(node -e "const fs = require('node:fs'); const [pkg] = JSON.parse(fs.readFileSync('pack-output.json', 'utf8')); console.log(pkg.filename);")"
gh release create "v$version" "$tarball" "dist/install.sh#install.sh" "uninstall.sh#uninstall.sh" --verify-tag --title "v$version" --notes-file release-notes.md
```
