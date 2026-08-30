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

The bundled primaries use Anthropic Claude Opus 5 with high effort and OpenAI Codex GPT-5.6 Sol with high effort, except Rush, which uses Anthropic Claude Sonnet 4.6 with low effort and OpenAI Codex GPT-5.6 Luna with medium effort. Their OpenRouter effort entries mirror the Anthropic effort. To preserve the former generic primary `model:` precedence, the loader records the first declared model in each new-format primary as its internal preferred model; Rush's `preferCurrentOpenaiModel` still opts into current OpenAI precedence. All four bundled primaries remain unlocked: Architect retains its medium minimum floor, while Rush, Product, and Bug-hunter accept every level supported by the active model. Persistent model choices for active primaries are respected and stored per primary under `tlh.primaryAgent.modelOverrides.<primary>`; reset the current primary's override with `/switch-primary-agent model reset`. The bundled `developer` subagent follows the active primary session provider with Anthropic Claude Sonnet 4.6 at medium effort or OpenAI Codex GPT-5.6 Luna at max effort. Other bundled subagents — `web-scout`, `repo-scout`, `librarian`, and `diff-summarizer` — use OpenAI Codex GPT-5.6 Luna at medium effort and Anthropic Claude Haiku 4.5 at high effort. Review roles (`code-reviewer`, `oracle`, and `contrarian`) use OpenAI Codex GPT-5.6 Sol and Anthropic Claude Opus 5, both at high effort.

For compatibility with older installed or user-edited agent files, TLH falls back only when `tlhModelDefaults` is absent: legacy provider model fields are normalized at load time, while generic `model:` and `thinking:` fields retain their documented legacy behavior. Bundled agent files use only `tlhModelDefaults`; generic and flattened provider-specific declarations are not bundled defaults. Legacy fields are ignored when a provider-default block is present.

The native model-picker scope is documented below. The runtime retains `lockThinking` support for fixed primary definitions, but none of the bundled primaries is locked. A fixed primary with `lockThinking: true` is an existing precedence exception: its automatic model/thinking application is forced and skips project model/effort entries (and persisted primary model overrides).

Disabled mode is not a model role: it applies no primary model/effort default or override, leaves the current session's model and effort unchanged, and does not enforce the architect's minimum effort floor. Explicit `/model`, `/thinking`, and `/effort` controls remain available, and bundled minor-agent dispatches still receive provider-aware defaults.

### OpenRouter sessions

The upstream Pi runtime provides OpenRouter authentication and transport: use `/login openrouter` for OAuth or set `OPENROUTER_API_KEY`. TLH does not implement that provider's transport or authentication. All non-opposite TLH primaries and subagents follow the active OpenRouter session model by default. For an active primary, a persisted `tlh.primaryAgent.modelOverrides.<primary>` entry takes precedence and is reapplied at the next session or primary-mode boundary; otherwise the primary follows the current session model. Their effort comes from each role's effort-only `openrouter` entry; generic or legacy thinking values do not leak onto this path. Primary `lockThinking` and `minThinking` rules apply through that OpenRouter effort. Unknown versus explicitly non-reasoning capability checks apply to stored minor-agent effort overrides and generated fallback handling, not pure bundled or primary defaults.

For project custom embedded agents launched by a TLH primary, an omitted caller model likewise follows the live OpenRouter session model—even when the root file declares a different `model`; an explicitly supplied caller model still wins. On other providers, the root file's model remains effective unless the caller overrides it. For `code-reviewer`, `oracle`, and `contrarian` (`preferOppositeProvider`), TLH first looks for an available direct OpenAI/Codex or Anthropic candidate (both the Codex subscription provider and plain OpenAI API candidates qualify). For known `openrouter/anthropic/*` models it tries the opposite OpenAI/Codex family first, then an available Anthropic-family direct candidate; for known `openrouter/openai/*` models it tries Anthropic first, then an available OpenAI/Codex-family direct candidate. A same-family fallback reports degraded review independence. For unknown vendors it tries the OpenAI/Codex family first, but independence is unknown. The active OpenRouter session model remains the retry fallback, also with a reduced-independence notice. For bundled review roles, stored or explicitly supplied model and effort overrides retain precedence over those review-role defaults; stored profile/default overrides do not modify project custom embedded agents.

OpenRouter has no packaged model frontmatter catalog beyond effort-only entries. Consequently, `/reconcile` cannot dynamically drift-check the OpenRouter session model or dynamically selected opposite-provider candidates; this is an accepted limitation. OpenRouter credit usage is not a subscription-window footer provider.

## Model selection scope

In the interactive TUI, `/model` **without an exact argument** and the default `Ctrl+L` shortcut open the native model picker. After that picker changes the active model, TLH opens a second picker titled `Model selection scope` with these exact labels, in this order:

1. `This session only — default`
2. `All sessions`

Choosing the model that is already active is a native reselection: it emits no `model_select` event, so TLH does not open the scope picker. The upstream global-default write is otherwise preserved. If that active model was previously marked `This session only — default`, TLH drops the reconfirmation write to preserve that session-only scope.

The two choices mean:

- **`This session only — default`** changes the current session but does not persist the model/provider or thinking-level defaults and does not write a per-primary model override. For an active primary, the choice is retained across turns and session-tree reapplication in this session. The choice is cleared at a new session start (including the runtime boundary caused by `/reload`) or an explicit primary-agent mode change. It does not affect future/default launches.
- **`All sessions`** keeps the upstream persistent model/provider (and any model-switch thinking-level) default in the isolated TLH profile. For an active primary, TLH stores the selected model at `tlh.primaryAgent.modelOverrides.<primary>` when it differs from that primary's bundled default; selecting the bundled default clears that primary's override. Because OpenRouter has no packaged primary model, an OpenRouter selection always creates or updates the active primary's override, even though that primary follows the current OpenRouter session model by default. The override is per primary, so another primary follows its own default or override. Stored primary overrides are reapplied when that primary is applied at a new session or mode boundary; they do not follow whichever OpenRouter model happens to be current in the new session. With no active primary, the profile default is the setting used by future launches.

