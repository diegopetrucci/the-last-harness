# Release notes

`release-notes/v<version>.md` is the user-facing body of the GitHub Release for that version. `scripts/release-notes.mjs` appends a full-changelog link; `CHANGELOG.md` stays the complete record: every merged PR gets a terse one-line entry there, with contributor-only changes under `### Internal`. This directory is not shipped in the npm package.

The TLH architect drafts `release-notes/v$version.md` from the `CHANGELOG.md` section for the release, then the maintainer edits it. Release creation fails if the file is missing or empty, and `npm run check:release-notes` checks that each file has a heading or list item and does not end mid-sentence.

## Style guide

- Highlights only: include what users will notice, not every change.
- Group by theme (for example, "Faster startup"), not by change type.
- Write conversationally in second person ("you can now…").
- Describe user-visible symptoms and benefits, not mechanisms.
- Leave out internal file paths, function names, issue or ticket numbers, and upstream commit references.
- Mention only slash commands that exist in [`docs/commands.md`](../docs/commands.md).
- Keep it concise.

Example:

```md
## Smoother updates

- `tlh update` no longer stops when a bundled extension is temporarily unavailable; you'll see a warning and the rest of your setup updates as usual.
```
