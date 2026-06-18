# Git commit attribution

When an agent creates a git commit through the bash tool, TLH can require a built-in TLH footer at the end of the commit message. This behavior is isolated to TLH's own profile under `~/.the-last-harness/agent`.

## Default behavior

TLH reads `tlh.attribution.commit` from `~/.the-last-harness/agent/settings.json`.

- When `tlh.attribution.commit` is unset or `true`, TLH requires the built-in footer.
- When `tlh.attribution.commit` is `false`, TLH disables commit attribution.

When attribution is enabled, agent-created bash `git commit` messages must end with this exact footer:

```text
Co-authored-by: The Last Harness <hi@thelastharness.com>
```

## Toggle from a TLH session

Run `/toggle-tlh-git-attribution` in an interactive TLH session.

- If attribution is enabled, the command writes `tlh.attribution.commit=false` and disables the footer persistently.
- Run `/toggle-tlh-git-attribution` again to write `tlh.attribution.commit=true` and re-enable it.
- If TLH updates an existing settings file, it keeps the change inside the isolated TLH profile and writes a backup before the file rewrite.

## Manual disable and re-enable

You can manage the same setting yourself in `~/.the-last-harness/agent/settings.json`:

- Set `tlh.attribution.commit` to `false` to disable TLH commit attribution.
- Set `tlh.attribution.commit` to `true` to re-enable it explicitly.
- Delete `tlh.attribution.commit` to return to TLH's built-in default footer.

## Ephemeral fixture exemption

The attribution guard uses a **CWD-aware, per-commit** check as it walks through the segments of a command chain. A `git commit` is exempt only when it is *proven* to target an ephemeral temp fixture at the commit's position in the chain.

### How the walk works

TLH processes segments in order, maintaining:

- **`inTempContext`** — set `true` after a `cd` to a recognised temp root (literal path, `$TMPDIR`/`$TMP` reference, or a variable assigned from `mktemp`); set `false` after a `cd` to any other path or an unresolvable target (fail-safe).
- **`sawGitInitInTemp`** — set `true` when `git init` runs while `inTempContext`, or when `git -C <temp-path> init` explicitly targets a temp path.
- **`tempInitPaths`** — the set of explicit temp paths that were `git init`-ed via `git -C <path> init`.

A `git commit` segment is exempt (not blocked) **only if** one of these conditions holds at its position in the walk:

1. `inTempContext && sawGitInitInTemp` — the CWD was moved into a temp dir that had `git init` run inside it.
2. The commit itself uses `git -C <path>` where `<path>` is in `tempInitPaths` — the commit explicitly targets a temp path that was previously `git init`-ed.

Wrapped shells (e.g. `bash -lc '...'`, `sh -c '...'`) get **fresh, independent state** so that their inner command chains are evaluated on their own.

### Example chains that are exempt

```bash
tmp=$(mktemp -d) && cd "$tmp" && git init -q && git commit -m init
# ^ inTempContext=true, sawGitInitInTemp=true at commit time → exempt

git -C /tmp/fixture init && git -C /tmp/fixture commit -m init
# ^ tempInitPaths={'/tmp/fixture'}, commit uses same -C path → exempt

bash -lc 'tmp=$(mktemp -d) && cd "$tmp" && git init -q && git commit -m init'
# ^ inner shell evaluated with fresh state; same logic applies → exempt
```

### Examples that remain blocked (attribution still required)

```bash
git commit -m "ship it"                          # neither signal
git init && git commit -m "ship it"              # no temp-dir context
cd /tmp/mydir && git commit -m "ship it"         # no git init

git -C /tmp/fixture init && git commit -m "real"
# ^ commit has no -C; inTempContext is false → still blocked

tmp=$(mktemp -d) && cd "$tmp" && git init && cd /real/repo && git commit -m "real"
# ^ cd /real/repo clears inTempContext before the commit → still blocked
```

## What does not change

TLH does not change `git push`. Attribution only affects the commit message before you push.
