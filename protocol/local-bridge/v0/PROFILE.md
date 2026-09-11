# TLH local-bridge v0 profile

This repository-local profile defines the producer-to-bridge ingress contract for
The Last Harness. It is a contract, fixture, and conformance reference; it is
not a socket server, observer, companion application, authentication service,
or published package resource. The bridge and producer are separate processes
owned by the same macOS user. The profile intentionally stops at the local
ingress boundary.

## Scope and trust boundary

The bridge is scoped to one TLH installation and one or more conversation
sessions for the lifetime of one bridge launch. The installation is the
isolated TLH profile, never the normal user profile. The bridge-owned outer
`installationId` and `sessionId` values are non-empty, well-formed Unicode
scalar sequences: lone UTF-16 surrogates are refused, the maximum is 128
Unicode code points, and an astral scalar counts as one code point. The
existing UTF-8 ceiling is four bytes per permitted code point (512 bytes at
the bound). `installationId` is an opaque bounded identifier for that
installation; it is not a path, account name, host name, or source-content
value. `sessionId` is the opaque `session-mirror/v1` session identity and is
the conversation key for this contract. A bridge key is
`(installationId, sessionId)`.

The local trust boundary is the macOS uid. Restrictive filesystem ownership,
permissions, a per-launch token, and a randomized socket name prevent stale or
accidental endpoint selection and provide channel binding. They do **not**
provide confidentiality or authenticity against another process running as the
same macOS uid; that process can already read the isolated profile's session
files. Device pairing and any remote authentication are separate boundaries.
No HMAC, challenge-response, or per-frame cryptographic authentication is
implied by v0.

The bridge stores accepted state only in memory. It does not write snapshots,
transcripts, cursors, or source identifiers to disk. A bridge restart creates a
new launch token, forgets all ownership and apply state, starts
`bridgeRevision` at zero, and makes no replay or recovery claim. A producer
must perform a new handshake and send an authoritative snapshot after a
restart.

The runtime may invoke the deterministic idle-eviction transition only after
at least 60 monotonic minutes of inactivity. Eviction drops the per-conversation
session-mirror apply state and snapshot dedup marker, retains the owner,
`sourceEpoch`, and superseded-source history, and marks the ownership record
dormant. Dormant records do not consume one of the eight active-state slots.
A successful reconnect or takeover still returns `snapshotRequired: true` and
cannot append an event before a fresh snapshot. The conformance oracle does
not own the timer; the runtime ticket `tlhr-2wqd` supplies that scheduling
behavior.

## Rendezvous discovery

The conventional rendezvous directory is the per-user companion directory
`~/.the-last-harness/companion/`. Runtime derives an installation root as the
parent of the isolated TLH agent profile. With the default layout, the root is
`~/.the-last-harness/`, the agent profile is exactly
`~/.the-last-harness/agent/`, and the companion directory is its exact sibling
`~/.the-last-harness/companion/`. The runtime must derive both children from
that one root; it must not read or modify `~/.pi/agent`, scan arbitrary
temporary directories, scan process arguments, use a port range, use LAN
discovery, or accept an endpoint from an untrusted network source. The exact
file is `rendezvous.json`; absence is a normal unavailable-bridge result.

Before using the derived paths, runtime attestation is mandatory. Runtime
checks the root, agent, companion, rendezvous file, and socket component by
component with `lstat` and open-file identity checks: symlinks,
non-directories, unexpected owners, group/other writable modes, paths escaping
the installation root, and a changed identity between check and open are
refused. The bridge creates the companion directory with mode `0700`, owned by
the current uid. It writes a regular `rendezvous.json` with mode `0600`, owned
by that uid, and replaces it atomically only while the listener is quiescent.
The socket is also a uid-owned `0600` Unix-domain socket in that directory.
Teardown closes live channels and the listener before unlinking the socket and
rendezvous file; deleting the files alone does not revoke an already-open
channel.

The rendezvous JSON has exactly this shape and is bounded by
`maxRendezvousBytes`:

```json
{
  "protocol": {
    "family": "local-bridge",
    "major": 0,
    "minor": 0
  },
  "installationId": "opaque-installation-id",
  "socketName": "mirror-0123456789abcdef01234567.sock",
  "launchToken": "0123456789abcdef0123456789abcdef"
}
```

