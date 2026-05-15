# Releasing The Last Harness

Releases are GitHub tag based. Pushing a semver tag such as `v0.1.0` runs `.github/workflows/release.yml`, which:

1. verifies the tag matches `package.json`;
2. runs the release checks;
3. builds an npm-style package tarball;
4. generates a pinned `install.sh` asset with the tag baked in;
5. creates a GitHub Release whose body is the matching `CHANGELOG.md` section, plus release assets.

There is no `stable` branch. A release is the immutable Git tag plus its GitHub Release assets.

## Prepare a release

From a clean `main` branch:

```sh
version=0.1.0
# Skip this if package.json already has the release version.
npm version "$version" --no-git-tag-version
git diff -- package.json
```

Update `CHANGELOG.md` with a `## [$version] - YYYY-MM-DD` section, then run:

```sh
npm install --no-package-lock --legacy-peer-deps
bash scripts/check-installer-smoke.sh
npm test
node scripts/release-notes.mjs --tag "v$version" --output /tmp/tlh-release-notes.md
npm pack --dry-run
```

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

- `install.sh` — generated installer pinned to `v$version`
- `the-last-harness-$version.tgz` — package tarball from `npm pack`

## Install checks

Latest release asset:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash -s -- --dry-run
```

Pinned release asset:

```sh
curl -fsSL "https://github.com/diegopetrucci/the-last-harness/releases/download/v$version/install.sh" | bash -s -- --dry-run
```

Raw tag fallback:

```sh
curl -fsSL "https://raw.githubusercontent.com/diegopetrucci/the-last-harness/v$version/install.sh" | TLH_UPDATE_TRACK=pinned-tag bash -s -- --dry-run --ref "v$version"
```

## Manual fallback

If GitHub Actions is unavailable, create the release manually with GitHub CLI:

```sh
mkdir -p dist
TAG="v$version" node <<'NODE'
const fs = require('node:fs');
const tag = process.env.TAG;
const source = fs.readFileSync('install.sh', 'utf8');
const oldText = 'REF="${TLH_REF:-main}"';
const newText = `REF="\${TLH_REF:-${tag}}"`;
if (!source.includes(oldText)) throw new Error(`Expected installer default ref line not found: ${oldText}`);
fs.writeFileSync('dist/install.sh', source.replace(oldText, newText), 'utf8');
NODE
chmod +x dist/install.sh
bash -n dist/install.sh
node scripts/release-notes.mjs --tag "v$version" --output release-notes.md
npm pack --json > pack-output.json
tarball="$(node -e "const fs = require('node:fs'); const [pkg] = JSON.parse(fs.readFileSync('pack-output.json', 'utf8')); console.log(pkg.filename);")"
gh release create "v$version" "$tarball" "dist/install.sh#install.sh" --verify-tag --title "v$version" --notes-file release-notes.md
```
