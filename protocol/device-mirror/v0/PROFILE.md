# TLH device-mirror v0 profile

This document defines the repository-local, synthetic **device-mirror** contract
for version 0. It is a protocol and conformance reference only. It does not
open a listener, configure Network.framework, inspect Tailscale, observe a
session, persist a snapshot, or provide an iOS UI.

## Scope and trust boundary

The device mirror is a read-only, foreground live view. The Mac-side producer
remains the sole durable authority for a conversation. A producer hands a
validated whole `session-mirror/v1` snapshot to an in-memory egress owner under
an opaque handle minted for that egress launch. The handle is not a session ID,
source ID, path, host name, account name, or timestamp. Handles are never
serialized to logs or durable storage.

At most eight handles and one complete snapshot per handle are retained. A
replacement is authoritative: it replaces the prior snapshot as a whole. The
mirror never merges trees, applies events, reconstructs missing entries, or
interprets fields inside the frozen v1 envelope. The v1 envelope can contain
opaque or encrypted source identifiers; this profile validates it at the v1
boundary and treats it as payload bytes after that point.

There is no transcript persistence, cache, replay journal, resume claim, or
background synchronization. Device disconnect and iOS backgrounding clear the
live view immediately. Listener stop clears all handles and closes the current
channel. A refused, unavailable, or stopped listener does not trigger LAN,
DNS, loopback, relay, wildcard, or plaintext fallback.

The TLS-PSK key authenticates the intended paired channel and TLS supplies
confidentiality and integrity. A process running as the same macOS uid that can
read the local pairing material remains in the trust boundary; TLS-PSK is not a
same-uid process isolation mechanism. Pairing material, device identity, port,
configuration, and any local address are injected at runtime and are not part
of this corpus.

## Transport and address policy

The channel is **Network.framework TLS-PSK**. The operating system TLS stack is
the authenticated encrypted channel. v0 defines no HMAC, challenge-response,
HKDF, AEAD, certificate replacement, nonce format, custom key exchange, or
application-layer cryptography. Application frames are unavailable until TLS
has established; a failed handshake is a closed connection, not a plaintext
attempt.

The client and listener accept only a literal dotted-decimal IPv4 address in
`100.64.0.0/10`, the CGNAT range conventionally used for Tailscale reachability.
A hostname, DNS result, IPv6 literal, wildcard, loopback, LAN address, or
whitespace-padded spelling is invalid. The address is reachability input only;
v0 performs no Tailscale discovery or health check and makes no claim that
Tailscale is installed.

Before an exact-address bind, the listener receives an injected interface table
of at most 256 records, with at most 64 addresses per record. Exceeding either
interface-table collection cap invalidates the entire table before child-address
traversal or matching; an oversized record is never skipped. It must find the
configured address on an active `utun` interface and bind exactly that address.
Missing, inactive, non-`utun`, or mismatching interface records fail closed. The
conformance oracle does not enumerate interfaces or bind a socket;
`validateDeviceMirrorListenerAddress` tests the decision using synthetic input.

## Framing and direction

After TLS, each frame is one unsigned 32-bit big-endian body length followed by
exactly that many UTF-8 JSON bytes as sent on the wire. The prefix is not
included in the body length. Body limits are measured over the raw wire bytes
as sent, before parsing or reserialization. For the outer DeviceMirror frame,
canonical compact JSON means the profile's validated shape serialized with `,`
and `:` separators, no insignificant whitespace, minimal RFC-required escaping
(quotation mark, reverse solidus, and U+0000 through U+001F, using the shortest
named escape where available), literal non-ASCII characters in well-formed
outer Unicode scalar strings, no slash escaping, and the shortest decimal form
for integers (`0` rather than `-0`, with no leading zeroes or exponent).
Unpaired surrogates are accepted only inside the frozen session-mirror/v1
envelope; when present, raw/canonical v1 JSON emits that code unit as a
`\uXXXX` escape. This does not require Swift to materialize an invalid nested
string outside that raw/canonical v1 handling. The frozen session-mirror/v1
envelope remains capped at 256 KiB. Under this canonical serialization, the worst-case snapshot
device frame has a 262,983-byte body
bound: 262,144 bytes for the v1 envelope plus an 839-byte wrapper allowance.
The allowance is the explicit sum of the canonical JSON bytes for
`{"kind":"snapshot","handle":`, a worst-case `2 + (128 * 6)`-byte JSON
handle, `,"revision":`, the decimal maximum revision, `,"snapshot":`, and `}`.
Hello, list, ready, dropped, close, and error frames retain the independent
16 KiB control bound. A short prefix, truncated body,
trailing bytes, invalid UTF-8, invalid JSON, oversized body, cycle, accessor,
prototype, symbol, hole, or non-JSON primitive is rejected without
resynchronizing or throwing.

Direction is part of the boundary. The client may send only:

```json
{
  "kind": "hello",
  "protocol": { "family": "device-mirror", "major": 0, "minor": 0 },
  "capabilities": ["list", "subscribe", "snapshot-replace"]
}
```

and the request shapes:

```json
{ "kind": "list", "requestId": "opaque-request" }
{ "kind": "subscribe", "requestId": "opaque-request", "handle": "opaque-handle" }
```

The listener may send only these closed shapes:

