# Unsafe dictionary investigation (2026-08-18)

> **Contributor-only investigation note.** This note records evidence for a future anti-slop decision. It is not an implementation plan or approval to enable `anti-slop/no-unsafe-dictionary-type`.

## Decision and scope

**Status: deferred and not approved.** The rule remains commented out in [`.oxlintrc.json`](../.oxlintrc.json). This ticket changes documentation and packaging metadata only: it does not activate the rule, edit a finding, change runtime or test behavior, or refresh generated output.

The question investigated was whether the current merged tree is ready for this rule. The answer is **no blanket remediation**. The findings cross JSON/configuration boundaries, subagent protocols, host-runtime compatibility probes, and tests. They need owner- and schema-derived contracts rather than a mechanical type substitution.

## Fresh merged-tree baseline

The inventory was taken on 2026-08-18 from commit [`953d541d3edd985d3fdc43b1c439d6e805b6f19b`](https://github.com/diegopetrucci/the-last-harness/commit/953d541d3edd985d3fdc43b1c439d6e805b6f19b), the clean merged tree at `origin/main`. The checkout used Node `26.7.0` and Oxlint `1.78.0`.

For inventory only, a disposable copy of the repository Oxlint configuration enabled the otherwise-commented rule and resolved the local plugin path. The repository configuration itself was not changed. The command covered the same source/test roots as the normal lint command:

```sh
npx oxlint -c <disposable-investigation-config> --format=json scripts tests extensions
```

The result was **195 diagnostics in 84 files**. Every diagnostic carried the rule's `unknown` value classification; there were no `any`, `object`, empty-object, or union classifications in this baseline. The regular lint configuration still leaves the rule disabled.

### Exact subsystem counts

Counts below are diagnostic spans followed by the number of files containing them.

| Subsystem | Diagnostics | Files |
| --- | ---: | ---: |
| `extensions/subagents/src` | 69 | 26 |
| `extensions/subagents/test` | 45 | 26 |
| `extensions/the-last-harness` | 56 | 19 |
| Other extensions (`annotate-git-diff`, `notify`, `shared`) | 4 | 3 |
| `scripts` | 21 | 10 |
| **Total** | **195** | **84** |

The subagent runtime rollup is `runs` 44 (16 files), `shared` 11 (6 files), `agents` 10 (1 file), `extension` 3 (2 files), and `tui` 1 (1 file). Its tests are `integration` 19 (11 files), `unit` 18 (12 files), and `support` 8 (3 files). The script rollup is 15 diagnostics in six root `scripts/` files and 6 diagnostics in four `scripts/lib/` files. In broader terms, 174 diagnostics are under `extensions/` and 21 under `scripts/`; 150 are in runtime sources and 45 are in tests.

### Exact syntax counts

These are counts of the rule's diagnostic label spans, not a lexical count of every occurrence in the tree:

| Reported syntax span | Diagnostics |
| --- | ---: |
| Direct `Record<string, unknown>` | 183 |
| Explicit `[key: string]: unknown;` index signatures | 3 |
| Local alias references resolving to an unsafe dictionary: `JsonObject` (5), `JsonRecord` (2), `TestEventPayload` (2); bare local consumer references are suppressed | 9 |
| **Total** | **195** |

Alias diagnostics need a further qualification: a bare reference to a locally declared unsafe alias is intentionally suppressed unless it occurs inside a `TSTypeAliasDeclaration`. The 9 alias findings are therefore not a call-site inventory; per-file counts systematically understate the number of consumer sites a remediation would need to touch.

Thus the baseline is unusually uniform: every report is an unknown-valued dictionary contract, even though the surrounding uses have different ownership and validation requirements.

## Semantic finding clusters

The syntax is shared, but the semantics are not:

- **External and persisted JSON boundaries.** `JSON.parse`, settings/package metadata, session artifacts, and other untrusted or versioned payloads are first represented as unknown data before field checks. Examples include [`scripts/tlh-install.mts`](../scripts/tlh-install.mts), [`scripts/merge-settings.mts`](../scripts/merge-settings.mts), [`extensions/subagents/src/agents/agents.ts`](../extensions/subagents/src/agents/agents.ts), and [`extensions/subagents/src/runs/shared/nested-events.ts`](../extensions/subagents/src/runs/shared/nested-events.ts). These need parsers or narrow guards owned by the payload schema.
- **Subagent lifecycle, event, tool, and acceptance protocols.** The largest cluster within the subagent runtime is under `extensions/subagents/src/runs/` and `src/shared/`: lifecycle/control messages, nested events, child transcripts, tool arguments, model fallback data, and acceptance reports. These contracts should be derived from the protocol/event discriminants and preserved across durable resume, not replaced by a narrower guess at each cast.
- **TLH host and compatibility surfaces.** Provider feature probes, settings/model overrides, telemetry, session/token reports, review data, and global/third-party objects live under `extensions/the-last-harness/`. Some are intentionally compatibility-shaped because the upstream surface varies by version; the right fix may be an adapter or an upstream type guard rather than a new application-wide dictionary type.
- **Installer and configuration maps.** The `scripts/` findings cover installer state, defaults, merged settings, keybindings, package metadata, and doctor/ticket input. These need schema-owned configuration types and explicit validation at file/API boundaries.
- **Tests and test support.** The 45 test diagnostics are concentrated in fixture payloads, helper options, and serialized protocol samples. They should follow the runtime contract after it is established; weakening fixture types or adding blanket suppressions would hide drift rather than validate it.

## Verified rule behavior and limitations

A disposable fixture and the baseline output verified that the rule:

- reports built-in `Record<K, V>` when `V` is `unknown`, `any`, `object`, an effectively empty object, or a union/intersection/alias whose resolved value is unsafe. A union is unsafe when any member is unsafe; an intersection is unsafe only when it contains `any` or every member is unsafe, so a mixed intersection with one unsafe member is not reported;
- reports index-signature dictionaries through separate paths: an interface (or other non-`TSTypeLiteral`) index signature is reported by the `TSIndexSignature` handler, while an index signature inside an object type literal is reported at the enclosing `TSTypeLiteral` span rather than at the signature. All three explicit index-signature findings in this baseline are interface members;
- follows the supported local aliases and the rule's transparent dictionary wrappers (for example `Readonly`, `Partial`, `Required`, and `NonNullable`); `Pick` and `Omit` are traversed only when they are themselves the dictionary being classified, not when they appear as a dictionary's value type; and
- accepts concrete value contracts such as `Record<string, string>` or a record whose value has known fields.

The rule is an AST/plugin analysis, not a TypeScript type-checker or a schema validator. Important limitations for any future implementation review are:

- the type environment is assembled from top-level declarations in the current file; imported aliases and cross-file ownership are not resolved;
- bare references to a locally declared unsafe alias are intentionally suppressed unless the reference occurs inside a `TSTypeAliasDeclaration`; the alias row above therefore systematically understates the number of consumer call sites a remediation would touch;
- it cannot tell whether an unknown dictionary is a deliberate short-lived decode boundary, a compatibility adapter, a protocol value, or an accidental public contract;
- it reports the same broad shape when used in a type assertion, guard, parameter, return, state container, or serialized payload, so the diagnostic does not identify the correct remediation;
- a fixture confirmed that `interface X extends Record<string, unknown>` is not reported by the current rule, while an interface's direct index signature is reported; and
- nested dictionary syntax is reported according to the rule's outermost dictionary traversal, so diagnostic locations are not a promise that each nested occurrence receives an independent finding.

These limitations make the 195-finding output an investigation inventory, not a mechanically actionable patch list.

## Prohibited cosmetic remediations

The following are explicitly out of scope and should not be used to make the count smaller:

- replacing `unknown` with `any`, `object`, `{}`, or another broad union;
- hiding the shape behind a renamed alias, wrapper, assertion, or cast without adding validation or an owned value contract;
- changing a type only to satisfy the diagnostic while leaving an external payload unparsed;
- adding blanket rule-disable comments, changing the global rule configuration, or excluding broad directories;
- editing tests or generated JavaScript separately from the authoritative TypeScript contract; or
- rewriting a dictionary as another open container (`Map`, `Record<PropertyKey, ...>`, or an index signature) without a concrete value model.

No such remediation is approved by this note.

## Possible future implementation slices

Each slice requires its own approval, semantic review, tests, and explicit decision about the remaining findings:

1. **Subagent protocol slice:** define/derive discriminated types and boundary parsers for lifecycle/control messages, nested events, child transcripts, tool payloads, and acceptance artifacts. Preserve the durable JSON compatibility behavior while narrowing only after validation.
2. **TLH host/runtime slice:** model settings, provider-auth compatibility surfaces, model overrides, telemetry, session/token reports, and third-party feature probes with adapters or owner-derived types.
3. **Installer/configuration slice:** introduce schema-owned types and validation for settings, keybindings, defaults, package metadata, ticket input, and doctor state.
4. **Test contract slice:** migrate fixture helpers and serialized samples to the reviewed runtime contracts, retaining tests for malformed and unknown input rather than deleting broad-boundary coverage.
5. **Rule adoption slice:** only after the prior slices are reviewed, rerun the inventory, classify every remaining diagnostic, and separately approve any narrow boundary exemption. Enabling the rule is not implied by this note.

## Generated-output and publication implications

The authoritative runtime sources remain `scripts/**/*.mts` and `extensions/**/*.ts`; same-layout `scripts/**/*.mjs` and `extensions/**/*.js` are generated. A future approved runtime change must edit the authoritative source, run `npm run build`, inspect the generated diff, and run `npm run check:runtime`. This documentation ticket intentionally changes none of those files and does not authorize a build.

This note is contributor-only. It is linked from [local development](local-development.md) for maintainers, and its exact path is negated in `package.json` so it is absent from the npm package. It must not become an end-user runtime or shipped documentation dependency.

## Explicit deferred status

As of the dated baseline:

- `anti-slop/no-unsafe-dictionary-type` is **deferred** and remains disabled;
- no lint activation, runtime behavior, test behavior, generated output, or source contract change is approved;
- no cosmetic suppression or broad type substitution is approved; and
- future implementation requires a separately scoped ticket for each semantic slice, followed by a fresh merged-tree inventory and review.
