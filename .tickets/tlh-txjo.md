---
id: tlh-txjo
status: closed
deps: []
links: []
created: 2026-05-15T10:34:37Z
type: feature
priority: 2
assignee: Diego Petrucci
---
# Add TLH keybinding defaults merge

Add a conservative keybindings defaults merge for the isolated TLH profile so TLH can reclaim Shift+Tab without touching normal Pi config or clobbering user keybindings.

## Design

Use a packaged keybindings defaults JSON with app.thinking.cycle set to [] and a Node ESM helper that writes PI_CODING_AGENT_DIR/TLH_AGENT_DIR keybindings.json by default. Only set missing keys, preserve existing user values, support --dry-run/--quiet, and back up before writes.

## Acceptance Criteria

config/keybindings.defaults.json exists with app.thinking.cycle disabled; merge helper preserves existing keys and only writes isolated-profile keybindings.json; helper supports dry-run/quiet and creates a backup before changing an existing file; node --check passes for the helper.

