# TLH session-mirror v1 profile

This document defines the repository-local, synthetic **session-mirror** profile for
version 1. It is a data contract and fixture reference only. It does not define an
observer, an IPC channel, an application, a transport, a server, or a publication
package. The fixtures in this directory are not captured sessions.

## Envelope

Every v1 message describes exactly one persisted session for one conversation. The
session is identified by the opaque top-level `sessionId`; consumers must not derive
conversation identity, ordering, or a filesystem location from that value.

The envelope has these required top-level members:

```json
{
  "protocol": {
    "family": "session-mirror",
    "major": 1,
    "minor": 0
  },
  "source": {
    "runtimeVersion": "fixture-runtime-0.1.0",
    "sessionSchemaVersion": "fixture-session-schema-0.1"
  },
  "sessionId": "opaque-session-id",
  "capabilities": [
    "session-tree",
    "completed-turns-only",
    "snapshot",
    "cursor-recovery",
    "custom-entries",
    "coarse-status"
  ],
  "message": {}
}
```

- `protocol` identifies the TLH contract family and its major/minor version.
  `family` is a required non-empty string; `major` and `minor` are required
  non-negative integers. A consumer may accept this profile only when `family`
  is `session-mirror` and `major` is `1`. Minor-version compatibility is
  negotiated by the consumer; the v1 fixtures use minor `0`. A missing or
  ill-typed version member is `malformed-envelope`; a different family or
  unsupported major is an `incompatible-protocol`, not a different kind of
  session.
- `source.runtimeVersion` and `source.sessionSchemaVersion` describe the runtime
  and source session format that produced the message. They are source metadata,
  not protocol versions, and must not be confused with `protocol.major` or
  `protocol.minor`. They are deliberately synthetic in this corpus.
- `sessionId` is an opaque, non-empty string. It is scoped to one persisted
  conversation session and has no path, provider, host, or timestamp semantics.
- `capabilities` is a deterministic array of stable kebab-case capability names.
  The array itself must be present; every member must be a unique string in
  kebab-case. A non-array, non-string, duplicate, or non-kebab capability is
  `malformed-envelope`. The v1 required names occupy this canonical prefix:
  `session-tree`, `completed-turns-only`, `snapshot`, `cursor-recovery`,
  `custom-entries`, and `coarse-status`. A missing or reordered required name
  is `incompatible-capability`; unique unreserved optional names may follow
  the required prefix. Unknown unreserved names may be retained for forwarding
  but never authorize behavior. Reserved streaming names are forbidden as
  described below.
- `message` contains all message-specific identity, ordering, operation, and
  payload fields. There is no top-level `snapshot`, `replacement`, `event`,
  `revision`, or `cursor` member in this profile.

Unknown envelope fields may be retained when forwarding, but are not interpreted
by v1. In contrast, an unknown required envelope kind or message kind is an
incompatibility and must not be guessed at. Custom data belongs inside a session
entry payload as described below.

## Message envelope and replacement semantics

`message` is discriminated by its required `kind` member:

```json
{
  "kind": "snapshot",
  "eventId": "stable-message-identity",
  "revision": 4,
  "cursor": "opaque-cursor-4",
  "operation": "replace",
  "snapshot": {
    "snapshotId": "opaque-snapshot-id"
  }
}
```

- `eventId` is a stable, non-empty identity for this published message. It is
  opaque and is not a cursor or a revision.
- `revision` is a non-negative integer for the one session. An appended event
  advances it by exactly one. For `kind: "snapshot"`, `message.revision` is
  the snapshot revision represented by the complete replacement state; for
  `kind: "event"`, it is the appended event revision.
- `cursor` is a non-empty opaque source position. It is stored and returned as a
  whole value; consumers must not parse it or infer ordering from its spelling.
- `kind: "snapshot"` requires `operation: "replace"` and a `snapshot` payload
  with an opaque `snapshotId`. The snapshot is authoritative: applying it
  discards the prior mirrored tree, status, snapshot identity, revision, and
  cursor, then installs the snapshot and its exact `snapshotId` and
  revision/cursor. A replacement can optionally identify the prior position
  with a message-local `replaces` object containing `snapshotId`, `revision`,
  and `cursor`.
