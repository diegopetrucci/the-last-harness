# TLH annotate last message

First-party `/annotate-last-message` support for The Last Harness.

## What it does

`/annotate-last-message` opens a lightweight native annotation window for the latest completed assistant message on the current session branch.

From that window you can leave:

- overall guidance for the whole reply,
- section comments for larger chunks of the message, and
- inline notes tied to individual lines.

When you submit, TLH sends the feedback directly to the agent as a follow-up message. Your existing editor text is left untouched. Blank lines cannot be annotated inline; the inline-note button is not shown for empty lines. It does not auto-apply changes or rewrite the old message in place.

This is TLH's first-party replacement for the older Plannotator-based last-message annotation flow. Use `/annotate-last-message` directly; this workflow does not require Plannotator.

## Appearance

The annotation window follows the **active Pi theme** for **colours** only: markdown token colours (heading, link, code, blockquote, etc.) are harvested from the upstream TUI theme at window-open time and applied as CSS custom properties. Fonts and spacing are static. The static TLH palette (`themes/the-last-harness.json`) is used as a fallback for any token whose theme call is unavailable or returns an unresolvable value.

Message content is rendered with **markdown**: bold, italic, inline code, headings, blockquotes, thematic breaks, and fenced code blocks are displayed as formatted text. Markdown markers (`**`, backticks, `#`) are hidden from the rendered view so they do not clutter the annotation window.

### Rendering rules

- **Inline emphasis**: `*word*` and `_word_` produce italic; `**word**` produces bold. Underscores are **not** treated as emphasis intraword (e.g. `foo_bar_baz` is rendered literally).
- **Block constructs** (headings `#…`, thematic breaks `---`/`***`, blockquotes `>`) are recognised only when preceded by at most 3 spaces of indentation. A line with 4 or more leading spaces is treated as a literal code-like line and rendered as-is.
- **Fenced code blocks**: opening/closing fences (` ``` ` or `~~~`) also require at most 3 spaces of indentation; a 4-space-indented fence-like line is not treated as a fence delimiter.

### UI asset layout

The browser-side code is split across two files inside `web/`:

- `web/md-renderer.js` — pure markdown line parser with no DOM dependency; loaded as an inline `<script>` before the main bundle so it is available synchronously via `globalThis.__tlhMdRenderer`.
- `web/app.js` — main annotation UI; consumes `globalThis.__tlhMdRenderer` for markdown rendering and the injected CSS custom properties for theming.

Neither file is a generated build artifact: both are handwritten browser JS shipped as-is with the TLH package.

## Requirements

- interactive TLH session with editor access
- a completed assistant message with text on the active branch
- local desktop support for opening a native [Glimpse](https://github.com/mariozechner/glimpse) window
- the packaged TLH profile (it does not read or write `~/.pi/agent`)

The UI assets are packaged locally with TLH, so the window does not need CDN-hosted assets or general internet access just to render.

## Troubleshooting and recovery

- `annotate-last-message requires interactive mode.` → run it from the TLH TUI.
- `No assistant messages found on the current session branch.` → wait for a branch reply, then rerun.
- `Latest assistant message is incomplete (...)` → wait for the assistant turn to finish, then rerun.
- `Latest assistant message has no text to annotate.` → rerun after a normal text reply.
- `A last-message annotation window is already open.` → reuse or close the existing window before opening another.
- `Annotation failed: Glimpse host not found ...` → the local native window runtime is unavailable. Run `tlh update` (or reinstall TLH) to restore the packaged dependency, then rerun from a machine/session that can display native windows.

There is no separate `tlh defaults` toggle for `/annotate-last-message` because it ships inside the TLH package itself.
