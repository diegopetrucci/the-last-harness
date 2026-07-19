# Web search

TLH ships [`pi-web-access`](https://github.com/diegopetrucci/pi-web-access) as a non-critical default extension. TLH manages it as the scoped package `npm:@diegopetrucci/pi-web-access@0.10.10`. The `web-scout` subagent uses its `web_search`, `fetch_content`, and `get_search_content` tools for general web research.

GitHub-specific research — repositories, issues, pull requests, releases, and project docs — still goes to the `librarian` subagent, which uses read-only `gh api` REST calls plus plain `git clone` only when checkout inspection is genuinely necessary (no extension package required). Authenticate first with `gh auth login`, confirm with `gh auth status`, preflight with `gh api rate_limit`, and prefer concrete REST reads such as `gh api repos/OWNER/REPO`, `gh api repos/OWNER/REPO/issues/NUMBER`, `gh api repos/OWNER/REPO/pulls/NUMBER`, `gh api repos/OWNER/REPO/commits/SHA/check-runs`, and `gh api repos/OWNER/REPO/commits/SHA/status`; add `gh api --paginate ...` for list endpoints. Review threads and `statusCheckRollup` remain GraphQL-only limitations, and librarian does not perform GitHub mutations.

Running another `pi-web-access` provider alongside the TLH-managed package is unsupported because the tool names conflict. During TLH install/update, TLH migrates known upstream, manual, and older TLH `pi-web-access` variants in the same isolated profile to `npm:@diegopetrucci/pi-web-access@0.10.10`. If you want TLH to stop managing that extension, opt out first with `tlh defaults disable pi-web-access`; otherwise install/update runs will keep the scoped TLH package pinned. If multiple providers are already installed, remove the extras so only one `pi-web-access` provider remains active.

## Configuration

- Extension source: `npm:@diegopetrucci/pi-web-access@0.10.10`
- Settings: `${PI_CODING_AGENT_DIR}/extensions/pi-web-access/settings.json`
- Cache and Exa usage tracker: `${PI_CODING_AGENT_DIR}/cache/pi-web-access/`
- The extension never reads or writes `~/.pi/`.

## EXA API key precedence

1. Explicit `exaApiKey` in `${PI_CODING_AGENT_DIR}/extensions/pi-web-access/settings.json`
2. `EXA_API_KEY` environment variable
3. Zero-config Exa MCP fallback (1 k req/mo shared free tier)

TLH never persists the key unless you explicitly set it.

## Privacy

Queries leave the machine via Exa. Exactly what is transmitted is documented in the fork's README under ["What leaves the machine"](https://github.com/diegopetrucci/pi-web-access#what-leaves-the-machine).

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

For durable web-search / web-scout decisions, see repo-local Gnosis entries `ywsuwh` and `gbmehw`. For scoped npm pin and source-release details, see [`docs/web-search-fork-release-cadence.md`](web-search-fork-release-cadence.md).