- `kind: "event"` requires `operation: "append"`, a `baseRevision`, and an
  `event` payload. `baseRevision` must be one less than `revision`. An event
  applies to the existing session state only after its base revision is known.
  Before applying any message (and before event continuity), a known
  `(sessionId, eventId)` is compared for semantic equality of `sessionId` plus
  the normative message identity, position, and payload fields. Identity and
  position include the message kind, operation, revision, base revision when
  present, cursor, and replacement position; permitted nested payload fields are
  compared as payload semantics. Source metadata, capabilities, open envelope
  metadata, and non-normative message metadata do not participate. JSON object
  key order does not affect equality. An exact redelivery is accepted and
  ignored idempotently. Any differing identity, position, or payload is
  `conflicting-duplicate`. Only an unseen event identity undergoes continuity:
  the expected base/revision must apply, while ahead, stale, or regressed
  unseen positions are `revision-gap`. Neither case permits inventing or
  merging state.

The required v1 message kinds are exactly `snapshot` and `event`. A future or
unknown required message kind is incompatible. The required event payload types
are `turn.completed`, `active-leaf.changed`, `status.changed`,
`summary.updated`, and `session.compacted`. An unknown or context-disallowed
message, event, or entry kind is `incompatible-message-kind`; other event types
are incompatible unless a later profile defines them.

## Session tree

A `snapshot` payload is:

```json
{
  "snapshotId": "opaque-snapshot-id",
  "status": "idle",
  "tree": {
    "rootIds": [],
    "activeLeafId": null,
    "entries": []
  }
}
```

`rootIds` is the ordered list of every entry whose `parentId` is null. It is
empty if and only if the snapshot tree has no entries; a non-empty tree may have
multiple roots. Every listed root is an existing entry, and every parent-null
entry appears exactly once in the list.

`activeLeafId` is the opaque current source pointer. It may be null for either
an empty or non-empty tree, and when non-null it identifies an existing entry;
it is not required to identify a graph leaf. Sibling entries represent a branch.
The active pointer is the selected source entry, not a second persisted session.

`status` is deliberately coarse and is one of `idle`, `active`, `waiting`,
`error`, or `unknown`; it carries no provider, process, host, or diagnostic
identity. The tree has one `entries` array. Each entry has a unique opaque `id`,
a `parentId`, a `kind`, and a `payload` object. Every non-null parent exists and
parent links are acyclic.

Known entry kinds are:

- `user-turn`: a completed user turn with
  `payload.content` containing the required `format: "text"` and string `text`
  fields. Unknown content fields are retained.
- `assistant-turn`: a completed assistant turn whose final
  `payload.content` object has exactly `format: "text"` and a complete string
  `text`. There is no v1 representation for a partial assistant turn, and
  unknown content fields are not accepted.
- `summary`: a completed summary entry with full text content; unknown content
  fields are retained.

The 32 KiB text bound applies to the `text` field of these known text-bearing
entry kinds and to the inline `summary` string on a compaction entry. It does
not apply to arbitrary strings in open known-entry metadata or to opaque custom
payloads.

- `compaction`: a completed source compaction marker with
  `payload.summary` (the bounded inline summary string) and
  `payload.firstKeptEntryId`. The entry retains its source `id` and `parentId`;
  it does not fabricate a summary entry or carry a compacted-id list. In a
  snapshot, `firstKeptEntryId` must identify an entry in that same tree. Unknown
  compaction entry and payload fields may be retained under the normal open
  known-entry policy.
- `source-placeholder`: a completed TLH-owned redacted entry with exactly
  `{ "id", "parentId", "kind", "status", "payload" }`, where the payload has
  exactly `{ "sourceType": <coarse category> }`. `sourceType` is one of
  `tool`, `provider`, `image`, `custom`, or `unsupported`. No source details or
  additional entry/payload fields are accepted in this closed shape.

Known entry kinds require `status: "completed"` as an entry member. Any other
status on a known kind is `incomplete-turn`. A custom entry may omit `status` or
carry a status value as uninterpreted, preserved data. A `turn.completed` event
carries the complete entry, never a partial content fragment. Publication is
therefore completed-turn-only: an in-progress assistant response remains
unpublished until one complete assistant entry is available.

