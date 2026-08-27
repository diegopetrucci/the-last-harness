# TLH model defaults

## Model and thinking defaults

TLH applies bundled model/thinking defaults per primary agent. Architect, Product, and Bug-hunter use Anthropic Claude Opus 5 with high thinking on Anthropic and OpenAI Codex GPT-5.6 Sol with high thinking on OpenAI Codex. Rush uses Anthropic Claude Sonnet 4.6 with low thinking on Anthropic and OpenAI Codex GPT-5.6 Luna with medium thinking on OpenAI Codex. These provider-aware model and thinking values are defaults: all four primaries accept user model selections and supported thinking levels. Persistent model choices for active primaries are respected and stored per primary under `tlh.primaryAgent.modelOverrides.<primary>`; reset the current primary's override with `/switch-primary-agent model reset`. Architect retains its medium minimum thinking floor; Rush, Product, and Bug-hunter have no minimum floor. The native model-picker scope is documented below. The bundled `developer` subagent follows the active primary session provider with Anthropic Claude Sonnet 4.6 at medium thinking or OpenAI Codex GPT-5.6 Luna at max thinking. Other bundled subagents — `web-scout`, `repo-scout`, `librarian`, and `diff-summarizer` — default to OpenAI Codex GPT-5.6 Luna with medium thinking on the OpenAI Codex path and follow the active primary session provider when TLH injects model defaults. Model IDs may contain vendor path segments (for example, `openrouter/anthropic/...`), so use the complete `provider/model` ID in explicit settings.

### OpenRouter sessions

The upstream Pi runtime provides OpenRouter authentication and transport: use `/login openrouter` for OAuth or set `OPENROUTER_API_KEY`. TLH does not implement that provider's transport or authentication. Instead, all TLH primaries and non-opposite subagents follow the active OpenRouter session model. Their OpenRouter thinking default is `tlhOpenrouterThinking`; bundled values mirror each role's Anthropic thinking level. Architect's `minThinking` floor applies through that OpenRouter value; Rush, Product, and Bug-hunter accept any supported level with no minimum floor. Unknown versus explicitly non-reasoning capability checks apply to stored minor-agent effort overrides and generated fallback handling, not pure bundled or primary defaults. A pure bundled `tlhOpenrouterThinking` remains runtime-authoritative and is forwarded as the bundled target when appropriate.

For `code-reviewer`, `oracle`, and `contrarian` (`preferOppositeProvider`), TLH first looks for an available direct OpenAI/Codex or Anthropic candidate (both the Codex subscription provider and plain OpenAI API candidates qualify). For known `openrouter/anthropic/*` models it tries the opposite OpenAI/Codex family first, then an available Anthropic-family direct candidate; for known `openrouter/openai/*` models it tries Anthropic first, then an available OpenAI/Codex-family direct candidate. A same-family fallback reports degraded review independence. For unknown vendors it tries the OpenAI/Codex family first, but independence is unknown. The active OpenRouter session model remains the retry fallback, also with a reduced-independence notice. Stored or explicitly supplied model and effort overrides retain precedence over these defaults.

OpenRouter has no packaged model frontmatter catalog. Consequently, `/reconcile` cannot dynamically drift-check the OpenRouter session model or dynamically selected opposite-provider candidates; this is an accepted limitation. OpenRouter credit usage is not a subscription-window footer provider.

## Model selection scope

In the interactive TUI, `/model` **without an exact argument** and the default `Ctrl+L` shortcut open the native model picker. After that picker changes the active model, TLH opens a second picker titled `Model selection scope` with these exact labels, in this order:

1. `This session only — default`
2. `All sessions`

Choosing the model that is already active is a native reselection: it emits no `model_select` event, so TLH does not open the scope picker. The upstream global-default write is otherwise preserved. If that active model was previously marked `This session only — default`, TLH drops the reconfirmation write to preserve that session-only scope.

The two choices mean:

- **`This session only — default`** changes the current session but does not persist the model/provider or thinking-level defaults and does not write a per-primary model override. For an active primary, the choice is retained across turns and session-tree reapplication in this session. The choice is cleared at a new session start (including the runtime boundary caused by `/reload`) or an explicit primary-agent mode change. It does not affect future/default launches.
- **`All sessions`** keeps the upstream persistent model/provider (and any model-switch thinking-level) default in the isolated TLH profile. For an active primary, TLH also stores the selected model at `tlh.primaryAgent.modelOverrides.<primary>` when it differs from that primary's bundled default; selecting the bundled default clears that primary's override. The override is per primary, so another primary follows its own default or override. With no active primary, the profile default is the setting used by future launches.