`socketName` is generated with a cryptographically secure random source for
each bridge launch. Its v0 spelling is exactly `mirror-` followed by 24
lowercase hexadecimal characters and `.sock`; it is not user-configurable.
The producer derives the companion directory from the installation root, then
joins this name to that directory. The conformance path helpers perform only
lexical checks: the directory helper accepts a plain absolute path, and the
socket helper accepts exactly `<companionDirectory>/<rendezvous.socketName>`.
They do not return or consume filesystem-attestation evidence. Thus `/tmp` can
be a lexically valid directory input and `/tmp/<socketName>` can be a lexical
child, but runtime must not use either unless its derived installation root,
agent, companion, and open socket have passed mandatory attestation. A path
with a different parent, a traversal component, or a non-random socket name is
refused by the relevant runtime or lexical check. The resulting UTF-8 socket
path must be at most 103 bytes; 104 bytes or more is refused to leave room for
the macOS `sun_path` terminating byte. Absolute paths supplied to a boundary
checker must contain no empty interior component, `.` component, `..`
component, or NUL.

`launchToken` is 32 lowercase hexadecimal characters (128 random bits),
created afresh for every bridge launch and copied from the validated
rendezvous into the producer handshake. It binds the producer to that bridge
instance and makes stale rendezvous records fail closed. It is a capability,
not proof of peer authenticity within the same uid.

## Framing

Every wire frame is one unsigned 32-bit big-endian length prefix followed by
exactly that many body bytes. The prefix is not included in the body length.
A frame body is at most 262,144 bytes (`256 KiB`), including the complete
post-handshake producer data body. A decoder rejects a short prefix, a
truncated body, trailing bytes after a complete frame, or a declared body
larger than the bound. It never searches for a later prefix or resynchronizes
inside a malformed stream; the connection is closed with a closed aggregate
code. Partial reads are accumulated only up to the bound and are not exposed
as application state.

Handshake and result bodies have the stricter independent bound
`maxControlFrameBytes` of 4,096 bytes. The rendezvous JSON has its own
4,096-byte bound. Direct rendezvous, handshake, and result values are
normalized with separate 4 KiB-class byte, depth, container, and collection
limits; array lengths and own-key counts are checked before child traversal
where JavaScript reflection permits. Retained bridge state uses the larger
formula-derived normalization budget needed for bounded session-mirror apply
state. These limits bound the oracle's traversal and retained output, not
allocations that the JavaScript engine may perform while reflecting on hostile
objects or proxies. Invalid UTF-8, invalid JSON, and hostile object shapes are
rejected without throwing or including values in diagnostics. During retained
state re-normalization, nested `sessionMirrorState` and `lastSnapshotRevision`
fields derived from session-mirror/v1 remain governed by the frozen v1
Unicode code-point identity/cursor and string semantics and number rules; the
outer well-formed-scalar rule above does not reinterpret or change those retained
values. A v1-emitted revision `-0` is preserved. Separately, bridge-owned
unsigned counters reject numeric negative zero (`-0`); that numeric rule is
independent of outer identity validation.

The first producer-to-bridge frame is a bounded JSON `hello` control frame.
After a successful handshake, a producer-to-bridge data frame is **the raw
UTF-8 bytes of one `session-mirror/v1` JSON envelope**. It is not wrapped in
`{"kind":"data", "payload": ...}` or any other local-bridge object. The
producer-to-bridge direction and ready connection phase provide the data
message kind, so the envelope bytes can use the complete 256 KiB body budget.
A bridge-to-producer control frame is a bounded JSON `result` object. No
source-content value, path, socket name, identifier, or arbitrary error text
is included in a result or diagnostic.

The result frame shape is:

```json
{
  "kind": "result",
  "code": "accepted",
  "bridgeRevision": 1,
  "sourceEpoch": 1
}
```

Only the closed result and failure code sets in the conformance module may be
used for `code`. `ready`, `disconnected`, `accepted`, `duplicate`,
`deduplicated`, and `evicted` require both bounded `bridgeRevision` and
`sourceEpoch`; `ready` additionally requires boolean `snapshotRequired`.
Failure codes and `closed` carry only `kind` and `code`. `snapshotRequired` is
not accepted on other result codes. `bridgeRevision` is zero-inclusive, while
non-closed result `sourceEpoch` values are positive; both are bounded safe
integers.

## Version and handshake

A hello has exactly these members:

```json
{
  "kind": "hello",
  "protocol": {
    "family": "local-bridge",
    "major": 0,
    "minor": 0
  },
  "installationId": "opaque-installation-id",
  "sessionId": "opaque-session-id",
  "sourceInstanceId": "0123456789abcdef0123456789abcdef",
  "launchToken": "0123456789abcdef0123456789abcdef",
  "capabilities": ["snapshot-replace", "cursor-recovery"]
}
```

