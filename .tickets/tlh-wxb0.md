---
id: tlh-wxb0
status: closed
deps: []
links: []
created: 2026-05-17T19:16:18Z
type: feature
priority: 2
assignee: Diego Petrucci
---
# Patch pi-intercom collapsed incoming message cards

In the TLH pi-intercom fork at /Users/diegopetrucci/.the-last-harness/agent/git/github.com/diegopetrucci/pi-intercom, make incoming intercom_message cards honor Pi's MessageRenderOptions.expanded. Collapsed mode should be compact by default; expanded mode should preserve today's full body rendering. Do not change model-visible message content or broker protocol.

## Design

Pass renderer options.expanded from index.ts into InlineMessageComponent. Add collapsed rendering in ui/inline-message.ts with a short preview and app.tools.expand/Ctrl+O hint. Keep reply-required context visible enough for supervisor asks.

## Acceptance Criteria

npm test passes in the pi-intercom repo. inline-message tests cover collapsed long-body preview and expanded full-body rendering. Incoming message history/content remains unchanged; only TUI rendering changes.

