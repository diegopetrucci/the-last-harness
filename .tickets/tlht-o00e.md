---
id: tlht-o00e
status: closed
deps: []
links: []
created: 2026-05-19T10:45:59Z
type: feature
priority: 2
assignee: Diego Petrucci
tags: [installer, release]
---
# Default latest release installs to latest-release track

Make the GitHub Release installer asset default future updates to the latest-release track when the user does not pass TLH_UPDATE_TRACK or --track, so the published one-line command can omit TLH_UPDATE_TRACK.

## Design

Prefer release asset generation to stamp the default track into dist/install.sh; source checkouts should keep existing inference unless explicitly changed by env/--track.

## Acceptance Criteria

The latest GitHub Release installer asset would install with updateTrack latest-release by default; explicit --track or TLH_UPDATE_TRACK values continue to override; source/raw branch installs are not unintentionally forced to latest-release; tests cover the new default behavior.