An entry kind outside the known list is a custom entry. Custom entries still
participate in the tree through `id` and `parentId`, while their `payload` is an
opaque JSON object whose values and structure must be preserved semantically
without interpretation or loss, including unknown nested fields. Unknown fields
on known entries may likewise be retained. For a known assistant turn, however,
`payload.content` is closed to the final `{ "format": "text", "text": "..." }`
shape: reserved partial-stream fields or markers such as `delta`, `token`,
`stream`, `partial`, `isPartial`, or `final: false` markers are rejected even
when other unknown fields on the entry or payload are preserved. The reserved
marker scan covers only the assistant `payload` object, including its `content`
and permitted payload metadata, and does not inspect arbitrary entry metadata.
User, summary, and custom unknown content remains opaque and is preserved
without marker interpretation. Opaque custom payloads receive only their
payload and aggregate bounds, not the known-entry text bound.
This open-entry rule does not make unknown envelope or message kinds valid.

## Event payloads

The event payload is selected by `event.type`:

- `turn.completed`: `{ "entry": <complete user-turn or assistant-turn> }`.
- `active-leaf.changed`: `{ "previousActiveLeafId": <id|null>,
"activeLeafId": <id|null> }`. Both pointers may be null, allowing changes to
  and from the pre-entry position. A full snapshot enforces referential
  existence for any non-null pointer, while the state-only apply boundary
  intentionally stores no projection tree and does not enforce event
  referential existence. An empty tree is represented by an authoritative empty
  snapshot, never by this event.
- `status.changed`: `{ "status": <coarse status> }`.
- `summary.updated`: `{ "entry": <complete summary entry> }`.
- `session.compacted`: `{ "entry": <complete compaction entry> }`. The entry
  contains the inline summary and `firstKeptEntryId`; there is no event-level
  compacted-id list.

Event payloads are changes to the one session identified by the envelope. They do
not create another session and do not carry transport, observation, or delivery
metadata.

## Explicitly forbidden streaming kinds

The v1 profile never publishes assistant streaming. These exact capability names
are reserved and forbidden; their presence must be rejected as
`forbidden-streaming`:

- `assistant-streaming`
- `assistant-delta`
- `assistant-token`

The following event types are also forbidden and must be rejected as
`forbidden-streaming`:

- `assistant.delta`
- `assistant.token`
- `assistant.stream`

A complete assistant entry may contain only its final text content. The
reserved partial-stream names above and the event kinds listed here are explicit
contract exclusions, not hints for a future streaming implementation.

## Closed failure categories and classification

The v1 conformance result uses this closed set of stable failure categories:

- `malformed-envelope`: required shape or value types are missing or malformed;
- `bounds-exceeded`: a provisional size or count bound is exceeded;
- `incompatible-protocol`: the protocol family or major version is unsupported;
- `incompatible-capability`: a required v1 capability name is missing or the
  required v1 capability prefix is reordered;
- `forbidden-streaming`: a reserved streaming capability, event, or partial
  content marker is present;
- `incompatible-message-kind`: a required message, event, or context-disallowed
  entry kind is unknown or unsupported;
- `incomplete-turn`: a known turn or other completed publication is not marked
  `completed` or lacks final content;
- `conflicting-duplicate`: an already-seen `(sessionId, eventId)` identity is
  reused with a different position or payload;
- `revision-gap`: an unseen event does not follow the known revision/base
  revision;

A `session-mismatch` diagnostic is reported under `malformed-envelope` when an
apply operation receives a different session from the state it is updating.
Diagnostic paths contain only bounded schema tokens and array indices. An
unknown input key is represented by a static wildcard or parent path; arbitrary
input keys and values are never copied into an error detail.

A validator reports the first applicable category in this deterministic order:

1. basic malformed shape/types (`malformed-envelope`);
2. provisional bounds (`bounds-exceeded`);
3. protocol family/major (`incompatible-protocol`);
4. required capability presence/order (`incompatible-capability`);
5. reserved forbidden streaming (`forbidden-streaming`);
6. unknown or context-disallowed message/event/entry kind (`incompatible-message-kind`);
7. incomplete completed-turn publication (`incomplete-turn`);
8. conflicting duplicate identity (`conflicting-duplicate`);
9. revision continuity for an unseen event (`revision-gap`).

