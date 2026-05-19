# Local development

Run these commands from the repository root with Node.js >=22.19.0. Prefer temporary isolated profile directories so local testing does not touch a real `tlh` or normal Pi profile.

## Run validation

For installer changes, run the smoke checks and package checks that cover the stage-0 Bash bootstrapper, the stage-1 Node helper, and packaged support files:

```sh
bash scripts/check-installer-smoke.sh
npm test
node scripts/merge-settings.mjs --dry-run
npm pack --dry-run
```

## Test the extension directly

Test the extension directly from this checkout without installing it:

```sh
pi --no-extensions -e ./extensions/the-last-harness.ts
```

Then run the effort picker in the interactive UI:

```text
/effort
```

You can also test direct arguments and validation:

```text
/effort off
/effort low
/effort high
/effort xhigh
/effort nope
```

## Test with an isolated temporary profile

```sh
tmp="$(mktemp -d)"
PI_CODING_AGENT_DIR="$tmp/agent" pi --no-extensions -e ./extensions/the-last-harness.ts
```

## Test the package install flow locally

```sh
tmp="$(mktemp -d)"
PI_CODING_AGENT_DIR="$tmp/agent" pi install "file:$PWD"
PI_CODING_AGENT_DIR="$tmp/agent" pi
```

Then run:

```text
/effort
```

## Test the defaults manager

```sh
tmp="$(mktemp -d)"
node scripts/merge-settings.mjs config/settings.defaults.json \
  --settings "$tmp/settings.json" \
  --default-extensions config/default-extensions.json
node scripts/tlh-defaults.mjs \
  --settings "$tmp/settings.json" \
  --defaults config/default-extensions.json \
  disable notify
```

## Test the Gnosis manager

```sh
tmp="$(mktemp -d)"
node scripts/tlh-gnosis.mjs --settings "$tmp/settings.json" status
node scripts/tlh-gnosis.mjs --settings "$tmp/settings.json" enable
node scripts/tlh-gnosis.mjs --settings "$tmp/settings.json" disable
```

## Test installer bootstrap and wrapper behavior

Dry-run the stage-0 bootstrapper with temporary paths. From a complete local checkout, `install.sh` should discover the local stage-1 helper instead of downloading support files:

```sh
bash install.sh --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
```

You can also run the stage-1 helper directly when iterating on Node-side installer orchestration:

```sh
node scripts/tlh-install.mjs --dry-run --agent-dir "$(mktemp -d)/agent" --bin-dir "$(mktemp -d)"
```

Test the local checkout without pushing it:

```sh
tmp="$(mktemp -d)"
TLH_PACKAGE_SOURCE="file:$PWD" bash install.sh \
  --track custom \
  --agent-dir "$tmp/agent" \
  --bin-dir "$tmp/bin"
"$tmp/bin/tlh"
```

You can also test any pushed branch through GitHub. Push the branch, then fetch
that branch's installer and pass the same branch name as `--ref`:

```sh
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/subagents/install.sh |
  bash -s -- --ref subagents --track ref
```

For temporary branch testing without touching your real `tlh` profile or wrapper:

```sh
tmp="$(mktemp -d)"
curl -fsSL https://raw.githubusercontent.com/diegopetrucci/the-last-harness/subagents/install.sh |
  bash -s -- \
    --ref subagents \
    --track ref \
    --agent-dir "$tmp/agent" \
    --bin-dir "$tmp/bin"
"$tmp/bin/tlh"
```

Replace `subagents` in both places with the pushed branch you want to test.