`All sessions` controls future/default launches; its persisted `defaultThinkingLevel` is also honored by TLH for active primaries at new-session and explicit primary-mode boundaries, subject to model capabilities and Architect's floor. It does not switch or rewrite other existing/running sessions or their session files. The current session has already switched to the chosen model when this scope picker appears. On direct Anthropic/OpenAI-Codex and OpenRouter paths, an active primary keeps the selected model for this session and `All sessions` creates or clears that primary's model override according to whether the selection differs from its packaged default.

The scope prompt applies only to the native interactive picker. `/model <exact-name>` when it resolves directly, provider-auth or other direct/programmatic model applications, and model cycling retain their persistent upstream path without this prompt; model cycling does not create or edit a TLH per-primary override. A non-exact `/model` search that falls back to the interactive picker is subject to the scope prompt after a model change.

Canceling the scope picker (for example, with `Esc`) discards both the attempted model's default writes and any primary override, restores the previous active model, and leaves persistent settings unchanged. If restoration fails, TLH reports the warning and still does not persist the attempted model.

To undo a persistent choice, choose the desired model again through the native picker and select `All sessions`. For an active primary, `/switch-primary-agent model reset` clears that primary's persisted override and attempts to reapply its packaged default, subject to `tlh.primaryAgent.applyModel`. When it actually applies a different packaged model, upstream also updates the global profile default to that model. The global default stays unchanged if `applyModel` prevents application or the packaged model is already active; change the global default independently through the native picker as needed. Settings writes may show a `settings.json.bak-*` backup path; inspect a backup before restoring it over the active isolated profile settings file.

### Staying in sync when TLH updates its defaults

When TLH ships an update that changes the packaged model or effort default for a role you have overridden, it shows a one-line startup notice: `TLH default model/effort changed for <role> — run /reconcile to review`. The notice is non-blocking and reappears each launch until you act.

Run `/reconcile` to review and resolve the drift:

- **Keep** — acknowledges the new TLH default and preserves your override unchanged. Non-destructive: your setting is untouched.
- **Reset** — clears your override so the role falls back to TLH packaged defaults. For primary agents, the packaged default is also applied to the active session immediately (subject to your `tlh.primaryAgent.applyModel` setting). Undoable: restore the value through the native `/model` picker and choose `All sessions` (the default `This session only — default` option is session-only); for subagents, use `/subagent-settings set <role> ...`. Settings writes always create a `settings.json.bak-*` backup shown in the notification.

The **only trigger** is TLH changing a packaged default for a role you have overridden. There is no periodic or scheduled reminder.

Acknowledgments are per-provider. A Keep or Reset under one provider does not suppress the notice if you later switch providers and that provider's packaged default has since changed.

When the session provider is unknown, TLH defers all comparison — no notice appears and Keep is unavailable until a provider is active. Overrides that pre-date this release are silently backfilled on your first startup with a known provider; the notice then fires on the next packaged-default change after that point, not for any changes that occurred before the backfill.

The reported value is the canonical packaged default for the active provider, resolved from TLH's own bundled catalog. It may name a model your current environment cannot reach, and it may differ from the model Reset produces in a live session (for example, roles that prefer an opposite-provider model will show a same-provider fallback here). That does not block the decision; Keep and Reset work regardless.

