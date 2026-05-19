---
id: tlht-qcce
status: closed
deps: []
links: []
created: 2026-05-19T14:23:30Z
type: bug
priority: 1
assignee: Diego Petrucci
---
# Support old Pi update CLI in default extension refresh

Make the TLH installer refresh bundled default extensions without requiring users to upgrade an already-installed older Pi runtime. Keep the modern settings-wide refresh path when available, but ensure fallback per-source refreshes use the positional update form supported by older Pi.

## Design

The observed old Pi rejects 'pi update --extensions' and 'pi update --extension <source>' but accepts 'pi update [source]'. The installer already treats the settings-wide '--extensions' refresh as best-effort; use the positional source form for per-source fallback because newer Pi documents that form too.

## Acceptance Criteria

Installer commands always set PI_CODING_AGENT_DIR for the isolated profile. If 'pi update --extensions' is unsupported, the installer retries non-critical bundled defaults with 'pi update <source>' and can complete without requiring a Pi upgrade. Existing modern batch behavior remains covered. Tests cover the old-CLI fallback and expected command shapes.

