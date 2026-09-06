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
  - provider: openrouter
    effort: high
```

The `models` values are local IDs for the provider named by the same entry; model IDs may contain vendor path segments (for example, `openrouter/anthropic/...`). TLH tries declared models in list order when selecting an available direct-provider model. OpenRouter entries intentionally omit `models`: the runtime follows the active OpenRouter session model and applies the entry's effort. A present `tlhModelDefaults` block is authoritative, including when it is empty.

The bundled primaries use Anthropic Claude Opus 5 with high effort and OpenAI Codex GPT-5.6 Sol with high effort, except Rush, which uses Anthropic Claude Sonnet 4.6 with low effort and OpenAI Codex GPT-5.6 Luna with medium effort. Their OpenRouter effort entries mirror the Anthropic effort. To preserve the former generic primary `model:` precedence, the loader records the first declared model in each new-format primary as its internal preferred model; Rush's `preferCurrentOpenaiModel` still opts into current OpenAI precedence. Persistent model choices for active primaries are respected and stored per primary under `tlh.primaryAgent.modelOverrides.<primary>`; reset the current primary's override with `/switch-primary-agent model reset`. The bundled `developer` subagent follows the active primary session provider with Anthropic Claude Sonnet 4.6 at medium effort or OpenAI Codex GPT-5.6 Luna at max effort. The command-only `test-runner` uses OpenAI Codex GPT-5.6 Luna at low effort, Anthropic Claude Haiku 4.5 at low effort, and low effort on OpenRouter for cheap final validation. Other bundled subagents — `web-scout`, `repo-scout`, `librarian`, and `diff-summarizer` — use OpenAI Codex GPT-5.6 Luna at medium effort and Anthropic Claude Haiku 4.5 at high effort. Review roles (`code-reviewer`, `oracle`, and `contrarian`) use OpenAI Codex GPT-5.6 Sol and Anthropic Claude Opus 5, both at high effort.

For compatibility with older installed or user-edited agent files, TLH falls back only when `tlhModelDefaults` is absent: legacy provider model fields are normalized at load time, while generic `model:` and `thinking:` fields retain their documented legacy behavior. Bundled agent files use only `tlhModelDefaults`; generic and flattened provider-specific declarations are not bundled defaults. Legacy fields are ignored when a provider-default block is present.

The native model picker is documented below.

Disabled mode is not a model role: it applies no primary model/effort default or override, leaves the current session's model and effort unchanged, and leaves explicit `/model`, `/thinking`, and `/effort` controls available. Bundled minor-agent dispatches still receive provider-aware defaults.

### OpenRouter sessions

The upstream Pi runtime provides OpenRouter authentication and transport: use `/login openrouter` for OAuth or set `OPENROUTER_API_KEY`. TLH does not implement that provider's transport or authentication. All non-opposite TLH primaries and subagents follow the active OpenRouter session model by default. For an active primary, a persisted `tlh.primaryAgent.modelOverrides.<primary>` entry takes precedence and is reapplied at the next session or primary-mode boundary; otherwise the primary follows the current session model. Their effort comes from each role's effort-only `openrouter` entry; generic or legacy thinking values do not leak onto this path. Unknown versus explicitly non-reasoning capability checks apply to stored minor-agent effort overrides and generated fallback handling, not pure bundled or primary defaults.

For project custom embedded agents launched by a TLH primary, an omitted caller model likewise follows the live OpenRouter session model—even when the root file declares a different `model`; an explicitly supplied caller model still wins. On other providers, the root file's model remains effective unless the caller overrides it. For `code-reviewer`, `oracle`, and `contrarian` (`preferOppositeProvider`), TLH first looks for an available direct OpenAI/Codex or Anthropic candidate (both the Codex subscription provider and plain OpenAI API candidates qualify). For known `openrouter/anthropic/*` models it tries the opposite OpenAI/Codex family first, then an available Anthropic-family direct candidate; for known `openrouter/openai/*` models it tries Anthropic first, then an available OpenAI/Codex-family direct candidate. A same-family fallback reports degraded review independence. For unknown vendors it tries the OpenAI/Codex family first, but independence is unknown. The active OpenRouter session model remains the retry fallback, also with a reduced-independence notice. For bundled review roles, stored or explicitly supplied model and effort overrides retain precedence over those review-role defaults; stored profile/default overrides do not modify project custom embedded agents.

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

For review independence, `code-reviewer`, `oracle`, and `contrarian` (`preferOppositeProvider`) intentionally prefer an available opposite provider. Anthropic sessions try to use the OpenAI Codex subscription provider, while OpenAI/OpenAI-Codex sessions try Anthropic. OpenRouter sessions use the vendor-aware direct-provider selection described in [OpenRouter sessions](#openrouter-sessions). When TLH injects an opposite-provider model, it also supplies a current/session-provider fallback for retryable model failures; if that fallback is used, the subagent output includes a notice that review independence is reduced. If no direct candidate is available, TLH does not force these roles onto an unavailable default. All other bundled subagents follow the active primary session provider when TLH injects model defaults.

## Minor-agent model and effort overrides

Use `/subagent-settings` to persist model or effort choices for the bundled TLH minor-agent roles: `code-reviewer`, `contrarian`, `developer`, `test-runner`, `diff-summarizer`, `librarian`, `oracle`, `repo-scout`, and `web-scout`.

- `/subagent-settings` opens a picker in the interactive TLH TUI; outside the TUI it reports status.
- `/subagent-settings status [role]` shows all roles or one role.
- `/subagent-settings set <role> [model <provider/id>] [effort <off|minimal|low|medium|high|xhigh|max>]` sets one or both fields; the `model` and `effort` pairs may be given in either order.
- `/subagent-settings reset <role> [model|effort]` clears one field or both, and `/subagent-settings reset-all` clears the saved model/effort fields for bundled roles only.

Values are stored under `subagents.agentOverrides` in the active isolated profile's `settings.json` (normally `~/.the-last-harness/agent/settings.json`, or the profile selected by `PI_CODING_AGENT_DIR`). A caller-supplied dispatch model takes precedence; otherwise stored role overrides are resolved before bundled provider-aware defaults. A fixed model can reduce provider independence for `code-reviewer`, `oracle`, and `contrarian`, so TLH warns and requires confirmation in UI sessions and refuses those writes in headless mode.

The valid effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Stored effort is applied when the resolved model advertises support (`max` requires `thinkingLevelMap` support); if a saved value is no longer supported, TLH warns and neutralizes it with the bundled effort or explicit `off` when possible. If neither is supported, the subagents runtime drops the unsupported value for a known model; unknown or unresolvable models fail open and still receive the suffix. `max` is also a live bundled default where configured, not a hypothetical value.

When existing settings content is replaced, TLH creates a `settings.json.bak-*` backup and shows its path. To undo a change, use the matching `reset` command, use `reset-all` for bundled roles, or restore the desired `settings.json.bak-*` backup over the active profile's `settings.json`.

See [`commands.md`](commands.md) for the complete grammar, precedence details, warnings, and recovery steps.

## Project model/effort defaults

A project can provide model and effort defaults for the active session without requiring every contributor to set personal overrides. Place `.tlh/defaults.json` at the canonical Git worktree root:

```json
{
  "primaryAgents": {
    "architect": { "model": "anthropic/claude-opus-5", "effort": "high" },
    "rush": { "effort": "medium" }
  },
  "subagents": {
    "developer": { "model": "anthropic/claude-sonnet-4-6" },
    "code-reviewer": { "effort": "xhigh" }
  }
}
```

Both `model` and `effort` are optional per entry, but at least one must be present. The `model` value uses the `provider/model-id` vocabulary (for example `anthropic/claude-opus-5` or `openai-codex/gpt-5.6-sol`). The parser requires non-empty text on both sides of the first `/`; additional `/` characters in the model ID and a `:<effort>` suffix are retained. The `effort` value is one of the seven canonical levels — `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` — and is case-sensitive.

Valid primary agent names: `architect`, `rush`, `product`, `bug-hunter`. Valid subagent role names: `code-reviewer`, `contrarian`, `developer`, `test-runner`, `diff-summarizer`, `librarian`, `oracle`, `repo-scout`, `web-scout`.

Unknown role names, unknown keys within an entry, invalid model/effort values, and entries missing both fields all produce a warning and skip that entry; the rest of the file still applies. Malformed JSON warns and applies nothing. Loaded validation warnings are surfaced with bounded, deduplicated notifications (plus one overflow summary when needed, capped at 1,000,000 omitted issues so the count remains numerically safe). The file is read with fail-closed safety: symlinks anywhere on the `.tlh` path, non-regular files, and files exceeding 64 KiB (65,536 UTF-8 bytes) are rejected entirely.

### Trust

Project custom agents and project defaults use separate trust planes:

- A persisted canonical `/trust` `saved-positive` decision for the validated Git worktree root enables both the exact `.tlh/agents/custom/<UPPERCASE-SLUG>.md` custom-agent contract and `.tlh/defaults.json`.
- An upstream positive project-trust signal, `defaultProjectTrust: always`, or a session approval may enable `.tlh/defaults.json` only. None of those configuration-trust sources authorizes a project custom agent; custom-agent execution always requires a persisted positive `/trust` decision.
- The defaults prompt title is **"Trust project-local TLH defaults?"**. Its message scopes the decision to repository-owned model/effort defaults for the current session and states that project custom agents require persisted `/trust`; it is never a custom-agent authorization prompt.

A denial, unavailable confirmation, or failed configuration-trust check applies no project defaults and does so non-fatally.

### Precedence

Model and effort resolve independently per role. For each field, the order is (highest wins):

1. **Explicit in-session user action** — an Enter/session-only model choice or session thinking override; for subagents, an explicitly user-directed per-dispatch model.
2. **Project defaults** — `.tlh/defaults.json` (this section).
3. **Persisted user overrides** — `tlh.primaryAgent.modelOverrides.<primary>` for primaries, `subagents.agentOverrides.<role>` for subagents.
4. **Bundled `tlhModelDefaults` frontmatter**.

Because fields are independent, a session-only model pin does not suppress a project effort default, and vice versa. For primary agents, the effort precedence is literally `session ?? project ?? durable ?? bundled`.

Project defaults are applied at runtime only and are never written into the user's persisted settings. They apply only to the packaged primary agents and bundled subagent roles listed above; they do not apply to project custom agents. Project custom agents execute the exact captured frontmatter/configuration from their trusted snapshot and ignore `.tlh/defaults.json`, profile/project settings, and `subagents.agentOverrides` (apart from explicit dispatch controls and the documented OpenRouter behavior in [OpenRouter sessions](#openrouter-sessions)).

The informational notice `TLH applied project defaults for <role>: model <x>, effort <y>` is primary-agent-only and appears at most once per primary per session. It lists only project fields that win precedence and become effective; an effort value is shown after model-capability clamping. Subagent defaults apply silently at dispatch, while unavailable project models still produce warnings.

If a project model is not available in the current registry, TLH warns once and falls through to layer 3/4 for that field; the effort field is still applied independently.

### Opposite-provider subagents and project defaults

`code-reviewer`, `oracle`, and `contrarian` derive their provider dynamically from the active session model (see [Review independence](#review-independence-for-code-reviewer-oracle-and-contrarian)). Project defaults interact with this in two ways:

- **Primary project model default**: changes the active session model, so opposite-role subagents pick up the new provider automatically.
- **Subagent effort-only entry** (`{ "effort": "..." }` with no `model` field): dynamic opposite-provider selection is preserved; only the effort level is overridden.
- **Subagent model pin** (`{ "model": "..." }`): bypasses dynamic opposite-provider selection for that role, the same way a persisted `/subagent-settings` model pin does.

**Recommend effort-only entries for `code-reviewer`, `oracle`, and `contrarian`** when you want to keep opposite-provider behavior.

A project model pin also overrides a persisted `model: false` (session-inherit) setting, since `model: false` is a persisted value for the model field; an effort-only project entry leaves `model: false` intact. If the project model is unavailable, TLH falls back to the persisted value (including `model: false`).

### Undo

Delete `.tlh/defaults.json` or remove the specific entry. To override a project model for the active session, choose the desired model through the native picker and press Ctrl+S to persist it as layer 3; an existing project model remains higher precedence and can re-override it at the next `before_agent_start` or `session_tree` boundary while that project entry exists. An Enter/session-only choice is layer 1. Explicit session thinking/effort choices remain layer 1 and continue to win over project effort.

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
