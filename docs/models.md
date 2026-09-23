# TLH model defaults

## Model and thinking defaults

TLH loads bundled model/effort defaults from each agent's `tlhModelDefaults` frontmatter block. Each list item names one exact provider, optionally lists provider-local model IDs, and may set an `effort` level. For example:

```yaml
tlhModelDefaults:
  - provider: anthropic
    models: [claude-opus-5]
    effort: high
  - provider: openai-codex
    models: [gpt-5.6-sol]
    effort: high
  - provider: xai
    models: [grok-4.6]
    effort: high
  - provider: openrouter
    effort: high
```

The `models` values are local IDs for the provider named by the same entry; model IDs may contain vendor path segments (for example, `openrouter/anthropic/...`). Anthropic, OpenAI Codex, and xAI (`xai`) are first-class direct-provider defaults. TLH tries declared models in list order when selecting an available direct-provider model. OpenRouter entries intentionally omit `models`: the runtime follows the active OpenRouter session model and applies the entry's effort. A present `tlhModelDefaults` block is authoritative, including when it is empty.

The bundled primaries use Anthropic Claude Opus 5 at high effort, OpenAI Codex GPT-5.6 Sol at high effort, and xAI Grok 4.6 at high effort, except Rush, which uses Anthropic Claude Sonnet 4.6 at low effort, OpenAI Codex GPT-5.6 Luna at medium effort, and xAI Grok 4.6 at low effort. For primaries, their OpenRouter effort entries mirror the Anthropic effort. To preserve the former generic primary `model:` precedence, the loader records the first declared model in each new-format primary as its internal preferred model; Rush's `preferCurrentOpenaiModel` still opts into current OpenAI precedence. Persistent model choices for active primaries are respected and stored per primary under `tlh.primaryAgent.modelOverrides.<primary>`; reset the current primary's override with `/switch-primary-agent model reset`.

The bundled `developer` subagent follows the active primary session provider with Anthropic Claude Sonnet 4.6 at medium effort, OpenAI Codex GPT-5.6 Luna at max effort, or xAI Grok 4.6 at medium effort. The execution-only `test-runner` uses OpenAI Codex GPT-5.6 Luna at low effort, Anthropic Claude Haiku 4.5 at low effort, xAI Grok 4.3 at low effort, and low effort on OpenRouter for cheap final validation; its assigned generic MCP calls may invoke configured tools that change server-side state. Other bundled subagents — `web-scout`, `repo-scout`, `librarian`, and `diff-summarizer` — use OpenAI Codex GPT-5.6 Luna at medium effort, Anthropic Claude Haiku 4.5 at high effort, and xAI Grok 4.3 at medium effort. Review roles use OpenAI Codex GPT-5.6 Sol at high effort for `code-reviewer` and `contrarian`, while `oracle` uses OpenAI Codex GPT-6 Astra at medium effort; their OpenRouter effort defaults remain high. `code-reviewer` uses Anthropic Claude Opus 5 at max effort and xAI Grok 4.6 at high effort, while `oracle` and `contrarian` use Anthropic Claude Fable 5.1 at medium effort and xAI Grok 4.6 at xhigh effort.

For compatibility with older installed or user-edited agent files, TLH falls back only when `tlhModelDefaults` is absent: legacy provider model fields are normalized at load time, while generic `model:` and `thinking:` fields retain their documented legacy behavior. Bundled agent files use only `tlhModelDefaults`; generic and flattened provider-specific declarations are not bundled defaults. Legacy fields are ignored when a provider-default block is present.

The native model picker is documented below.

Disabled mode is not a model role: it applies no primary model/effort default or override, leaves the current session's model and effort unchanged, and leaves explicit `/model`, `/thinking`, and `/effort` controls available. Bundled minor-agent dispatches still receive provider-aware defaults.

### Direct provider sessions and authentication

TLH treats xAI as a first-class direct provider and uses provider ID `xai` for its bundled Grok defaults. For xAI subscription access, use `/login xai` when available; Pi owns direct-provider authentication and transport, and this is the recommended subscription path over `XAI_API_KEY`.

