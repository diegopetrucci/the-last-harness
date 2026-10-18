# Local-bridge v0 conformance

[`conformance.ts`](./conformance.ts) is a repository-only oracle for the
local bridge contract. It does not open sockets, inspect profiles, observe
sessions, or participate in the published TLH runtime. Every external value is
accepted as `unknown`, normalized through a boundary-specific defensive shape
gate, and then narrowed into concrete owned types. Direct rendezvous,
handshake, and result values use separate 4 KiB-class byte, depth, container,
and collection limits; retained state uses the larger formula-derived budget.
Bridge-owned outer `installationId` and `sessionId` values are non-empty,
well-formed Unicode scalar sequences with no unpaired UTF-16 surrogates. They
allow at most 128 Unicode code points; an astral scalar counts as one code
point. Their existing UTF-8 ceiling is four bytes per permitted code point
(512 bytes at the bound). This rule is applied at rendezvous/configuration,
hello, ownership-state, and command boundaries, and malformed or over-bound
values fail closed before scope or ownership mutation. When retained state
contains session-mirror/v1 apply state, the nested `sessionMirrorState` fields
and `lastSnapshotRevision` remain governed by the frozen v1 Unicode code-point
and string semantics and number rules; the outer scalar rule does not
reinterpret or change those retained values, and v1-emitted `-0` is preserved.
Separately,
bridge-owned unsigned counters reject numeric negative zero (`-0`); that rule
is independent of identity validation. Array lengths and own-key counts are
checked before child traversal where JavaScript reflection permits. These bounds
limit oracle traversal and retained output, not allocations the engine may
perform while reflecting on hostile
objects or proxies. Accessors, cycles, prototypes, non-JSON primitives,
malformed frames, invalid UTF-8, and oversized values return a closed aggregate
code without throwing.

The exported bounds and closed sets are:

- `LOCAL_BRIDGE_PROTOCOL` and `LOCAL_BRIDGE_READ_ONLY_PROTOCOL` — v0 minor-0
  data version (the explicit read-only form);
- `LOCAL_BRIDGE_REPLY_PROTOCOL` — the separate v0 minor-1 reply-channel
  version negotiated only after the data handshake;
- `LOCAL_BRIDGE_CAPABILITIES` and `LOCAL_BRIDGE_REPLY_CAPABILITY` — required
  capability prefix and the optional negotiated `reply-text` capability;
- `LOCAL_BRIDGE_REPLY_RECEIPT_CODES`, `LOCAL_BRIDGE_REPLY_CLOSE_REASONS`,
  `LOCAL_BRIDGE_REPLY_DIRECTIONS`, and `LOCAL_BRIDGE_REPLY_OUTCOME_CODES` —
  closed reply evidence vocabularies;
- `LOCAL_BRIDGE_BOUNDS` — frame, control, rendezvous, socket-path, reply,
  normalization, concurrency, epoch, revision, and activity-generation limits;
- `LOCAL_BRIDGE_ERROR_CODES` — every failure code that may cross this boundary;
- `LOCAL_BRIDGE_RUNTIME_ONLY_ERROR_CODES` — `handshake-required`, the
  connection-phase output supplied by runtime state and not fabricated by this
  parser. `wrong-direction` remains a closed parser/runtime error in
  `LOCAL_BRIDGE_ERROR_CODES`;
- `LOCAL_BRIDGE_RESULT_CODES` — every successful lifecycle/publication outcome
  that may cross this boundary;
- `LOCAL_BRIDGE_NORMALIZATION_FORMULA` — the bounded-state formula and slack
  used to derive the defensive re-normalization budget.

The boundary validators are:

- `validateLocalBridgeRendezvous` and `parseLocalBridgeRendezvousJson` — check
  the exact rendezvous shape, token, randomized socket name, and version;
- `validateLocalBridgeDirectoryPath` — check only the explicitly supplied
  absolute lexical directory path; this result carries no filesystem authority;
- `validateLocalBridgeSocketPath` — require the exact lexical child path formed
  from that companion-directory string and the validated rendezvous socket
  name, then enforce the 103-byte maximum; runtime must separately attest the
  installation root, agent profile, companion directory, and opened socket;
  the installation root is the parent of the isolated `agent` profile, and
  `companion` must be its exact sibling (the default paths are
  `~/.the-last-harness/agent` and `~/.the-last-harness/companion` under
  `~/.the-last-harness`);
- `validateLocalBridgeHandshake` and `parseLocalBridgeHandshakeFrame` — check
  the installation/session scope, source instance, token, capabilities, and
  negotiated version;
- `validateLocalBridgeReplyHandshake`, `parseLocalBridgeReplyHandshakeFrame`,
  and `encodeLocalBridgeReplyHandshakeFrame` — check the separate minor-1
  reply-channel handshake and its active-owner binding fields;
