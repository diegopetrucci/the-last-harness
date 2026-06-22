## Summary

_What changed and why. Keep it short; link to the ticket or issue if one exists._

## Change type

- [ ] Installer / wrapper
- [ ] Extension / skill / prompt / theme
- [ ] Docs
- [ ] CI / release
- [ ] Pin PR (update a `config/default-extensions.json` fork tag)
- [ ] Other

## Validation

_Describe the checks you ran. Delete paths that do not apply._

**Standard validation (most changes):**

```sh
npm run validate
```

**Installer-specific checks (use temp paths — do not touch a real profile):**

```sh
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
```

**Docs-only changes:** narrower validation is acceptable; confirm rendered content shape and review the diff before opening.

_Paste the relevant output or a summary here:_

## Pre-review checklist

- [ ] Change preserves isolation and installer safety invariants:
  - never mutates `~/.pi/agent` (the user's normal Pi configuration)
  - all installer-created Pi commands set `PI_CODING_AGENT_DIR` to the isolated profile directory
  - settings merges are conservative: append missing packages, respect opt-outs, preserve existing isolated-user values, back up before writes
  - does not clobber unmanaged wrapper files without an explicit `--force`
- [ ] Relevant tests or smoke checks pass
- [ ] Docs and `CHANGELOG.md` updated where a user-visible change warrants it
- [ ] Diff contains no secrets, local paths, or unintended generated files

---

## Pin PR (optional — delete this section if unused)

_Fill in only when this PR updates a `config/default-extensions.json` fork tag. Title convention: `Pin <component> to <tag> (<brief note>)`._

**What the new fork tag / pin includes:**

**Link to merged fork PR:**

**Before → after pin:**

**`npm run validate` result:**

---

## Install this branch

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/<branch>/install.sh | bash -s -- --ref <branch> --track ref
```
