# Web search

TLH ships [`@diegopetrucci/pi-web-access@0.29.2`](https://github.com/diegopetrucci/pi-web-access) as a non-critical default extension. It is an Exa-only selective fork, not a feature-parity release. The `web-scout` subagent uses its three tools for general web research; GitHub-specific research still goes to the TLH `librarian` subagent, which uses `gh` and `git` directly.

During an install or update, TLH migrates recognized upstream, manual, and prior TLH `pi-web-access` sources in the isolated profile to the scoped `0.29.2` package. If you need to keep another provider or one of the removed capabilities, run `tlh defaults disable pi-web-access` before updating; the opt-out preserves that provider instead of replacing it.

## Current surface

The extension registers exactly these tools:

- `web_search` — search Exa with one query or a bounded batch, optional recency, and hostname filters.
- `fetch_content` — fetch up to six HTTP(S) URLs and extract readable Markdown locally.
- `get_search_content` — retrieve bounded stored search or fetched content by response ID.

There are no `/websearch`, `/curator`, or `/search` commands, `code_search` or `source_check` tools, alternate providers, automatic provider fallbacks, or bundled research skill. GitHub cloning, PDF extraction, video/YouTube handling, browser-cookie access, hosted extraction, and summary-review workflows are also removed. The three tools do not make hidden model calls or automatically fetch search-result pages.

## Isolated profile and configuration

`PI_CODING_AGENT_DIR` is required and must be an absolute path whenever a web-access tool is used. TLH's wrapper sets it to the isolated profile; the extension has no fallback to `~/.pi`, `XDG_CONFIG_HOME`, or a legacy profile path. Do not point it at the normal `~/.pi/agent` profile.

The optional settings file is:

```text
$PI_CODING_AGENT_DIR/extensions/pi-web-access/settings.json
```

The fetched-content cache is isolated at:

```text
$PI_CODING_AGENT_DIR/cache/pi-web-access/
```

The supported settings are exactly:

```json
{
  "exaApiKey": "exa-...",
  "fetch": {
    "timeout": 30
  },
  "fetchContent": {
    "domainPolicy": {
      "allow": ["docs.example.com"],
      "deny": ["private.example.com"]
    }
  },
  "maxInlineContentChars": 12000
}
```

- `exaApiKey` is optional. Precedence is isolated settings, then `EXA_API_KEY`, then keyless Exa MCP. An empty setting falls through to the environment; invalid values fail closed.
- `fetch.timeout` is an integer from 1 through 120 seconds and defaults to 30.
- `fetchContent.domainPolicy.allow` and `.deny` contain hostname arrays. The deny list wins, subdomains match, and wildcards are not accepted. This policy applies to `fetch_content`, not Exa's fixed endpoints.
- `maxInlineContentChars` is an integer from 512 through 30,000 and defaults to 12,000.

Unknown keys, custom provider endpoints, credential commands, and proxy settings are not supported. Settings are read for each request. There is no local Exa usage accounting; the cache stores fetched content only, with bounded expiry and size limits.

## Network and privacy boundaries

With a key, searches use Exa's fixed `https://api.exa.ai/search` endpoint. Without a key, keyless Exa MCP still requires outbound network access. Page extraction runs locally; page content is not sent to an LLM or hosted extraction service. The extension does not persist API keys or copy them into settings. A key appears in the isolated settings file only if you explicitly write it there.

Remote fetches allow only HTTP(S), reject URL credentials, block loopback/private/reserved addresses and local hostnames, resolve DNS before connecting, and revalidate redirects. The package has no telemetry or browser-cookie access. Never use real credentials or provider requests for compatibility probes.

## Opt out

The extension is non-critical, so disabling it is safe and reversible when you want TLH to stop managing it in the isolated profile:

```sh
tlh defaults disable pi-web-access   # opt out
tlh defaults enable pi-web-access    # re-enable
```

Running another `pi-web-access` provider alongside the TLH-managed package is unsupported because the tool names conflict. If an older or manually installed provider is present, keep only one provider active before using web tools.

## Manual migration from the legacy settings file

TLH does not automatically migrate an existing isolated `<agent>/web-search.json`, persist its key, or modify the normal `~/.pi/agent` profile. The old file contains options that 0.29.2 deliberately removed, so do not copy it wholesale. Review it first and migrate only the supported `exaApiKey` field (if present); configure the new `fetch`, `fetchContent.domainPolicy`, and `maxInlineContentChars` settings separately. An older isolated `$PI_CODING_AGENT_DIR/exa-usage.json`, if present, is unused by 0.29.2 and is not auto-deleted.

The following guarded example validates the profile and canonical paths inside Python, refuses the normal Pi profile and outside symlink targets, refuses to overwrite an existing destination, and writes only `exaApiKey`:

```sh
python3 - <<'PY'
import json
import os
import sys


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def is_under(path, root):
    try:
        return os.path.commonpath((path, root)) == root
    except ValueError:
        return False


raw_agent_dir = os.environ.get("PI_CODING_AGENT_DIR", "").strip()
if not raw_agent_dir:
    fail("PI_CODING_AGENT_DIR must name the absolute isolated TLH profile")
if not os.path.isabs(raw_agent_dir):
    fail("PI_CODING_AGENT_DIR must be absolute")

agent_dir = os.path.realpath(raw_agent_dir)
normal_dir = os.path.realpath(os.path.expanduser("~/.pi/agent"))
if is_under(agent_dir, normal_dir):
    fail(f"Refusing to use the normal Pi profile: {agent_dir}")

source = os.path.join(agent_dir, "web-search.json")
target = os.path.join(agent_dir, "extensions", "pi-web-access", "settings.json")
target_parent = os.path.dirname(target)
source_canonical = os.path.realpath(source)
target_parent_canonical = os.path.realpath(target_parent)
for label, path in (("legacy source", source_canonical), ("destination parent", target_parent_canonical)):
    if not is_under(path, agent_dir):
        fail(f"Refusing {label} outside the isolated profile: {path}")
    if is_under(path, normal_dir):
        fail(f"Refusing {label} inside the normal Pi profile: {path}")

if not os.path.isfile(source):
    fail(f"Legacy settings file not found: {source}")
if os.path.lexists(target):
    fail(f"Refusing to overwrite existing destination: {target}")

with open(source, encoding="utf-8") as handle:
    legacy = json.load(handle)
if not isinstance(legacy, dict):
    fail("Legacy settings must contain a JSON object")

migrated = {}
if "exaApiKey" in legacy:
    key = legacy["exaApiKey"]
    if not isinstance(key, str) or not key.strip():
        fail("Legacy exaApiKey is not a non-empty string")
    migrated["exaApiKey"] = key

unsupported = sorted(set(legacy) - {"exaApiKey"})
if unsupported:
    print("Not migrated (unsupported by pi-web-access 0.29.2): " + ", ".join(unsupported), file=sys.stderr)
if not migrated:
    fail("No supported legacy settings were found; destination was not created")

os.makedirs(target_parent, mode=0o700, exist_ok=True)
# Re-check the parent after directory creation before opening the destination.
target_parent_after = os.path.realpath(target_parent)
if not is_under(target_parent_after, agent_dir) or is_under(target_parent_after, normal_dir):
    fail("Refusing destination parent replacement outside the isolated profile")
if os.path.lexists(target):
    fail(f"Refusing to overwrite existing destination: {target}")

flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
fd = os.open(target, flags, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(migrated, handle, indent=2)
    handle.write("\n")
print(f"Migrated supported settings to {target}")
PY
```

The source file is left untouched. If the destination already exists, review or merge it manually; do not overwrite it by default. The destination is package-owned settings data, not an automatic migration record.

## Rollback

The previous TLH pins for this update were `pi-fast@0.1.4`, `pi-anthropic-auth@3.3.2`, `pi-web-access@0.10.10`, and `pi-context-inspector@0.1.13`. To roll back, restore the prior TLH release/commit (or restore only those four manifest pins in a controlled release checkout) and rerun the isolated TLH install/update. The update flow may replace the managed package source, but it must not overwrite either `$PI_CODING_AGENT_DIR/web-search.json` or an existing `$PI_CODING_AGENT_DIR/extensions/pi-web-access/settings.json`.

Before removing the newer package, preserve any settings you want to keep. If you explicitly clean up package-owned settings or cache, first validate the absolute profile path and canonicalize both destinations under that isolated profile; never remove paths from an unvalidated environment variable. These steps must not modify `~/.pi/agent` or any external service.

For the scoped package release and source-audit process, see [`docs/web-search-fork-release-cadence.md`](web-search-fork-release-cadence.md).
