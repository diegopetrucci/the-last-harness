---
id: tlh-gv33
status: closed
deps: [tlh-txjo]
links: []
created: 2026-05-15T10:34:52Z
type: task
priority: 2
assignee: Diego Petrucci
---
# Wire keybinding defaults into installer

Run the TLH keybindings defaults merge during install/update paths using the isolated profile, with dry-run support and no effect when settings/config merges are explicitly skipped.

## Acceptance Criteria

install.sh discovers/fetches the keybinding merge helper and defaults from local or release/raw support files; normal installs run the merge against AGENT_DIR/keybindings.json; --dry-run reports the intended keybinding merge without writing; --no-settings skips the keybinding merge; bash -n install.sh passes.