```json
{
  "kind": "ready",
  "protocol": { "family": "device-mirror", "major": 0, "minor": 0 },
  "capabilities": ["list", "subscribe", "snapshot-replace"]
}

{
  "kind": "list",
  "requestId": "opaque-request",
  "conversations": [
    { "handle": "opaque-handle", "status": "idle", "freshness": "fresh" }
  ]
}

{
  "kind": "snapshot",
  "handle": "opaque-handle",
  "revision": 1,
  "snapshot": "one validated session-mirror/v1 envelope"
}

{ "kind": "dropped", "handle": "opaque-handle", "reason": "eviction" }
{ "kind": "close", "reason": "listener-stop" }
{ "kind": "error", "code": "unknown-handle" }
```

The quoted snapshot value above is explanatory notation; on the wire it is the
complete JSON object accepted by the frozen session-mirror/v1 conformance
boundary. No outer device-mirror shape has a source ID, session ID, prompt,
transcript text, path, address, key, or arbitrary diagnostic field. The nested
v1 envelope is the intentionally opaque payload exception and is never
interpreted, displayed, logged, or persisted by this boundary. Errors use only
the fixed vocabulary exported by `conformance.ts`.

The profile accepts v0 and minor `0` only. A different family, major, or future
minor is `incompatible-protocol`. Required capabilities are an ordered prefix;
missing, reordered, or duplicate required names are
`incompatible-capability`. Unknown valid capability names may be retained for
forwarding but authorize no behavior.

## Listings and snapshots

A listing contains only an opaque per-launch handle, one coarse status from
`idle`, `active`, `waiting`, `error`, or `unknown`, and one coarse freshness
value from `fresh`, `stale`, or `unknown`. It carries no title, provider,
project, host, source, message, timestamp, or path. At most eight entries are
returned.

A subscription identifies one listed handle. The listener sends the complete
currently retained snapshot, not a delta. The nested value must be a valid
`session-mirror/v1` envelope whose message is an authoritative `snapshot` with
`operation: "replace"`. The outer device revision is a bounded, monotonically
increasing replacement revision. At this boundary, JavaScript numeric `-0` is
accepted as the inclusive zero value and canonicalized to ordinary `0`; this
rule applies only to the outer device revision. Nested revisions retain the
frozen `session-mirror/v1` semantics and are not changed by this profile. A
revision equal to or below the retained revision is stale and cannot mutate
state. A newer revision replaces the whole retained value and may coalesce an
older unsent replacement; no merge or replay is implied.

## Drop and lifecycle semantics

The in-memory egress applies these transitions synchronously and idempotently:

- producer disconnect removes that handle immediately;
- producer takeover/new source epoch removes the old handle immediately;
- an accepted producer event removes and delists that handle immediately because
  the whole snapshot is no longer known to be current;
- eviction removes the handle immediately;
- listener stop sends the fixed `close` evidence when possible, then clears
  every handle and refuses later operations;
- device disconnect clears the live device subscription and every retained
  handle; a later connection starts with an empty live view;
- iOS backgrounding clears the live device view and uses no background mode,
  push, cache, or state restoration.

When a removed handle was subscribed and a device channel is still connected,
the listener may send exactly one `dropped` frame with the fixed reason. If the
channel is already gone, there is no deferred notification. Drop evidence never
contains a source value. A new whole snapshot may create the handle again only
through a later producer handoff in the same live launch; a fresh launch starts
empty.

## Fixed bounds and evidence

The prototype limits are intentionally conservative guardrails:

- one u32-BE device-frame body: 262,983 bytes, composed of the frozen
  262,144-byte v1 envelope ceiling plus the 839-byte snapshot wrapper
  allowance for the worst-case canonical compact JSON serialization; raw wire
  bytes are measured as sent;
- control body: 16 KiB;
- eight listing/retained handles;
- 256 injected interface records and 64 addresses per record;
- outer normalized strings must be well-formed Unicode scalar sequences;
  128 Unicode scalar values per handle and 64 per request ID (valid astral
  scalars count as one; unpaired UTF-16 surrogates are rejected);
- 16 capabilities per hello;
- revisions from zero through `Number.MAX_SAFE_INTEGER - 1`;
- defensive frame normalization depth 528, 12,048 containers, and 1.25 MiB of
  normalization budget; these are the frozen v1 limits plus bounded device-frame
  overhead. State re-normalization allows 82,048 containers and 8.25 MiB for
  eight legal v1 snapshots plus bounded state metadata.

The only externally observable evidence is a closed result or one of the fixed
`ready`, `list`, `snapshot`, `dropped`, `close`, and `error` shapes. Diagnostics
never echo input keys, values, handles, request IDs, snapshot contents,
addresses, interface names, or exception text. The state helper is a
repository-only deterministic oracle; its snapshot field represents transient
in-memory test state, not persistence or a logging recommendation.

## Frozen dependency

The nested snapshot is validated by the existing `session-mirror/v1`
conformance boundary. Its profile, manifest, conformance text, and conformance
source hashes are recorded in `manifest.json`. This profile does not import,
modify, or extend `local-bridge/v0`; producer handoff and transport remain
separate future boundaries. The v1 files are frozen byte-for-byte for this
contract.

## Synthetic corpus boundary

The fixture JSON files contain only protocol vocabulary, bounded synthetic
handles/request IDs, transition labels, and the single CGNAT example used for
address policy. They contain no real hosts, device identities, secrets, paths,
session IDs, source identifiers, or transcript data. Tests construct a minimal
synthetic empty v1 snapshot in memory when exercising nested validation.