The bridge accepts only family `local-bridge`, major `0`, and a minor version
no greater than its supported minor. A different family, unsupported major,
or unsupported future minor is `incompatible-protocol`; the connection is
closed and no data is accepted. Required capabilities are an ordered prefix:
`snapshot-replace`, then `cursor-recovery`. A syntactically valid list that is
missing, reordered, or duplicates a required capability produces
`incompatible-capability`; a malformed list value produces `malformed-frame`.
Unknown optional capabilities do not authorize behavior.

The outer identity rule is applied at rendezvous/configuration, hello,
ownership-state, and command boundaries; an over-bound or ill-formed value
fails closed before scope or ownership state can change. `installationId` must
match the bridge's configured isolated installation. `launchToken` must match
the current rendezvous exactly. `sessionId` binds the connection to one
conversation and every later session-mirror envelope must carry the same value.
`sourceInstanceId` is a fresh, random, bounded identity
minted once for one TLH process. It remains stable across reconnects from that
process and is not regenerated for each publication. A later TLH process must
mint a different source instance even when it resumes the same persisted
session and reuses producer-local event IDs.

The bridge sends a `ready` result only after all checks pass. It does not infer
installation or session scope from paths, socket names, source metadata, or
message content.

## Ownership, epochs, and reconnect

There is at most one connected owner for a `(installationId, sessionId)` key.
Each known key has a bridge-local `sourceEpoch` beginning at 1 and a bounded
`activityGeneration` counter. A new source epoch starts its counter at zero;
accepted reconnects, the first disconnect, and accepted, duplicate, or
exact-byte-deduplicated data activity increment it. At most eight known keys
may retain active apply state at once; at most 64 ownership records are
retained overall. The bridge retains one bounded apply state and one bounded
digest-plus-length snapshot dedup marker for each active key, and at most 64
superseded source IDs per key.

The transitions are deliberately asymmetric:

1. **Initial claim.** If no key exists and a concurrency slot is available,
   the hello's source becomes the owner at epoch 1 with a fresh initial
   session-mirror apply state.
2. **Concurrent claim.** A different source while the current owner is
   connected is refused with `busy`; neither source state nor
   `bridgeRevision` changes. A second simultaneous connection from the same
   source is also refused with `busy`.
3. **Same-source reconnect.** After the current source disconnects, the same
   `sourceInstanceId` may reconnect. It retains its source epoch, session-
   mirror apply state, and dedup marker. It may continue its current source
   sequence without replaying an initial event as a conflict.
4. **Takeover.** After the current source disconnects, a different source may
   take over the same key. The bridge increments `sourceEpoch`, replaces the
   owner, clears the prior apply state and dedup marker, and starts from a
   fresh initial state. The bridge-owned revision does not reset.
5. **Permanent supersession.** A source that was replaced is recorded as
   superseded for the rest of the bridge lifetime. It can never reclaim the
   key, even if the replacement later disconnects. A reconnect or publication
   from it is refused with `stale-source`, before it can affect state. This
   rule prevents an old asynchronous completion or a delayed socket from
   overwriting a newer owner.
6. **Unknown source.** A source that is neither the current owner nor a
   permitted post-disconnect claimant is refused with a closed ownership code.

A disconnect is scoped to the current owner and is idempotent. It marks the
owner disconnected while retaining its epoch and apply state for a possible
same-source reconnect and increments `activityGeneration` only on the first
disconnect. It does not increment `bridgeRevision`. Idle eviction is the only
non-teardown way to drop apply state: it retains the ownership record, owner,
epoch, generation, and superseded IDs while making it dormant. `dormant` means
exactly disconnected, empty apply/dedup state, and no consumed active slot.
The state boundary rejects `dormant: true` with `connected: true`.

A dormant reconnect or takeover must check active-slot availability before any
ownership mutation. If all eight slots are occupied it returns `busy` and
preserves the old owner and superseded history. If admitted, the handshake
immediately changes the record to `dormant: false` and reserves the slot;
its next data publication must be a snapshot. A same-source admission
increments `activityGeneration`; a takeover starts the new source epoch's
generation at zero.

