---
id: tlht-cg4l
status: open
deps: []
links: []
created: 2026-05-21T19:57:17Z
type: task
priority: 1
assignee: Diego Petrucci
parent: tlht-41ov
tags: [simplification, architecture]
---
# Define TLH core boundary and optional-feature policy

Document what belongs in core TLH versus bundled/default optional extensions. Core should cover the isolated profile and wrapper, conservative settings/keybindings merges, primary-agent runtime, required gn/tk, critical subagents/intercom, and safety rails; classify footer niceties, telemetry, update checks, provider usage fetches, search/notify/context extras, and Plannotator-style add-ons as optional.

## Design

Use this as the prerequisite decision for extraction, README trimming, default-extension review, and migration cleanup. Preserve normal Pi isolation and conservative merges.

## Acceptance Criteria

A short design note, doc, or ticket note lists core, default-bundled optional, and out-of-core categories; non-goals and invariants are explicit; follow-up tickets reference the boundary.

