# Session-mirror v1 conformance

The repository-local conformance boundary is implemented in
[`conformance.ts`](./conformance.ts). It validates an already parsed
`unknown` value, or parses a raw JSON string with the exact UTF-8 envelope
bound before validating it. Parsed objects pass a defensive cycle, prototype,
accessor, depth, container, and compact-byte normalization gate before compact
aggregate bytes are evaluated. The normalization depth counts the envelope
root as depth 0; the container limit counts every object and array. The exact
numeric limits are exported in `SESSION_MIRROR_BOUNDS`. Normalization limits
report `structure-bounds`,
while raw and aggregate envelope limits report `envelope-bounds`. These raw-byte
and defensive-normalization safety gates run before deeper protocol,
capability, or semantic classification. For a foreign family or major, only
those gates plus the protocol-agnostic aggregate cap run; v1-specific value
bounds are not applied to arbitrary future fields. The boundary does not
observe sessions,
project transcripts, provide transport, or participate in the packaged runtime.

The exported constants are:

- `SESSION_MIRROR_BOUNDS` — the numeric v1 normalization, envelope, tree,
  payload, text, identity, cursor, and state-retention limits; the tree uses
  ordered `rootIds`, nullable `activeLeafId`, inline compaction summaries, and
  closed redacted source placeholders;
- `SESSION_MIRROR_FAILURE_CATEGORIES` — the closed set of stable validation
  failure categories.

The exported functions are:

- `validateSessionMirrorEnvelope(input)` — normalize and validate one parsed
  value, returning a concrete TLH-owned envelope or a closed failure category;
- `parseSessionMirrorJson(raw)` — enforce the raw UTF-8 bound, parse JSON as
  `unknown`, and use the same decoder;
- `createSessionMirrorState()` — create immutable prototype state;
- `applySessionMirrorEnvelope(state, input)` — validate, compare normative
  `(sessionId, eventId)` redeliveries, enforce event revision continuity, and
  return only `nextState`, the envelope, and an `applied` or `duplicate`
  disposition on success. Snapshot trees require `rootIds` to enumerate every
  parent-null entry, permit a null or interior active pointer, and require each
  compaction `firstKeptEntryId` to reference an entry in that tree. The
  `source-placeholder` entry is closed to exactly its coarse `sourceType`
  payload and one of `tool`, `provider`, `image`, `custom`, or `unsupported`.

Run the focused fixture and boundary checks from the repository root:

```sh
node --test tests/session-mirror-conformance.test.mjs
```

Error paths contain only bounded schema tokens and array indices; unknown
input keys are represented with a static wildcard or parent path, and values
are never included in diagnostics. Cursor overflow deliberately uses the
shared `identity-bounds` diagnostic, rather than a separate cursor category.

Unknown or forbidden message/event discriminants do not provide a v1 structural
schema for their bodies. Common envelope/message fields, aggregate safety
limits, and the schema-aware v1 bounds collector still apply, but malformed
nested body details are not promoted to `malformed-envelope`. A lightweight
semantic scan examines only recognizable `message.event` and
`message.snapshot` bodies for exact reserved streaming event types and reserved
markers inside schema-shaped assistant payloads; those forbidden signals retain
priority over an unknown kind. Basic malformed checks apply only to the shape
defined by a recognized discriminant. Compaction uses the upstream-shaped
inline `{ summary, firstKeptEntryId }` payload; legacy summary-entry and
compacted-id fields are rejected. Active-leaf events accept null on either
side, while event application remains state-only and does not infer tree
references.

The implementation is also covered by the repository checks:

```sh
npm run typecheck
npm run lint
npm run format:check
```

`applySessionMirrorEnvelope` is intentionally prototype-only. It stores only
session identity, revision, cursor, snapshot identity, and a finite
`maxSeenMessages` set of canonical message content for equality. An
authoritative snapshot resets that set; capacity applies only to a unique,
continuity-valid event that would be added. Exact duplicates, conflicting
duplicates, and revision gaps are classified before `snapshot-required` is
considered. A unique event beyond the set limit is rejected with
`bounds-exceeded` and a `snapshot-required` diagnostic rather than evicting old
identities. Caller-supplied state is normalized into a stripped, immutable
concrete state before use and return. The only unbound state is the semantic
initial state (`sessionId: null`, revision `0`, null cursor/snapshotId, and
empty history); a bound state requires a non-null cursor and at least one seen
identity. Canonical content is transient in memory and is never persisted. A
reviewed fingerprint and retention design is deferred; the state boundary
stores no projection tree and therefore does not enforce active-leaf
referential existence for events.
