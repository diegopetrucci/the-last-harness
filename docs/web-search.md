# Web search

TLH ships [`pi-web-access`](https://github.com/diegopetrucci/pi-web-access) (an Exa-only fork) as a non-critical default extension. The `web-scout` subagent uses its `web_search`, `fetch_content`, and `get_search_content` tools for general web research.

GitHub-specific research — repositories, issues, pull requests, releases, and project docs — still goes to `librarian`.

Running the upstream `pi-web-access` extension alongside the TLH fork is unsupported because the tool names conflict.

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

The extension is non-critical, so disabling it is safe and reversible:

```sh
tlh defaults disable pi-web-access   # opt out
tlh defaults enable pi-web-access    # re-enable
```

## Manual migration

TLH does not automatically migrate an existing `~/.pi/web-search.json`. To copy it into the isolated TLH profile manually:

```sh
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.the-last-harness/agent}" && \
  mkdir -p "$agent_dir/extensions/pi-web-access" && \
  install -m 600 ~/.pi/web-search.json "$agent_dir/extensions/pi-web-access/settings.json"
```

For pinned fork/tag details and implementation notes, see [`docs/web-search-spec.md`](web-search-spec.md).
