# Install, update, and uninstall

## Install

Run the one-liner:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash -s --
```

On supported platforms, it installs and enables [gnosis](https://github.com/skorokithakis/gnosis) for project memory by default. To opt out during a pipe-to-bash install, pass the flag after `bash -s --`:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/latest/download/install.sh | TLH_UPDATE_TRACK=latest-release bash -s -- --without-gnosis
```

Once the installation is finished, start `tlh` by running… you guessed it, `tlh`. Inside an interactive session, `/gnosis` toggles Gnosis prompt integration.

Note: if you already have `pi` installed, `tlh` does not replace it — you can keep both, as it uses its own isolated config in `~/.the-last-harness/`.

## More ways to install

- Pinned:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.6.0/install.sh | bash -s --
```
- Any remote branch, eg `main`:

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/main/install.sh | bash -s -- --ref main --track ref
```

## Manual install

```sh
TLH_REF="${TLH_REF:-v0.6.0}"
TLH_AGENT_DIR="${TLH_AGENT_DIR:-$HOME/.the-last-harness/agent}"
TLH_PACKAGE_SOURCE="git:github.com/diegopetrucci/the-last-harness@${TLH_REF}"
TLH_PACKAGE_DIR="$TLH_AGENT_DIR/git/github.com/diegopetrucci/the-last-harness"

TLH_AGENT_DIR="$TLH_AGENT_DIR" node <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function normalizeForCompare(input) {
  const absolute = path.resolve(input.replace(/^~(?=$|\/)/, os.homedir()));
  const parts = absolute.split(path.sep).filter(Boolean);
  let cursor = path.parse(absolute).root;
  let index = 0;
  for (; index < parts.length; index += 1) {
    const candidate = path.join(cursor, parts[index]);
    if (!fs.existsSync(candidate)) break;
    cursor = fs.realpathSync.native(candidate);
  }
  return path.resolve(cursor, ...parts.slice(index));
}

function withinOrEqual(root, child) {
  return child === root || child.startsWith(`${root}${path.sep}`);
}

const agentDir = normalizeForCompare(process.env.TLH_AGENT_DIR || '');
const piRoot = normalizeForCompare(path.join(os.homedir(), '.pi'));
if (withinOrEqual(piRoot, agentDir)) {
  console.error(`Refusing to place The Last Harness agent dir under normal Pi config root: ${process.env.TLH_AGENT_DIR}`);
  process.exit(1);
}
NODE

npm install -g @earendil-works/pi-coding-agent
mkdir -p "$TLH_AGENT_DIR"
PI_CODING_AGENT_DIR="$TLH_AGENT_DIR" pi install "$TLH_PACKAGE_SOURCE"

TLH_SUPPORT_DIR="$TLH_AGENT_DIR/tlh"
TLH_SUBAGENTS_DIR="$TLH_SUPPORT_DIR/agents/subagents"
for dir in "$TLH_SUPPORT_DIR" "$TLH_SUPPORT_DIR/agents" "$TLH_SUBAGENTS_DIR"; do
  if [ -L "$dir" ]; then
    echo "Refusing symlinked TLH support directory: $dir" >&2
    exit 1
  fi
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    echo "Refusing non-directory TLH support path: $dir" >&2
    exit 1
  fi
  mkdir -p "$dir" || exit 1
done
for prompt in developer code-reviewer repo-scout diff-summarizer; do
  src="$TLH_PACKAGE_DIR/agents/subagents/$prompt.md"
  dst="$TLH_SUBAGENTS_DIR/$prompt.md"
  if [ ! -f "$src" ]; then
    echo "Missing bundled TLH subagent prompt: $src" >&2
    exit 1
  fi
  if [ -L "$dst" ]; then
    echo "Refusing symlinked TLH subagent prompt: $dst" >&2
    exit 1
  fi
  if [ -e "$dst" ] && [ ! -f "$dst" ]; then
    echo "Refusing non-file TLH subagent prompt path: $dst" >&2
    exit 1
  fi
  tmp="$(mktemp "$TLH_SUBAGENTS_DIR/.$prompt.md.tmp.XXXXXX")" || exit 1
  if ! cp "$src" "$tmp" || ! chmod 0644 "$tmp" || ! mv "$tmp" "$dst"; then
    rm -f "$tmp"
    exit 1
  fi
done

node "$TLH_PACKAGE_DIR/scripts/merge-settings.mjs" \
  "$TLH_PACKAGE_DIR/config/settings.defaults.json" \
  --settings "$TLH_AGENT_DIR/settings.json" \
  --package-source "$TLH_PACKAGE_SOURCE" \
  --default-extensions "$TLH_PACKAGE_DIR/config/default-extensions.json"

node "$TLH_PACKAGE_DIR/scripts/merge-keybindings.mjs" \
  "$TLH_PACKAGE_DIR/config/keybindings.defaults.json" \
  --keybindings "$TLH_AGENT_DIR/keybindings.json"

TLH_DEFAULT_SOURCES="$(node "$TLH_PACKAGE_DIR/scripts/tlh-defaults.mjs" \
  --settings "$TLH_AGENT_DIR/settings.json" \
  --defaults "$TLH_PACKAGE_DIR/config/default-extensions.json" \
  sources)"
TLH_CRITICAL_SOURCES="$(node "$TLH_PACKAGE_DIR/scripts/tlh-defaults.mjs" \
  --settings "$TLH_AGENT_DIR/settings.json" \
  --defaults "$TLH_PACKAGE_DIR/config/default-extensions.json" \
  critical-sources)"

refresh_critical_git_source() {
  source="$1"
  spec="$(TLH_CRITICAL_SOURCE="$source" TLH_AGENT_DIR="$TLH_AGENT_DIR" node <<'NODE'
const path = require('node:path');

function splitRef(url) {
  const hashSeparator = url.lastIndexOf('#');
  if (hashSeparator >= 0) {
    const repo = url.slice(0, hashSeparator);
    const ref = url.slice(hashSeparator + 1);
    if (repo && ref) return { repo, ref };
  }
  const slashIndex = url.indexOf('/');
  if (slashIndex < 0) return { repo: url };
  const host = url.slice(0, slashIndex);
  const pathWithMaybeRef = url.slice(slashIndex + 1);
  const refSeparator = pathWithMaybeRef.indexOf('@');
  if (refSeparator < 0) return { repo: url };
  const repoPath = pathWithMaybeRef.slice(0, refSeparator);
  const ref = pathWithMaybeRef.slice(refSeparator + 1);
  if (!repoPath || !ref) return { repo: url };
  return { repo: `${host}/${repoPath}`, ref };
}

function parseGitSource(source) {
  const trimmed = source.trim();
  if (!trimmed.startsWith('git:')) return undefined;
  const { repo: repoWithoutRef, ref } = splitRef(trimmed.slice(4).trim());
  const slashIndex = repoWithoutRef.indexOf('/');
  if (slashIndex < 0) return undefined;
  const host = repoWithoutRef.slice(0, slashIndex);
  const repoPath = repoWithoutRef.slice(slashIndex + 1).replace(/\.git$/, '');
  if (!host || !repoPath || repoPath.split('/').length < 2) return undefined;
  return { repo: host.includes('.') ? `https://${repoWithoutRef}` : repoWithoutRef, host, path: repoPath, ref };
}

