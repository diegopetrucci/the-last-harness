# TLH model defaults

## Model and thinking defaults

TLH applies bundled model/thinking defaults per primary agent. Architect, Product, and Bug-hunter use Anthropic Claude Opus 5 with high thinking on Anthropic and OpenAI Codex GPT-5.6 Sol with high thinking on OpenAI Codex. Rush uses Anthropic Claude Sonnet 4.6 with low thinking on Anthropic and OpenAI Codex GPT-5.6 Luna with medium thinking on OpenAI Codex. For active non-locked primaries, user `/model` choices are respected and persisted per primary under `tlh.primaryAgent.modelOverrides.<primary>`; reset the current primary's override with `/switch-primary-agent model reset`. Locked primaries such as Rush keep their fixed defaults. The bundled `developer` subagent follows the active primary session provider with Anthropic Claude Sonnet 4.6 at medium thinking or OpenAI Codex GPT-5.6 Luna at max thinking. Other bundled subagents — `web-scout`, `repo-scout`, `librarian`, and `diff-summarizer` — default to OpenAI Codex GPT-5.6 Luna with medium thinking on the OpenAI Codex path and follow the active primary session provider when TLH injects model defaults.

### Review independence for code-reviewer, oracle, and contrarian

For review independence, `code-reviewer` and `oracle` intentionally prefer an available opposite provider. `contrarian` uses that same opposite-provider pattern for adversarial challenge passes. Anthropic sessions try to use the OpenAI Codex subscription provider for these subagents when it is available, while OpenAI/OpenAI-Codex sessions try Anthropic. When TLH injects one of those opposite-provider subagent models, it also supplies a same/current-provider fallback candidate for retryable model failures; if that fallback is used, the subagent output includes a notice that review independence is reduced. If you only have regular OpenAI API access and not the Codex subscription provider, TLH does not force `code-reviewer`, `oracle`, or `contrarian` onto unavailable Codex-only defaults. All other bundled subagents — including `developer`, `web-scout`, `repo-scout`, and `librarian` — follow the active primary session provider when TLH injects model defaults.

## Hidden model defaults in the TLH profile

TLH also ships with a bundled hidden-model filter for a selected set of older Anthropic and OpenAI Codex models. Those bundled defaults are built into TLH itself (currently in `extensions/the-last-harness/model-visibility.ts`); they are not written into `settings.json` as default JSON. Any `tlh.modelVisibility` entries you add under the TLH isolated profile at `~/.the-last-harness/agent/settings.json` are user overrides/additional customization only. TLH does not modify your normal `~/.pi/agent/settings.json` for this, and it does not delete auth or model definitions.

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