OpenAI defaults intentionally use `openai-codex` for the Codex subscription provider. Anthropic and xAI subscription and API-key authentication share the provider IDs `anthropic` and `xai`, so Pi's stored `/login` credential takes precedence over the corresponding environment key (`ANTHROPIC_API_KEY` or `XAI_API_KEY`). TLH cannot select among multiple simultaneous credentials, does not implement new auth storage, and does not mutate user credentials.

### OpenRouter sessions

The upstream Pi runtime provides OpenRouter authentication and transport: use `/login openrouter` for OAuth or set `OPENROUTER_API_KEY`. TLH does not implement that provider's transport or authentication. All non-opposite TLH primaries and subagents follow the active OpenRouter session model by default. For an active primary, a persisted `tlh.primaryAgent.modelOverrides.<primary>` entry takes precedence and is reapplied at the next session or primary-mode boundary; otherwise the primary follows the current session model. Their effort comes from each role's effort-only `openrouter` entry; generic or legacy thinking values do not leak onto this path. The defaults layer forwards every recognized stored or project effort suffix unchanged, whether or not the registry advertises that level; Pi validates the resulting model argument and reports an unsupported argument as a non-transient failure. Only syntactically invalid effort values are omitted with a warning.

For project custom embedded agents launched by a TLH primary, an omitted caller model likewise follows the live OpenRouter session model—even when the root file declares a different `model`; an explicitly supplied caller model still wins. On other providers, the root file's model remains effective unless the caller overrides it. For `code-reviewer`, `oracle`, and `contrarian` (`preferOppositeProvider`), TLH uses a three-family direct-provider order. OpenRouter opposite-provider routing treats plain OpenAI API (`openai`) and OpenAI Codex (`openai-codex`) as the same OpenAI family. For known `openrouter/anthropic/*` models it tries the OpenAI family, then xAI, then the Anthropic family; for known `openrouter/openai/*` models it tries Anthropic, then xAI, then the OpenAI family; for known `openrouter/x-ai/*` models it tries Anthropic, then the OpenAI family, then xAI. For unknown vendors it tries the OpenAI family, then Anthropic, then xAI, but independence is unknown. A same-family fallback reports degraded review independence. The active OpenRouter session model remains the retry fallback, also with a reduced-independence notice. For bundled review roles, stored or explicitly supplied model and effort overrides retain precedence over those review-role defaults; stored profile/default overrides do not modify project custom embedded agents.

OpenRouter has no packaged model frontmatter catalog beyond effort-only entries. Consequently, `/reconcile` cannot dynamically drift-check the OpenRouter session model or dynamically selected opposite-provider candidates; this is an accepted limitation. OpenRouter credit usage is not a subscription-window footer provider.

## Model selection

In the interactive TUI, `/model` without an exact argument and the default `Ctrl+L` shortcut open Pi's native model picker. TLH does not add a second model-scope prompt. The picker visibly offers these native actions:

- **Enter** changes the active model for this session only. It does not write the isolated profile default or a TLH primary override. For an active primary, TLH retains the session choice across turns and session-tree reapplication, then clears it at a new session or explicit primary-agent mode change.
- **Ctrl+S** (default `app.models.save` keybinding, configurable since 0.85.1) selects the model and saves it as the isolated-profile default for future sessions. For an active, overrideable primary, TLH creates or updates `tlh.primaryAgent.modelOverrides.<primary>` when the model differs from its packaged default, or clears that override when the packaged default is selected. OpenRouter selections always create or update the active primary override because OpenRouter has no packaged primary model.
- **Esc/Ctrl+C** (default `tui.select.cancel` keybinding, configurable since 0.85.1) cancels the picker without changing the active model or writing settings.

