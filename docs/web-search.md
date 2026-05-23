# Web search

TLH ships [`pi-web-access`](https://github.com/diegopetrucci/pi-web-access) (an Exa-only fork) as a non-critical default extension. The `web-scout` subagent uses its `web_search`, `fetch_content`, and `get_search_content` tools for general web research.

GitHub-specific research — repositories, issues, pull requests, releases, and project docs — still goes to `librarian`.

Running the upstream `pi-web-access` extension alongside the TLH fork is unsupported because the tool names conflict. Normal TLH install/update runs now defer to a known upstream/manual `pi-web-access` package that is already present in the same isolated profile, so you can keep that provider active without extra steps. If both providers are already installed, remove the TLH fork package from that isolated profile or otherwise make sure only one `pi-web-access` provider remains active.

## Configuration

- Extension source: `git:github.com/diegopetrucci/pi-web-access@tlh-v0.10.7-1`
- Settings: `${PI_CODING_AGENT_DIR}/extensions/pi-web-access/settings.json`
- Cache and Exa usage tracker: `${PI_CODING_AGENT_DIR}/cache/pi-web-access/`
- The extension never reads or writes `~/.pi/`.

## EXA API key precedence

1. Explicit `exaApiKey` in `${PI_CODING_AGENT_DIR}/extensions/pi-web-access/settings.json`
2. `EXA_API_KEY` environment variable
3. Zero-config Exa MCP fallback (1 k req/mo shared free tier)

TLH never persists the key unless you explicitly set it.

## Privacy

Queries leave the machine via Exa. Exactly what is transmitted is documented in the fork's README under ["What leaves the machine"](https://github.com/diegopetrucci/pi-web-access/blob/tlh-v0.10.7-1/README.md#what-leaves-the-machine).

## Opt out

The extension is non-critical, so disabling it is safe and reversible when you want TLH to opt out of managing `pi-web-access` for that isolated profile:

```sh
tlh defaults disable pi-web-access   # opt out
tlh defaults enable pi-web-access    # re-enable
```

## Manual migration

TLH does not automatically migrate an existing `~/.pi/web-search.json`. To copy it into the isolated TLH profile manually:

```sh
agent_dir="$(python3 - <<'PY'
import os
import sys

agent_dir = os.path.realpath(os.path.expanduser(
    os.environ.get("PI_CODING_AGENT_DIR") or "~/.the-last-harness/agent"
))
pi_agent = os.path.realpath(os.path.expanduser("~/.pi/agent"))
if os.path.commonpath((agent_dir, pi_agent)) == pi_agent:
    print(f"Refusing to write to the normal Pi profile: {agent_dir}", file=sys.stderr)
    raise SystemExit(1)
print(agent_dir)
PY
)" || exit 1
target="$agent_dir/extensions/pi-web-access/settings.json"
test ! -e "$target" || {
  echo "Refusing to overwrite existing TLH settings: $target" >&2
  exit 1
}
mkdir -p "$agent_dir/extensions/pi-web-access"
install -m 600 ~/.pi/web-search.json "$target"
```

If `$target` already exists, review or merge it manually instead of overwriting it by default.

For durable web-search / web-scout decisions, see repo-local Gnosis entries `ywsuwh` and `gbmehw`. For pinned fork/tag process details, see [`docs/web-search-fork-release-cadence.md`](web-search-fork-release-cadence.md).
