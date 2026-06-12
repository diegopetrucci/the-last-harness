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

## What does not change

TLH does not change `git push`. Attribution only affects the commit message before you push.
