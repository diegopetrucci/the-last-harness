# TLH model defaults

## Model and thinking defaults

TLH loads bundled model/effort defaults from each agent's `tlhModelDefaults` frontmatter block. Each list item names one exact provider, optionally lists provider-local model IDs, and may set an `effort` level. For example:

```yaml
tlhModelDefaults:
  - provider: anthropic
    models: [<model-id>]
    effort: <level>
  - provider: openai-codex
    models: [<model-id>]
    effort: <level>
  - provider: xai
    models: [<model-id>]
    effort: <level>
  - provider: openrouter
    effort: <level>
```

The `models` values are local IDs for the provider named by the same entry; model IDs may contain vendor path segments (for example, `openrouter/anthropic/...`). Anthropic, OpenAI Codex, and xAI (`xai`) are first-class direct-provider defaults. TLH tries declared models in list order when selecting an available direct-provider model. OpenRouter entries intentionally omit `models`: the runtime follows the active OpenRouter session model and applies the entry's effort. A present `tlhModelDefaults` block is authoritative, including when it is empty.

Per-role bundled model and effort defaults are declared in the `tlhModelDefaults` frontmatter of [`agents/primary/*.md`](../agents/primary) and [`agents/subagents/*.md`](../agents/subagents); those files are the source of truth, so they are not repeated here. To preserve the former generic primary `model:` precedence, the loader records the first declared model in each new-format primary as its internal preferred model; Rush's `preferCurrentOpenaiModel` still opts into current OpenAI precedence. Persistent model choices for active primaries are respected and stored per primary under `tlh.primaryAgent.modelOverrides.<primary>`; reset the current primary's override with `/switch-primary-agent model reset`. Role-specific notes (such as the `test-runner`'s MCP behavior) live in [subagents.md](subagents.md#final-validation-test-runner).

For compatibility with older installed or user-edited agent files, TLH falls back only when `tlhModelDefaults` is absent: legacy provider model fields are normalized at load time, while generic `model:` and `thinking:` fields retain their documented legacy behavior. Bundled agent files use only `tlhModelDefaults`; generic and flattened provider-specific declarations are not bundled defaults. Legacy fields are ignored when a provider-default block is present.

Model picker keys are documented in [commands.md](commands.md#model-picker).

Disabled mode is not a model role: it applies no primary model/effort default or override. See [disabled primary-agent mode](commands.md#disabled-primary-agent-mode).

### Direct provider sessions and authentication

TLH treats xAI as a first-class direct provider and uses provider ID `xai` for its bundled Grok defaults. For xAI subscription access, use `/login xai` when available; Pi owns direct-provider authentication and transport, and this is the recommended subscription path over `XAI_API_KEY`.

OpenAI defaults intentionally use `openai-codex` for the Codex subscription provider. Anthropic and xAI subscription and API-key authentication share the provider IDs `anthropic` and `xai`, so Pi's stored `/login` credential takes precedence over the corresponding environment key (`ANTHROPIC_API_KEY` or `XAI_API_KEY`). TLH cannot select among multiple simultaneous credentials, does not implement new auth storage, and does not mutate user credentials.

Pi owns prompt-cache warming (`off`, `streaming`, or `idle`; warm refreshes are real provider requests whose usage is reported separately from assistant turns). TLH's default value, notices, and the shared parent/child profile scope are documented in [the installer reference](install.md#pi-native-prompt-cache-warming). Pi also preserves the prompt cache when changing the thinking level mid-session for OpenAI GPT-6 models authenticated with an API key; that cache benefit does not apply to the OpenAI Codex subscription provider.

### OpenRouter sessions

The upstream Pi runtime provides OpenRouter authentication and transport: use `/login openrouter` for OAuth or set `OPENROUTER_API_KEY`. TLH does not implement that provider's transport or authentication. All non-opposite TLH primaries and subagents follow the active OpenRouter session model by default. For an active primary, a persisted `tlh.primaryAgent.modelOverrides.<primary>` entry takes precedence and is reapplied at the next session or primary-mode boundary; otherwise the primary follows the current session model. Their effort comes from each role's effort-only `openrouter` entry; generic or legacy thinking values do not leak onto this path. The defaults layer forwards every recognized stored or project effort suffix unchanged, whether or not the registry advertises that level; Pi validates the resulting model argument and reports an unsupported argument as a non-transient failure. Only syntactically invalid effort values are omitted with a warning.

For project custom embedded agents launched by a TLH primary, an omitted caller model likewise follows the live OpenRouter session model—even when the root file declares a different `model`; an explicitly supplied caller model still wins. On other providers, the root file's model remains effective unless the caller overrides it. For `code-reviewer`, `oracle`, and `contrarian` (`preferOppositeProvider`), TLH uses a three-family direct-provider order. OpenRouter opposite-provider routing treats plain OpenAI API (`openai`) and OpenAI Codex (`openai-codex`) as the same OpenAI family. For known `openrouter/anthropic/*` models it tries the OpenAI family, then xAI, then the Anthropic family; for known `openrouter/openai/*` models it tries Anthropic, then xAI, then the OpenAI family; for known `openrouter/x-ai/*` models it tries Anthropic, then the OpenAI family, then xAI. For unknown vendors it tries the OpenAI family, then Anthropic, then xAI, but independence is unknown. A same-family fallback reports degraded review independence. The active OpenRouter session model remains the retry fallback, also with a reduced-independence notice. For bundled review roles, stored or explicitly supplied model and effort overrides retain precedence over those review-role defaults; stored profile/default overrides do not modify project custom embedded agents.

OpenRouter has no packaged model frontmatter catalog beyond effort-only entries. Consequently, `/reconcile` cannot dynamically drift-check the OpenRouter session model or dynamically selected opposite-provider candidates; this is an accepted limitation. OpenRouter credit usage is not a subscription-window footer provider.

## Model selection

Picker keys (Enter, Ctrl+S, Esc), typed `/model`, launch flags, and undo steps are in [commands.md](commands.md#model-picker).

The native picker is the only model picker. Its session-only Enter path, persisted save-key path (Ctrl+S by default, `app.models.save`), same-model save-key reselection, model-scope activation, refresh behavior, and configurable Enter/save-key/cancel-key hints rendered from keybinding config at runtime are provided by the pinned Pi runtime (version in `config/pi-runtime/package.json`). TLH wraps only the public `AgentSession.setModel` method in the isolated runtime, carrying `options.persist` through the complete awaited `model_select` dispatch. It does not patch `ModelSelectorComponent`, `SettingsManager`'s model/default persistence methods, or private storage paths; `/thinking` and `/effort` use the public `ThinkingSelectorComponent` with a separate guarded default write. A same-model `persist: true` call emits no `model_select` event, so after the original `setModel` succeeds TLH invokes the current owner-scoped callback through the same primary-override and first-baseline logic. Failed calls and `persist: false` calls never invoke that callback.

Pi does not expose provenance saying whether `persist: true` came from Ctrl+S, provider authentication, or another programmatic path. TLH therefore treats a successful persisted `setModel` call, including provider-auth persistence, as durable compatibility input. Programmatic session model applications that do not request persistence remain session-only under Pi's default behavior. TLH's own primary application, primary-mode changes, cancellation paths, and disabled mode never turn their model application into a user override.

### Staying in sync when TLH updates its defaults

When TLH ships an update that changes the packaged model or effort default for a role you have overridden, it shows a one-line startup notice pointing at `/reconcile`, where you can keep or reset the override. Acknowledgments are per-provider, and OpenRouter sessions cannot be drift-checked (see above). The notice trigger, Keep/Reset semantics, packaged-default semantics, and undo steps are in [commands.md](commands.md#reconcile).

### Review independence for code-reviewer, oracle, and contrarian

For review independence, `code-reviewer`, `oracle`, and `contrarian` (`preferOppositeProvider`) intentionally prefer an available opposite provider. Direct Anthropic and xAI sessions cross-route to the OpenAI Codex provider only, never plain OpenAI API; direct Anthropic sessions try OpenAI Codex, then xAI, while direct xAI sessions try Anthropic, then OpenAI Codex. Direct OpenAI/OpenAI-Codex sessions try Anthropic, then xAI. OpenRouter sessions use the vendor-aware three-family selection described in [OpenRouter sessions](#openrouter-sessions). When TLH injects an opposite-provider model, it also supplies a current/session-provider fallback for retryable model failures; if that fallback is used, the subagent output includes a notice that review independence is reduced. If no direct candidate is available, TLH does not force these roles onto an unavailable default. All other bundled subagents follow the active primary session provider when TLH injects model defaults.

## Minor-agent model and effort overrides

`/subagent-settings` persists per-role model or effort overrides in the isolated profile; precedence, provider-independence confirmation, headless write refusal, and undo are in [commands.md](commands.md#subagent-settings).

## Project model/effort defaults

TLH no longer loads project-local `.tlh/defaults.json`. Packaged role defaults and persisted isolated-profile overrides remain supported; configure bundled minor-agent overrides with `/subagent-settings` and primary-agent overrides through the isolated profile settings. Project custom embedded agents are self-contained Markdown definitions and are re-read from their exact trusted Git-root path for each operation.

To undo a persisted override, use the matching `/subagent-settings reset` command or the primary-agent settings control. Existing `.tlh/defaults.json` files are left untouched and are ignored.

## Thinking level selection

`/thinking` is Pi's native command and `/effort` is TLH's alias for the same picker. Keys, session-only versus saved behavior, and retention rules are in [commands.md](commands.md#thinking-native-and-effort-tlh-alias).

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

Hidden models are removed from browsing/listing surfaces such as the `/model` picker and `tlh --list-models`, but the underlying auth/model definitions remain intact and exact direct selection by canonical `provider/model` still works. For example, a hidden model can still be selected directly with `/model anthropic/claude-opus-4-6`. Visibility is not a subagent execution restriction: an authenticated hidden model remains eligible for TLH subagent dispatch, async resume, and runtime fallback resolution; models without valid credentials remain unavailable.

To undo the behavior, either set `tlh.modelVisibility.disabled` to `true`, remove your own `hidden` overrides from `~/.the-last-harness/agent/settings.json`, or add the models you want back under `tlh.modelVisibility.visible`/`unhide`.