For an unsupported family or major, the bounds step is limited to the raw-byte,
defensive-normalization, and protocol-agnostic aggregate envelope gates; v1
identity, text, payload, and tree-value bounds are not interpreted in arbitrary
future fields. Once the family and major identify v1, recognizable v1 value
bounds participate in step 2 even when a later semantic category will apply.

The capability step distinguishes a missing required name from the reserved
streaming step: a missing name is `incompatible-capability`, while an explicitly
advertised reserved streaming name is `forbidden-streaming`. The reserved
streaming step also runs before generic unknown message/event classification, so
`assistant.delta`, `assistant.token`, and `assistant.stream` retain their stable
`forbidden-streaming` category even though they are not required v1 event kinds.

## Provisional prototype bounds

These temporary bounds keep fixtures and an eventual boundary validator small.
They are conservative prototype guardrails, not production capacity claims and
may change with a later profile:

- one complete envelope: at most 256 KiB UTF-8;
- one tree: at most 1,024 entries and depth 128;
- one entry payload: at most 64 KiB;
- one text or compaction summary value: at most 32 KiB;
- `sessionId`, `snapshotId`, entry IDs, and event IDs: at most 128 characters
  each;
- `cursor`: at most 256 characters;
- prototype state seen-message history: at most 64 identities;
- defensive JSON normalization: container depth at most 512 (the envelope
  root is depth 0), at most 10,000 object/array containers total, and at most
  1 MiB of compact normalized JSON accounting.

The current prototype deliberately accepts one complete envelope per fixture or
message. It defines no chunking, continuation, or reassembly contract; a
complete envelope over the aggregate bound is simply `bounds-exceeded`. Raw JSON
is checked against its exact UTF-8 envelope bound before parsing. Parsed object
inputs then pass a defensive cycle/prototype/accessor-safe normalization gate
with the explicit depth, container, and compact-accounting-byte limits above;
only after that gate is their compact aggregate UTF-8 size evaluated. A
normalization limit reports `bounds-exceeded` with `structure-bounds`, rather
than the content-oriented `envelope-bounds` diagnostic. These raw-byte and
normalization safety gates run before deeper protocol, capability, or semantic
classification. The fixture corpus stays far below these bounds. The
repository-local conformance validator is documented in `CONFORMANCE.md`; it
remains separate from observation, transport, and runtime behavior.

The prototype apply state retains at most `maxSeenMessages` canonical message
identities. An authoritative snapshot resets that history to its own identity.
The capacity check applies only to a unique, continuity-valid event that would
actually be added. Exact duplicates return `duplicate`, conflicting duplicates
return `conflicting-duplicate`, and stale or ahead unseen events return
`revision-gap` before `snapshot-required` can apply. A unique continuity-valid
event beyond the finite history bound is rejected as `bounds-exceeded` with a
snapshot-required diagnostic; entries are never evicted and therefore never
silently misclassified as new. Canonical message content is transiently retained
in memory only for equality and is never persisted. A reviewed fingerprint and
retention design is deferred to a later contract; this state bookkeeping is
prototype-only.

## Fixture inventory

`manifest.json` is the authoritative inventory. Each item names a JSON envelope
and classifies it with `valid`: `true` means structurally conformant as a
standalone envelope. An item with `valid: false` and no `applyAfter` contains a
standalone structural defect and names the failure category to report. An item
with `applyAfter` is structurally read as one envelope, but its named failure is
reported only when applied after that earlier fixture. Standalone event fixtures
may contain opaque entry IDs without a fixture-local prior state; stateful or
referential application checks run only for items with `applyAfter`. Snapshot
compaction markers must still reference an entry in their own snapshot tree.
`applyAfter` is test sequencing metadata, not an envelope field, and keeps each
fixture file to one envelope. The fixture files are synthetic and use no real prompts,
personal paths, credentials, hostnames, provider data, or infrastructure
identifiers.