const parsed = parseGitSource(process.env.TLH_CRITICAL_SOURCE || '');
if (!parsed?.ref) process.exit(0);
console.log(`${path.join(process.env.TLH_AGENT_DIR || '', 'git', parsed.host, parsed.path)}\t${parsed.repo}\t${parsed.ref}`);
NODE
)"
  [ -n "$spec" ] || return 0
  target_dir="$(printf '%s' "$spec" | cut -f1)"
  repo="$(printf '%s' "$spec" | cut -f2)"
  ref="$(printf '%s' "$spec" | cut -f3)"
  agent_real="$(cd "$TLH_AGENT_DIR" && pwd -P)" || return 1
  target_real="$(cd "$target_dir" && pwd -P)" || return 1
  case "$target_real/" in "$agent_real/"*) ;; *) echo "Refusing critical checkout outside TLH profile: $target_dir" >&2; return 1 ;; esac
  if [ -L "$target_dir" ] || [ -L "$target_dir/.git" ]; then
    echo "Refusing symlinked critical checkout path: $target_dir" >&2
    return 1
  fi
  git -C "$target_dir" remote set-url origin "$repo" 2>/dev/null || git -C "$target_dir" remote add origin "$repo"
  git -C "$target_dir" fetch --prune --tags origin
  target_ref="$ref"
  if git -C "$target_dir" rev-parse --verify --quiet "refs/tags/$ref^{commit}" >/dev/null; then
    target_ref="refs/tags/$ref^{commit}"
  elif git -C "$target_dir" rev-parse --verify --quiet "refs/remotes/origin/$ref^{commit}" >/dev/null; then
    target_ref="refs/remotes/origin/$ref"
  fi
  git -C "$target_dir" checkout --detach "$target_ref"
  git -C "$target_dir" reset --hard "$target_ref"
  git -C "$target_dir" clean -fdx
  [ ! -f "$target_dir/package.json" ] || npm --prefix "$target_dir" install --omit=dev --legacy-peer-deps --package-lock=false
}

