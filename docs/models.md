# TLH model defaults

## Model and thinking defaults

TLH applies bundled model/thinking defaults per primary agent. Architect, Product, and Bug-hunter use Anthropic Claude Opus 5 with high thinking on Anthropic and OpenAI Codex GPT-5.6 Sol with high thinking on OpenAI Codex. Rush uses Anthropic Claude Sonnet 4.6 with low thinking on Anthropic and OpenAI Codex GPT-5.6 Luna with medium thinking on OpenAI Codex. For active non-locked primaries, persistent model choices are respected and stored per primary under `tlh.primaryAgent.modelOverrides.<primary>`; reset the current primary's override with `/switch-primary-agent model reset`. Locked primaries such as Rush keep their fixed defaults. The native model-picker scope is documented below. The bundled `developer` subagent follows the active primary session provider with Anthropic Claude Sonnet 4.6 at medium thinking or OpenAI Codex GPT-5.6 Luna at max thinking. Other bundled subagents — `web-scout`, `repo-scout`, `librarian`, and `diff-summarizer` — default to OpenAI Codex GPT-5.6 Luna with medium thinking on the OpenAI Codex path and follow the active primary session provider when TLH injects model defaults.

## Model selection scope

In the interactive TUI, `/model` **without an exact argument** and the default `Ctrl+L` shortcut open the native model picker. After that picker changes the active model, TLH opens a second picker titled `Model selection scope` with these exact labels, in this order:

1. `This session only — default`
2. `All sessions`

Choosing the model that is already active is a native reselection: it emits no `model_select` event, so TLH does not open the scope picker. The upstream global-default write is otherwise preserved. If that active model was previously marked `This session only — default`, TLH drops the reconfirmation write to preserve that session-only scope.

The two choices mean:

- **`This session only — default`** changes the current session but does not persist the model/provider or thinking-level defaults and does not write a per-primary model override. For a non-locked primary, the choice is retained across turns and session-tree reapplication in this session; locked primaries reapply their fixed model at the next turn/session boundary. The choice is cleared at a new session start (including the runtime boundary caused by `/reload`) or an explicit primary-agent mode change. It does not affect future/default launches.
- **`All sessions`** keeps the upstream persistent model/provider (and any model-switch thinking-level) default in the isolated TLH profile. For an active non-locked primary, TLH also stores the selected model at `tlh.primaryAgent.modelOverrides.<primary>` when it differs from that primary's bundled default; selecting the bundled default clears that primary's override. The override is per primary, so another primary follows its own default or override. With no active primary, the profile default is the setting used by future launches.

`All sessions` controls future/default launches; it does not switch or rewrite other existing/running sessions or their session files. The current session has already switched to the chosen model when this scope picker appears. Locked primaries (including Rush, Product, and Bug-hunter) retain their forced model behavior: `All sessions` writes the upstream profile default but does not create a primary override, and the locked primary reapplies its fixed model on the next turn/session boundary.

The scope prompt applies only to the native interactive picker. `/model <exact-name>` when it resolves directly, provider-auth or other direct/programmatic model applications, and model cycling retain their persistent upstream path without this prompt; model cycling does not create or edit a TLH per-primary override. A non-exact `/model` search that falls back to the interactive picker is subject to the scope prompt after a model change.

Canceling the scope picker (for example, with `Esc`) discards both the attempted model's default writes and any primary override, restores the previous active model, and leaves persistent settings unchanged. If restoration fails, TLH reports the warning and still does not persist the attempted model.

To undo a persistent choice, choose the desired model again through the native picker and select `All sessions`. For an active non-locked primary, `/switch-primary-agent model reset` clears that primary's persisted override and attempts to reapply its packaged default, subject to `tlh.primaryAgent.applyModel`. When it actually applies a different packaged model, upstream also updates the global profile default to that model. The global default stays unchanged if `applyModel` prevents application or the packaged model is already active; change the global default independently through the native picker as needed. Settings writes may show a `settings.json.bak-*` backup path; inspect a backup before restoring it over the active isolated profile settings file.

### Staying in sync when TLH updates its defaults

When TLH ships an update that changes a bundled model or effort default for a role you have overridden, it shows a startup notice and prompts you to run `/reconcile`. Use `/reconcile` to keep your override as-is (acknowledging the new default) or reset it to restore the TLH packaged default. See [`docs/commands.md § /reconcile`](commands.md#reconcile) for the full grammar, trigger model, and undo steps.

### Review independence for code-reviewer, oracle, and contrarian

For review independence, `code-reviewer` and `oracle` intentionally prefer an available opposite provider. `contrarian` uses that same opposite-provider pattern for adversarial challenge passes. Anthropic sessions try to use the OpenAI Codex subscription provider for these subagents when it is available, while OpenAI/OpenAI-Codex sessions try Anthropic. When TLH injects one of those opposite-provider subagent models, it also supplies a same/current-provider fallback candidate for retryable model failures; if that fallback is used, the subagent output includes a notice that review independence is reduced. If you only have regular OpenAI API access and not the Codex subscription provider, TLH does not force `code-reviewer`, `oracle`, or `contrarian` onto unavailable Codex-only defaults. All other bundled subagents — including `developer`, `web-scout`, `repo-scout`, and `librarian` — follow the active primary session provider when TLH injects model defaults.

## Thinking selection scope

In the interactive TUI, `/thinking` and its `/effort` alias without a level first show the available thinking levels. After a changed selection, TLH opens `Thinking selection scope` with the same approved options as the native model picker: `This session only — default` or `All sessions`. The selected level stays active in the current session either way. The session-only choice leaves `defaultThinkingLevel` in the isolated profile unchanged; All sessions persists the level for future/default sessions. Locked primary-agent levels and the architect's minimum floor are enforced before this scope picker appears.

Canceling the scope picker restores the level that was active before the thinking picker and leaves the persistent default unchanged. Selecting the already-active level still reports it but does not open the scope picker; dismissing the level picker or selecting a rejected/unavailable level also does not open it. Typed `/thinking <level>` and `/effort <level>` arguments, plus thinking cycling/shortcuts, retain their persistent behavior. Pi persists a typed level only when it changes the active level, so to persist a session-only level that is already active, first change to another allowed level and then type the desired level. A session-only level is not a lock: it remains active until a later model or thinking-level operation changes it; a new session also returns to its resolved default.

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