The native picker is the only model picker. Its session-only Enter path, persisted save-key path (Ctrl+S by default, `app.models.save`), same-model save-key reselection, model-scope activation, refresh behavior, and configurable Enter/save-key/cancel-key hints rendered from keybinding config at runtime are provided by the pinned Pi 0.85.1 runtime. TLH wraps only the public `AgentSession.setModel` method in the isolated runtime, carrying `options.persist` through the complete awaited `model_select` dispatch. It does not patch `ModelSelectorComponent`, `SettingsManager`'s model/default persistence methods, or private storage paths; `/thinking` and `/effort` use the public `ThinkingSelectorComponent` with a separate guarded default write. A same-model `persist: true` call emits no `model_select` event, so after the original `setModel` succeeds TLH invokes the current owner-scoped callback through the same primary-override and first-baseline logic. Failed calls and `persist: false` calls never invoke that callback.

Pi does not expose provenance saying whether `persist: true` came from Ctrl+S, provider authentication, or another programmatic path. TLH therefore treats a successful persisted `setModel` call, including provider-auth persistence, as durable compatibility input. Typed `/model <exact-name>` and programmatic session model applications that do not request persistence remain session-only under Pi's default behavior. Model cycling does not create or edit a TLH per-primary override. TLH's own primary application, primary-mode changes, cancellation paths, and disabled mode never turn their model application into a user override. To undo a persistent choice, choose the desired model through the native picker and press Ctrl+S. For an active primary, `/switch-primary-agent model reset` clears its persisted override and attempts to reapply its packaged default, subject to `tlh.primaryAgent.applyModel`.

### Staying in sync when TLH updates its defaults

When TLH ships an update that changes the packaged model or effort default for a role you have overridden, it shows a one-line startup notice: `TLH default model/effort changed for <role> — run /reconcile to review`. The notice is non-blocking and reappears each launch until you act.

Run `/reconcile` to review and resolve the drift:

- **Keep** — acknowledges the new TLH default and preserves your override unchanged. Non-destructive: your setting is untouched.
- **Reset** — clears your override so the role falls back to TLH packaged defaults. For primary agents, the packaged default is also applied to the active session immediately (subject to your `tlh.primaryAgent.applyModel` setting). Undoable: restore the value through the native `/model` picker and press Ctrl+S; for subagents, use `/subagent-settings set <role> ...`. Settings writes always create a `settings.json.bak-*` backup shown in the notification.

The **only trigger** is TLH changing a packaged default for a role you have overridden. There is no periodic or scheduled reminder.

Acknowledgments are per-provider. A Keep or Reset under one provider does not suppress the notice if you later switch providers and that provider's packaged default has since changed.

When the session provider is unknown, TLH defers all comparison — no notice appears and Keep is unavailable until a provider is active. Overrides that pre-date this release are silently backfilled on your first startup with a known provider; the notice then fires on the next packaged-default change after that point, not for any changes that occurred before the backfill.

The reported value is the canonical packaged default for the active provider, resolved from TLH's own bundled catalog. It may name a model your current environment cannot reach, and it may differ from the model Reset produces in a live session (for example, roles that prefer an opposite-provider model will show a same-provider fallback here). That does not block the decision; Keep and Reset work regardless.