printf '%s\n' "$TLH_DEFAULT_SOURCES" | while IFS= read -r source; do
  [ -n "$source" ] || continue
  if printf '%s\n' "$TLH_CRITICAL_SOURCES" | grep -Fxq -- "$source"; then
    PI_CODING_AGENT_DIR="$TLH_AGENT_DIR" pi install "$source" || {
      echo "Critical default extension package install failed: $source" >&2
      exit 1
    }
    refresh_critical_git_source "$source" || {
      echo "Critical default extension package checkout refresh failed: $source" >&2
      exit 1
    }
  else
    PI_CODING_AGENT_DIR="$TLH_AGENT_DIR" pi update --extension "$source" || \
      echo "Warning: default extension package update failed; continuing: $source" >&2
  fi
done
```

Run without the wrapper:

```sh
PI_CODING_AGENT_DIR="$HOME/.the-last-harness/agent" pi
```

## Installer options

```text
--dry-run        Print actions and settings/keybinding changes without writing
--force          Allow scalar isolated defaults and installer wrapper overwrite
--no-pi-install  Fail instead of installing Pi when the `pi` command is missing
--no-settings     Install the package but skip isolated settings/keybinding merge
--no-wrapper      Skip creating the tlh wrapper command
--with-gnosis     Force install/re-enable Gnosis (`gn`) integration
--without-gnosis  Opt out of Gnosis integration and keep it disabled
--no-gnosis       Alias for --without-gnosis
--agent-dir DIR   Isolated Pi agent dir, default ~/.the-last-harness/agent
--bin-dir DIR     Wrapper install dir, default ~/.local/bin
--wrapper-name N  Wrapper command name, default tlh
--ref REF         Install from a branch, tag, or commit
--track TRACK     Update track: latest-release, pinned-tag, ref, custom
--quiet          Suppress installer progress output
--verbose        Show underlying pi, npm, and git output
```

Example pinned install:

```sh
curl -fsSL https://github.com/diegopetrucci/the-last-harness/releases/download/v0.6.0/install.sh | bash -s --
```

## Update

You can just run `tlh update`.

This refreshes the isolated checkout according to your update track and re-merges installer defaults. Latest-release installs move to the newest GitHub Release, pinned-tag installs stay on their pinned tag, and `main`/ref installs keep following that ref. If you are updating from an older install without `tlh update`, rerun the latest-release installer once with `TLH_UPDATE_TRACK=latest-release`.

Normal updates preserve your Gnosis setting. If you disabled it with `tlh gnosis disable`, toggled it off with `/gnosis`, or installed with `--without-gnosis`, it stays disabled across `tlh update`; use `tlh update --with-gnosis` to install/re-enable it automatically, or install `gn` manually and run `tlh gnosis enable` or `/gnosis`.

The updating process is intentionally conservative, and won't replace your custom extensions, themes, and so on. If you spot anything that was overridden, [please open an issue](https://github.com/diegopetrucci/the-last-harness/issues).

At launch, TLH checks GitHub Releases in the background at most once per day and warns once when a newer release is available. It never auto-updates. Set `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `TLH_SKIP_UPDATE_CHECK=1`, or `"tlh": { "updateCheck": { "enabled": false } }` in the isolated settings to disable the check.

Release builds with TelemetryDeck identifiers configured also send at most one pseudonymous launch event when an interactive `tlh` process starts. The event includes a hashed random install ID, event type, TLH version, privacy-filtered model value, OS name/version, and OS architecture. It does not include prompts, cwd, command arguments, repo names, hostname, username, file contents, settings contents, full environment variables, extension/package lists, API keys, provider base URLs, auth state, headers, or account identifiers. TelemetryDeck receives normal network metadata such as source IP address and request time.

To opt out persistently, set `"tlh": { "telemetry": { "enabled": false } }` in `~/.the-last-harness/agent/settings.json`. This opt-out is user-owned and survives `tlh update` and installer reruns. Per-run opt-outs are `PI_OFFLINE=1`, `TLH_SKIP_TELEMETRY=1`, `TLH_TELEMETRY_DISABLED=1`, or `PI_TELEMETRY=0`. To reset only the pseudonymous install ID, remove `~/.the-last-harness/agent/tlh/telemetry-state.json`.

To update bundled default extension packages too, run `tlh update`; it refreshes pinned critical defaults safely before updating other enabled defaults.

## Uninstall

Remove the isolated wrapper and profile:

```sh
rm -f ~/.local/bin/tlh
rm -rf ~/.the-last-harness
```

This does not uninstall upstream Pi, because you may use normal `pi` separately.

To remove upstream Pi entirely, only if you installed it solely for The Last Harness:

```sh
npm uninstall -g @earendil-works/pi-coding-agent
```

## Security note

The one-line installer and `tlh update` run shell commands on your machine, may install global npm packages for Pi and bundled default extensions, may download an optional Gnosis binary into the isolated TLH profile if you accept, creates an isolated Pi profile, and writes a wrapper command. Review `install.sh` before piping it to `bash` if you prefer. At launch, TLH may contact GitHub Releases to check for new TLH versions unless disabled with the update-check opt-outs above. This repo does not create, read, or modify API keys or auth files.
