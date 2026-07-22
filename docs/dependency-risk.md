# Accepted Dependency Risks

This file records explicit risk-acceptance decisions for audit findings that are
not remediated by a version bump and where the team has decided to defer action.

---

## DOMPurify advisories via monaco-editor (accepted 2026)

### Advisory IDs

`npm audit --omit=dev --package-lock-only --audit-level=moderate` reports a moderate-severity dompurify advisory group plus a low-severity monaco-editor group. The dompurify group comprises:
- GHSA-vxr8-fq34-vvx9
- GHSA-cmwh-pvxp-8882
- GHSA-c2j3-45gr-mqc4

### Affected package and version

`dompurify` ≤ 3.4.11 — bundled transitively by `monaco-editor@0.56.0`
(currently ships `dompurify@3.4.8`).

### Why this is non-exploitable in TLH's usage

The annotate-git-diff extension is the only consumer of monaco in this project.
It instantiates two read-only editors:

- `monacoApi.editor.createDiffEditor(…, { readOnly: true, originalEditable: false })`
- `monacoApi.editor.create(…, { readOnly: true })`

Both render diff text as tokenised plain text. The extension does **not** use:

- `MarkdownString` or `renderMarkdown`
- `registerHoverProvider` / `registerCompletionItemProvider`
- `setModelMarkers` with trusted HTML
- Any custom-element or trusted-types configuration

Monaco's bundled DOMPurify is only exercised through those HTML-rendering paths
(hover-tooltip HTML, completion-item documentation, trusted-type widget content).
Because none of these paths are active, the advisories are not reachable, and the
DOMPurify sanitisation code is never called at runtime.

The advisories additionally require attacker control over DOMPurify
`setConfig` / `clearConfig` or custom-element handling — a further layer of
protection beyond the unreachable call path.

### Decision

**Accept risk. Keep `monaco-editor@0.56.0`.**

The automated `npm audit` fix proposes a downgrade to `monaco-editor@0.53.0`.
That downgrade would revert intentional UI improvements landed in the 0.55/0.56
work and carries real UI-regression risk. Upgrading to a monaco release that
bundles `dompurify >=3.4.12` is not yet available. Risk acceptance is the
appropriate response given the analysis above.

### Re-evaluation trigger

Revisit this decision if **any** of the following occur:

1. The annotate-git-diff extension (or any new extension) begins rendering
   `MarkdownString`, hover providers, completion-item docs, or any trusted HTML
   via monaco.
2. A monaco release becomes available that bundles `dompurify >=3.4.12`.
3. A proof-of-concept demonstrates the vulnerability is reachable through plain
   diff rendering.

### Validation note

`npm run validate` does **not** run `npm audit`. Periodic manual audits
(`npm audit --omit=dev --package-lock-only --audit-level=moderate`) should be
run to detect when updated packages become available.

### Code anchor

The risk-acceptance comment is co-located with the editor instantiation site:
`extensions/annotate-git-diff/web/app.js` — search for
`SECURITY NOTE (DOMPurify advisory`.