- `validateLocalBridgeReplyFrame`, `parseLocalBridgeReplyFrame`,
  `encodeLocalBridgeReplyFrame`, and `isLocalBridgeReplyExpired` — enforce
  direction, bounded generation/branch/leaf/source-revision target fields,
  fixed receipt/close vocabularies, 2 KiB UTF-8 text, safe multiline/control/format
  validation, leading-Unicode-whitespace slash rejection, relative TTL bounds,
  and exact framing;
- `encodeLengthPrefixedFrame` and `decodeLengthPrefixedFrame` — implement one
  exact u32-big-endian frame with a 256 KiB body cap;
- `parseLocalBridgeDataFrame` — decode a raw producer body as one frozen
  session-mirror/v1 JSON envelope. There is intentionally no local data
  wrapper;
- `validateLocalBridgeResult`, `parseLocalBridgeResultFrame`, and
  `encodeLocalBridgeResultFrame` — keep bridge result controls separately
  bounded and restricted to closed codes.

The state transition helpers are:

- `createLocalBridgeState` — create an empty, open bridge for one installation
  and launch token;
- `acceptLocalBridgeHandshake` — claim, reconnect, or supersede one conversation
  owner while enforcing eight active state slots; dormant admission checks the
  slot before mutation and reserves it immediately;
- `disconnectLocalBridge` — mark the current owner disconnected idempotently;
  dormant records are always disconnected and have empty apply/dedup state;
- `applyLocalBridgeData` — apply one validated raw data frame to the current
  source epoch, reset state on takeover, retain bridge revisions across epochs,
  and require an authoritative first snapshot while reporting exact-byte
  snapshot dedup separately from normative duplicates;
- `acceptLocalBridgeReplyHandshake`, `routeLocalBridgeReply`,
  `settleLocalBridgeReply`, and `closeLocalBridgeReplyChannel` — negotiate and
  bind the separate reply channel, retain only a bounded in-flight marker and
  recent opaque request-ID markers, enforce one-in-flight/idempotency behavior,
  emit no text or identifiers in receipts, and clear channel state on lifecycle
  close;
- `evictIdleLocalBridge` — validate an exact owner/epoch/activity-generation
  token and at least 60 monotonic idle minutes before evicting, retaining
  bounded ownership metadata while dropping apply/dedup state and freeing an
  active slot; stale tokens return `stale-activity` without mutation;
- `teardownLocalBridge` — close channels/state idempotently and make every
  later operation return the exact `{kind: "result", code: "closed"}` result.

Reply requests use relative TTL values from 1 through 60 seconds; equality
with the elapsed receive duration is expired according to
`isLocalBridgeReplyExpired`. Results have only bounded numbers and codes from the
closed result/error sets;
non-`closed` lifecycle/publication results carry a positive `sourceEpoch` and
zero-inclusive `bridgeRevision` within their documented bounds, and `ready`
carries `snapshotRequired`; failures and `closed` carry no metadata. No result
or diagnostic carries source content, identifiers, paths,
socket names, or arbitrary exception text. The returned state is an internal
test transition value and is not a wire result or log record. State retains no
separate raw snapshot or base64 snapshot copy: its dedup marker is only a plain
bounded opaque digest marker, byte length, and revision; normative apply-state
retention remains governed by session-mirror/v1.

The deterministic fixture and contract checks run from the repository root:

```sh
node --test tests/local-bridge-conformance.test.mjs
```

The test covers rendezvous restrictions, u32be framing, raw data bodies,
version negotiation, lexical-only directory/socket checks (including `/tmp`),
installation/session scope, including exact-128 astral outer identity
acceptance, 129-astral and 129-ASCII rejection, and lone-surrogate rejection
across rendezvous, handshake, state, and command paths; same-source reconnect,
source-epoch reset and permanent supersession, one-owner concurrency, eight
active slots plus dormant ownership records, dormant admission and rejection,
activity-generation-safe idle eviction, superseded-history bounds, reused
producer event identities, authoritative snapshot replacement, exact-byte
dedup, malformed and hostile inputs, direct normalization depth/container/
collection limits, positive epoch
and numeric-boundary result frames, v1-derived retained closure for astral
snapshot/event identities and cursors with preserved `-0` revision,
bridge-owned negative-zero rejection, minor-1 reply negotiation and
owner binding, reply frame bounds/expiry/direction/idempotency, safe receipts,
large retained-state normalization,
closed teardown and result round trips, strict manifest projections and
complete manifest bounds, package exclusion, and frozen session-mirror/v1
hashes. `npm pack
--dry-run` must contain neither
`protocol/local-bridge/` nor `protocol/session-mirror/`; both directories are
repository-only contracts and are not imported by packaged observer modules.
