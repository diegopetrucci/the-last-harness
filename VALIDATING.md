# Validating TLH changes

Run `npm run validate` before considering repository changes ready. It is the aggregate check for this repo.

## Useful targeted checks

```sh
bash -n install.sh
node --check scripts/tlh-gnosis.mjs
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
bash -s -- --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)" < install.sh
```

## Safety notes

- Prefer temporary `--agent-dir` and `--bin-dir` values for installer validation.
- Do not run a real install into home directories unless explicitly requested.
- Never point validation at normal user config such as `~/.pi/agent`.
