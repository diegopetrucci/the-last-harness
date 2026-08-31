# Telemetry

Release builds with TelemetryDeck identifiers configured send pseudonymous telemetry from interactive `tlh` runs.

## Signals and frequency

### `Tlh.launched`

Sent at most once when an interactive `tlh` process starts.

Custom dimensions sent on this event:

- `Tlh.App.version`
- `Tlh.Runtime.provider`
- `Tlh.Runtime.modelEffort`
- `Tlh.PrimaryAgent.name`
- `Tlh.Device.osName`
- `Tlh.Device.osVersion`
- `Tlh.Device.osArch`
- `Tlh.Experimental.delta-follow-up-reviews`
- `Tlh.Experimental.ci-failure-investigation`
- `Tlh.Subagent.code-reviewer.modelEffort`
- `Tlh.Subagent.contrarian.modelEffort`
- `Tlh.Subagent.developer.modelEffort`
- `Tlh.Subagent.diff-summarizer.modelEffort`
- `Tlh.Subagent.librarian.modelEffort`
- `Tlh.Subagent.oracle.modelEffort`
- `Tlh.Subagent.repo-scout.modelEffort`
- `Tlh.Subagent.test-runner.modelEffort`
- `Tlh.Subagent.web-scout.modelEffort`

Experimental feature dimensions are always reported for registered TLH features as `on` or `off`. Unknown, custom, or legacy `tlh.experimental.enabledFeatures` values are ignored and never sent.

## Provider and value semantics

`Tlh.Runtime.provider` means the selected runtime provider ID for the execution or model selection. It does **not** mean credential type, auth state, subscription tier, or router/backend details behind that provider.

Privacy filtering is conservative:

- `Tlh.Runtime.provider` sends the normalized provider ID only when it is in TLH's public allowlist; unknown, stale, or custom IDs become `custom`, and missing values become `unknown`.
- `Tlh.Runtime.modelEffort` is a single colon-joined token `<model>:<effort>` — for example `claude-opus-4-5:high` or `unknown:unknown`. This mirrors the separator used by upstream Pi's `applyThinkingSuffix`. Both sides are **always** joined; there is no bare model or bare effort key.
  - The model side sends only the final model segment and only when it matches a public-looking model family pattern such as `gpt-*`, `o*`, `chatgpt-*`, `claude-*`, `gemini-*`, `grok-*`, `deepseek-*`, `qwen*`, `kimi-*`, `mistral-*`, `codestral-*`, `devstral-*`, `llama-*`, `command-*`, `nova-*`, or `mimo-*`; otherwise it becomes `custom`, and missing values become `unknown`.
  - The effort side sends one of the seven canonical thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Any other non-empty string becomes `custom`; missing or empty values become `unknown`. The match is **case-sensitive** — a value like `High` does not match `high` and is reported as `custom`, reflecting that the upstream runtime would not honour it either.
  - Both sides default independently: `unknown:unknown`, `custom:high`, `claude-opus-4-5:unknown`.