The bridge permits at most eight active conversation states and at most 64
known ownership records. A new key when all eight active slots are occupied,
or when the 64-record metadata cap is reached, receives `busy`; no record is
evicted silently. A takeover whose superseded-source history already has 64
IDs receives `source-history-full`. Reuse of a disconnected or dormant key is
a takeover or reconnect and does not consume a new known-record slot.

## Applying session-mirror data

The data body is decoded as UTF-8 and validated as an `unknown` value by the
frozen `session-mirror/v1` conformance boundary. The bridge does not assert a
parsed shape, invoke getters, retain caller prototypes, or surface source
values in errors. A valid envelope whose `sessionId` differs from the hello
scope is refused with `session-mismatch`.

`session-mirror/v1` apply state is scoped to the current source epoch. This is
required because producer-local identifiers such as `g1-e1` may recur when a
new TLH process starts. A sequential replacement source that sends the same
source event identity is therefore accepted in its fresh epoch and receives a
new bridge revision; it is not classified as a v1 conflicting duplicate from
the old epoch. Within one epoch, v1 duplicate and conflicting-duplicate rules
remain in force. The first publication in every new epoch must be an
authoritative snapshot; an incremental event before that snapshot is refused
as a revision gap because v0 makes no replay claim.

A snapshot with `operation: "replace"` is authoritative for the current
source epoch. It replaces the mirrored session state; the bridge never merges
branches or invents missing entries. `cursor-recovery` is a wire capability
only. It does not promise that this local bridge replays a cursor, retains an
old epoch, or recovers data after restart. A reconnect or takeover is made
safe by sending a fresh authoritative snapshot.

`bridgeRevision` is owned by the bridge. It starts at zero for a bridge
launch, increments by exactly one for each newly accepted nonduplicate data
publication across all keys and source epochs, and never decreases during
that launch. Duplicate, exact-byte deduplicated, invalid, stale, and rejected
publications do not increment it. Restarting the bridge starts a new revision
sequence and makes no continuity claim.

Exact-byte-identical snapshot deduplication is an optimization only. The
bridge may skip an immediately repeated snapshot when its complete frame body
has the same SHA-256 digest and byte length and the current epoch has not
advanced its apply state; it returns `deduplicated` without bumping
`bridgeRevision`. The marker is a bounded plain SHA-256 digest and byte length,
never an HMAC and never an authentication mechanism. This optimization must be
scoped to the current source epoch and must not replace authoritative snapshot
application. JSON objects that are semantically equal but have different bytes
are **not** exact-byte dedup hits. They still go through the normative v1
duplicate/application rules. A semantically equal snapshot with a new source
event identity is accepted normally and bumps the bridge revision.

Accepted data results expose only a closed outcome (`accepted`, `duplicate`,
or `deduplicated`) plus bounded `bridgeRevision` and `sourceEpoch`. Mapped v1
failures use only closed aggregate local-bridge codes such as
`session-mirror-bounds`, `session-mirror-invalid`,
`session-mirror-duplicate-conflict`, or `session-mirror-revision-gap`.
Diagnostics never include prompt text, assistant text, tool data, JSON values,
paths, socket names, source identifiers, or arbitrary exception messages.

Idle eviction is a deterministic command containing exactly `sessionId`, the
current `sourceInstanceId`, `sourceEpoch`, captured `activityGeneration`, and
`elapsedMonotonicMinutes` of at least 60. The bridge rejects a superseded or
wrong owner before mutation; an owner/epoch or owner/generation mismatch is
`stale-activity`. An exact current token may evict either a connected or
already-disconnected owner. Runtime code must atomically close that owner's
channel while applying an eviction; the evicted process must re-handshake and
then receives `snapshotRequired: true`.

## Teardown and failure behavior

Teardown is one ordered, idempotent operation: stop accepting connections,
close every live channel, unlink the socket and rendezvous artifacts, and
drop all in-memory ownership, apply, dedup, and snapshot state. Both the first
and repeated operation return exactly `{kind: "result", code: "closed"}` with
no revision or epoch metadata and do not throw. Any operation against a closed
bridge returns the closed aggregate code and cannot recreate state. A later
bridge launch has a new token and empty memory.

All boundary and lifecycle failures map to a closed set of codes exported by
`conformance.ts`. `handshake-required` and `wrong-direction` are closed,
runtime-only connection-phase codes: the pure oracle does not invent a fake
parser path solely to return them. A caller must treat unknown codes as
failure and must not serialize an exception or a peer payload into a log. The
contract is fail-closed at the bridge boundary and fail-open for the TLH
producer: a missing or rejecting bridge must not interrupt the terminal
session.