Outside the TUI, `/reconcile` prints a read-only drift summary. See [`commands.md § /reconcile`](commands.md#reconcile) for the full grammar, trigger model, and undo steps.

### Review independence for code-reviewer, oracle, and contrarian

For review independence, `code-reviewer`, `oracle`, and `contrarian` (`preferOppositeProvider`) intentionally prefer an available opposite provider. Direct Anthropic and xAI sessions cross-route to the OpenAI Codex provider only, never plain OpenAI API; direct Anthropic sessions try OpenAI Codex, then xAI, while direct xAI sessions try Anthropic, then OpenAI Codex. Direct OpenAI/OpenAI-Codex sessions try Anthropic, then xAI. OpenRouter sessions use the vendor-aware three-family selection described in [OpenRouter sessions](#openrouter-sessions). When TLH injects an opposite-provider model, it also supplies a current/session-provider fallback for retryable model failures; if that fallback is used, the subagent output includes a notice that review independence is reduced. If no direct candidate is available, TLH does not force these roles onto an unavailable default. All other bundled subagents follow the active primary session provider when TLH injects model defaults.

## Minor-agent model and effort overrides

Use `/subagent-settings` to persist model or effort choices for the bundled TLH minor-agent roles: `code-reviewer`, `contrarian`, `developer`, `test-runner`, `diff-summarizer`, `librarian`, `oracle`, `repo-scout`, and `web-scout`.

- `/subagent-settings` opens a picker in the interactive TLH TUI; outside the TUI it reports status.
- `/subagent-settings status [role]` shows all roles or one role.
- `/subagent-settings set <role> [model <provider/id>] [effort <off|minimal|low|medium|high|xhigh|max>]` sets one or both fields; the `model` and `effort` pairs may be given in either order.
- `/subagent-settings reset <role> [model|effort]` clears one field or both, and `/subagent-settings reset-all` clears the saved model/effort fields for bundled roles only.

Values are stored under `subagents.agentOverrides` in the active isolated profile's `settings.json` (normally `~/.the-last-harness/agent/settings.json`, or the profile selected by `PI_CODING_AGENT_DIR`). A caller-supplied dispatch model takes precedence; otherwise stored role overrides are resolved before bundled provider-aware defaults. A fixed model can reduce provider independence for `code-reviewer`, `oracle`, and `contrarian`, so TLH warns and requires confirmation in UI sessions and refuses those writes in headless mode.

The valid effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The defaults layer handles effort consistently by provenance: explicit-dispatch models, persisted or project saved pins (including pins absent from the registry), and registry-known models all retain a recognized configured effort suffix. Capability metadata may produce a truthful diagnostic, but never filters, neutralizes, or clears a recognized suffix; Pi validates the resulting model argument and a rejection is non-transient. Only syntactically invalid effort values are omitted with a warning. The subagents runtime does not apply a second known-model capability gate. `max` is also a live bundled default where configured, not a hypothetical value.

When existing settings content is replaced, TLH creates a `settings.json.bak-*` backup and shows its path. To undo a change, use the matching `reset` command, use `reset-all` for bundled roles, or restore the desired `settings.json.bak-*` backup over the active profile's `settings.json`.

See [`commands.md`](commands.md) for the complete grammar, precedence details, warnings, and recovery steps.

## Project model/effort defaults

TLH no longer loads project-local `.tlh/defaults.json`. Packaged role defaults and persisted isolated-profile overrides remain supported; configure bundled minor-agent overrides with `/subagent-settings` and primary-agent overrides through the isolated profile settings. Project custom embedded agents are self-contained Markdown definitions and are re-read from their exact trusted Git-root path for each operation.

To undo a persisted override, use the matching `/subagent-settings reset` command or the primary-agent settings control. Existing `.tlh/defaults.json` files are left untouched and are ignored.

## Thinking level selection

`/thinking` is Pi's built-in command and remains native; TLH does not register, route, or intercept it. `/effort` is TLH's behavioral alias and uses Pi 0.85.1's exported `ThinkingSelectorComponent` with the active model's native supported levels.

In the interactive TUI, both commands without a level open the same native picker and visibly explain:

- **Enter** applies the selected level to this session only.
- **Ctrl+S** (default `app.thinking.save` keybinding, configurable since 0.85.1) applies the level and saves the future-session default. Pi owns this write for `/thinking`; `/effort` uses TLH's guarded isolated-profile settings write. Changed existing settings receive a `settings.json.bak-*` backup, unknown fields are preserved, and a failed `/effort` save falls back to the session-only result with a warning.
- **Esc/Ctrl+C** (default `tui.select.cancel` keybinding, configurable since 0.85.1) cancels without changing the active level or persistent default.

Typed `/thinking <level>` and `/effort <level>` values, plus native thinking cycling/shortcuts, are session-only. The picker and typed alias use levels supported by the active model. For an enabled primary, TLH retains explicit choices through later turns and session-tree reapplication while that primary remains selected; a model switch clamps retained intent to a supported level. A new session or explicit primary-agent mode change clears session-only intent, then applies the persisted default when present or the provider-aware packaged default otherwise.

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