Outside the TUI, `/reconcile` prints a read-only drift summary. See [`commands.md § /reconcile`](commands.md#reconcile) for the full grammar, trigger model, and undo steps.

### Review independence for code-reviewer, oracle, and contrarian

For review independence, `code-reviewer`, `oracle`, and `contrarian` (`preferOppositeProvider`) intentionally prefer an available opposite provider. Anthropic sessions try to use the OpenAI Codex subscription provider, while OpenAI/OpenAI-Codex sessions try Anthropic. OpenRouter sessions use the vendor-aware direct-provider selection described in [OpenRouter sessions](#openrouter-sessions). When TLH injects an opposite-provider model, it also supplies a current/session-provider fallback for retryable model failures; if that fallback is used, the subagent output includes a notice that review independence is reduced. If no direct candidate is available, TLH does not force these roles onto an unavailable default. All other bundled subagents follow the active primary session provider when TLH injects model defaults.

## Minor-agent model and effort overrides

Use `/subagent-settings` to persist model or effort choices for the bundled TLH minor-agent roles: `code-reviewer`, `contrarian`, `developer`, `diff-summarizer`, `librarian`, `oracle`, `repo-scout`, and `web-scout`.

- `/subagent-settings` opens a picker in the interactive TLH TUI; outside the TUI it reports status.
- `/subagent-settings status [role]` shows all roles or one role.
- `/subagent-settings set <role> [model <provider/id>] [effort <off|minimal|low|medium|high|xhigh|max>]` sets one or both fields; the `model` and `effort` pairs may be given in either order.
- `/subagent-settings reset <role> [model|effort]` clears one field or both, and `/subagent-settings reset-all` clears the saved model/effort fields for bundled roles only.

Values are stored under `subagents.agentOverrides` in the active isolated profile's `settings.json` (normally `~/.the-last-harness/agent/settings.json`, or the profile selected by `PI_CODING_AGENT_DIR`). A caller-supplied dispatch model takes precedence; otherwise stored role overrides are resolved before bundled provider-aware defaults. A fixed model can reduce provider independence for `code-reviewer`, `oracle`, and `contrarian`, so TLH warns and requires confirmation in UI sessions and refuses those writes in headless mode.

The valid effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Stored effort is applied when the resolved model advertises support (`max` requires `thinkingLevelMap` support); if a saved value is no longer supported, TLH warns and neutralizes it with the bundled effort or explicit `off` when possible. If neither is supported, the subagents runtime drops the unsupported value for a known model; unknown or unresolvable models fail open and still receive the suffix. `max` is also a live bundled default where configured, not a hypothetical value.

When existing settings content is replaced, TLH creates a `settings.json.bak-*` backup and shows its path. To undo a change, use the matching `reset` command, use `reset-all` for bundled roles, or restore the desired `settings.json.bak-*` backup over the active profile's `settings.json`.

See [`commands.md`](commands.md) for the complete grammar, precedence details, warnings, and recovery steps.

## Thinking selection scope

In the interactive TUI, `/thinking` and its `/effort` alias without a level first show the available thinking levels. After a changed selection, TLH opens `Thinking selection scope` with the same approved options as the native model picker: `This session only — default` or `All sessions`. The selected level stays active in the current session either way. The session-only choice leaves the upstream `defaultThinkingLevel` in the isolated profile unchanged; All sessions persists the level through that upstream setting for future/default sessions. Native thinking cycling/shortcuts and typed thinking choices use the same upstream durable setting and remain retained across later turns for the active unlocked primary. Architect's minimum floor is enforced before this scope picker appears; Rush, Product, and Bug-hunter accept every level supported by the current model.

Canceling the scope picker restores the level that was active before the thinking picker and leaves the persistent default unchanged. Selecting the already-active level still reports it but does not open the scope picker; dismissing the level picker or selecting a rejected/unavailable level also does not open it. Typed `/thinking <level>` and `/effort <level>` arguments, plus thinking cycling/shortcuts, retain their persistent upstream behavior. Pi persists a typed level only when it changes the active level, so to persist a session-only level that is already active, first change to another allowed level and then type the desired level. For an unlocked primary, an explicit selection remains active through later turns and session-tree reapplication while that primary remains selected. A model switch clamps the retained level to a supported level when necessary and updates that session intent; a new session or explicit primary-agent mode change clears session-only intent, then applies the persisted upstream default when present or the packaged provider-aware default otherwise.

## Hidden model defaults in the TLH profile

TLH also ships with a bundled hidden-model filter for a selected set of Anthropic and OpenAI Codex models. Those bundled defaults are built into TLH itself (currently in `extensions/the-last-harness/model-visibility.ts`); they are not written into `settings.json` as default JSON. Any `tlh.modelVisibility` entries you add under the TLH isolated profile at `~/.the-last-harness/agent/settings.json` are user overrides/additional customization only. TLH does not modify your normal `~/.pi/agent/settings.json` for this, and it does not delete auth or model definitions.

For example, you can add an extra hidden pattern of your own and explicitly unhide one model that TLH normally hides by default:

```json
{
  "tlh": {
    "modelVisibility": {
      "hidden": ["anthropic/claude-sonnet-4-*"],
      "visible": ["anthropic/claude-opus-4-6"]
    }
  }
}
```

- `tlh.modelVisibility.disabled: true` turns the filter off entirely.
- `tlh.modelVisibility.hidden` adds your own hidden exact matches or glob patterns. You can use either bare model IDs such as `claude-opus-4-*` or canonical `provider/model` entries such as `anthropic/claude-opus-4-*`.
- `tlh.modelVisibility.visible` lets specific models stay visible even if they match a bundled default or one of your hidden patterns.
- `tlh.modelVisibility.unhide` is accepted as an alias for `visible`.

Hidden models are removed from browsing/listing surfaces such as the `/model` picker and `tlh --list-models`, but the underlying auth/model definitions remain intact and exact direct selection by canonical `provider/model` still works. For example, a hidden model can still be selected directly with `/model anthropic/claude-opus-4-6`.

To undo the behavior, either set `tlh.modelVisibility.disabled` to `true`, remove your own `hidden` overrides from `~/.the-last-harness/agent/settings.json`, or add the models you want back under `tlh.modelVisibility.visible`/`unhide`.