- `Tlh.PrimaryAgent.name` sends `architect`, `bug-hunter`, `product`, or `rush`; other values become `custom`, and missing values become `unknown`.
- Each `Tlh.Subagent.<name>.modelEffort` key follows the same colon-joined `<model>:<effort>` format as `Tlh.Runtime.modelEffort`. The effort side follows the same seven-level vocabulary and the same case-sensitive rule when the value comes from a `subagents.agentOverrides` settings string. However, when the value comes from subagent frontmatter, the frontmatter reader applies an `isThinkingLevel` guard that drops any unrecognised value to `undefined` before the privacy filter is reached — so an invalid frontmatter effort value surfaces as `unknown`, not `custom`. This also means the case-sensitivity note above applies: a frontmatter value like `High` is unrecognised and becomes `unknown`, not `custom`.
  - Subagent model resolution uses the real available-models registry captured at launch time — the same registry the runtime uses — rather than a synthetic list built from frontmatter. Two behaviours follow from this:
    - A provider-qualified frontmatter model (e.g. `anthropic/claude-opus-5`) is reported only if that exact entry is present in the available-models list. If it is not, both the `selectProviderAwareAgentDefaults` lookup and the fallback guard in `readSubagentFrontmatterConfig` return `undefined`, and the model side is reported as `unknown`. This is deliberate: a plausible-but-wrong model name is worse than `unknown` as a telemetry signal.
    - A bare, unqualified model name (e.g. `claude-opus-4-5`, no slash) cannot be looked up against the registry and is only used as a fallback when no registry-backed candidate was selected. In that case it is reported as-is after the standard privacy filter; the value reflects what is written in configuration rather than a confirmed effective selection.
  - Model resolution follows this precedence (highest first):
    1. **`preferOppositeProvider`** — if set to `true` and an opposite-provider candidate is available, it wins immediately.
    2. **`preferCurrentOpenaiModel`** — if set to `true`, the current-provider OpenAI candidate is tried before the standard sequence.
    3. **Legacy generic `model:` compatibility** — when no `tlhModelDefaults` block is present, a provider-qualified value is normalized into preferred-model compatibility metadata and matched before provider candidates.
    4. **Current-provider candidate** — the current-provider OpenAI candidate first, then the current-provider Anthropic candidate, using normalized entries.
    5. **Remaining normalized `tlhModelDefaults` entries** — OpenAI-family models are searched first, followed by Anthropic-family models; declaration order is used only within each family. Legacy provider model fields (`tlhOpenaiModels` and `tlhAnthropicModels`) are normalized into this same collection before selection, not as a separate final stage.
- When a subagent is disabled via `subagents.agentOverrides`, its `modelEffort` key is reported as the single token `disabled` (not `disabled:disabled`). This value does not collide with any canonical thinking level and signals clearly that the agent is turned off.
- When an individual side is explicitly cleared via `model: false` or `thinking: false` in `subagents.agentOverrides`, the affected side is reported as `cleared` while the other side is still resolved normally — for example `cleared:medium` or `claude-opus-4-5:cleared`. This sentinel does not collide with any canonical thinking level or public model ID pattern and signals that the user explicitly removed the bundled default without disabling the agent entirely.

## Installation identity and unique users

Each installation stores a random install ID in `~/.the-last-harness/agent/tlh/telemetry-state.json`. TLH hashes that install ID before sending telemetry.

That means TelemetryDeck unique-user aggregation continues to represent pseudonymous TLH installations, not human identities, launches, or individual agent runs. Deleting `~/.the-last-harness/agent/tlh/telemetry-state.json` resets only that installation-level pseudonymous identity.

## What is not sent

Telemetry does **not** include:

- primary or minor-agent tasks, prompts, outputs, or summaries,
- current working directory,
- command arguments,
- repo names,
- hostname,
- username,
- file contents,
- settings contents,
- full environment variables,
- extension or package lists,
- session, run, or tool-call identifiers,
- session files or paths,
- token usage,
- cost,
- API keys,
- provider base URLs or other endpoints,
- auth state, credential/auth type, or headers,
- account identifiers,
- custom-agent names or project paths,
- attempted model history beyond the final selected privacy-filtered model value.

TelemetryDeck also receives normal network metadata such as source IP address and request time.

## Opting out

All signals respect the same opt-outs.

Opt out persistently by adding this to `~/.the-last-harness/agent/settings.json`:

```json
{
  "tlh": {
    "telemetry": {
      "enabled": false
    }
  }
}
```

That settings opt-out is preserved by `tlh update` and installer reruns.

For a single run, set one of:

- `PI_OFFLINE=1`
- `TLH_SKIP_TELEMETRY=1`
- `TLH_TELEMETRY_DISABLED=1`
- `PI_TELEMETRY=0`

To reset only the pseudonymous install ID, remove `~/.the-last-harness/agent/tlh/telemetry-state.json`.