`All sessions` controls future/default launches; its persisted `defaultThinkingLevel` is also honored by TLH for active primaries at new-session and explicit primary-mode boundaries, subject to model capabilities and Architect's floor. It does not switch or rewrite other existing/running sessions or their session files. The current session has already switched to the chosen model when this scope picker appears. On direct Anthropic/OpenAI-Codex paths, an active primary keeps the selected model for this session and `All sessions` creates or clears that primary's model override according to whether the selection differs from its packaged default. On the OpenRouter path, the active primary keeps the selected model for this session and `All sessions` always creates or updates that primary's override because OpenRouter has no packaged primary model; that stored override is reapplied rather than replaced by the current session model at a later boundary.

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

Valid primary agent names: `architect`, `rush`, `product`, `bug-hunter`. Valid subagent role names: `code-reviewer`, `contrarian`, `developer`, `diff-summarizer`, `librarian`, `oracle`, `repo-scout`, `web-scout`.

Unknown role names, unknown keys within an entry, invalid model/effort values, and entries missing both fields all produce a warning and skip that entry; the rest of the file still applies. Malformed JSON warns and applies nothing. Loaded validation warnings are surfaced with bounded, deduplicated notifications (plus one overflow summary when needed, capped at 1,000,000 omitted issues so the count remains numerically safe). The file is read with fail-closed safety: symlinks anywhere on the `.tlh` path, non-regular files, and files exceeding 64 KiB (65,536 UTF-8 bytes) are rejected entirely.

### Trust

Project custom agents and project defaults use separate trust planes:

- A persisted canonical `/trust` `saved-positive` decision for the validated Git worktree root enables both the exact `.tlh/agents/custom/<UPPERCASE-SLUG>.md` custom-agent contract and `.tlh/defaults.json`.
- An upstream positive project-trust signal, `defaultProjectTrust: always`, or a session approval may enable `.tlh/defaults.json` only. None of those configuration-trust sources authorizes a project custom agent; custom-agent execution always requires persisted positive `/trust`.
- The defaults prompt title is **"Trust project-local TLH defaults?"**. Its message scopes the decision to repository-owned model/effort defaults for the current session and states that project custom agents require persisted `/trust`; it is never a custom-agent authorization prompt.

A denial, unavailable confirmation, or failed configuration-trust check applies no project defaults and does so non-fatally.

### Precedence

Model and effort resolve independently per role. For each field, the order is (highest wins):

1. **Explicit in-session user action** — a session-only model choice (`This session only — default` from the model picker) or a session thinking override; for subagents, an explicitly user-directed per-dispatch model.
2. **Project defaults** — `.tlh/defaults.json` (this section).
3. **Persisted user overrides** — `tlh.primaryAgent.modelOverrides.<primary>` for primaries, `subagents.agentOverrides.<role>` for subagents.
4. **Bundled `tlhModelDefaults` frontmatter**.

Because fields are independent, a session-only model pin does not suppress a project effort default, and vice versa. For primary agents, the effort precedence is literally `session ?? project ?? durable ?? bundled`.

Project defaults are applied at runtime only and are never written into the user's persisted settings. They apply only to the packaged primary agents and bundled subagent roles listed above; they do not apply to project custom agents. Project custom agents execute the exact captured frontmatter/configuration from their trusted snapshot and ignore `.tlh/defaults.json`, profile/project settings, and `subagents.agentOverrides` (apart from explicit dispatch controls and the documented OpenRouter behavior in [OpenRouter sessions](#openrouter-sessions)).

The informational notice `TLH applied project defaults for <role>: model <x>, effort <y>` is primary-agent-only and appears at most once per primary per session. It lists only project fields that win precedence and become effective; an effort value is shown after any model-capability or primary-floor clamping. Subagent defaults apply silently at dispatch, while unavailable project models still produce warnings.

If a project model is not available in the current registry, TLH warns once and falls through to layer 3/4 for that field; the effort field is still applied independently.

### Opposite-provider subagents and project defaults

`code-reviewer`, `oracle`, and `contrarian` derive their provider dynamically from the active session model (see [Review independence](#review-independence-for-code-reviewer-oracle-and-contrarian)). Project defaults interact with this in two ways:

- **Primary project model default**: changes the active session model, so opposite-role subagents pick up the new provider automatically.
- **Subagent effort-only entry** (`{ "effort": "..." }` with no `model` field): dynamic opposite-provider selection is preserved; only the effort level is overridden.
- **Subagent model pin** (`{ "model": "..." }`): bypasses dynamic opposite-provider selection for that role, the same way a persisted `/subagent-settings` model pin does.

**Recommend effort-only entries for `code-reviewer`, `oracle`, and `contrarian`** when you want to keep opposite-provider behavior.

A project model pin also overrides a persisted `model: false` (session-inherit) setting, since `model: false` is a persisted value for the model field; an effort-only project entry leaves `model: false` intact. If the project model is unavailable, TLH falls back to the persisted value (including `model: false`).

### Undo

Delete `.tlh/defaults.json` or remove the specific entry. To override a project model for the active session, choose the desired model through the native picker and select `This session only — default`; that session-only choice is layer 1. Choosing `All sessions` persists the model as layer 3, but an existing project model remains higher precedence and can re-override it at the next `before_agent_start` or `session_tree` boundary while that project entry exists. Explicit session thinking/effort choices remain layer 1 and continue to win over project effort.

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
