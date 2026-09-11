# Device-mirror v0 conformance

[`conformance.ts`](./conformance.ts) is a repository-only oracle. It accepts
external values as `unknown`, performs bounded accessor/cycle/prototype-safe
normalization, and returns closed error codes without opening Network.framework,
checking Tailscale, binding an address, handling a TLS key, or persisting a
snapshot.

The exported contract values are:

- `DEVICE_MIRROR_PROTOCOL` and `DEVICE_MIRROR_CAPABILITIES` — v0 version and
  required capability prefix;
- `DEVICE_MIRROR_TRANSPORT` — the documented Network.framework TLS-PSK choice;
  it deliberately exposes no key or cryptographic implementation;
- `DEVICE_MIRROR_BOUNDS` — frame, control, interface-table, listing, identity,
  revision, and defensive frame and retained-state normalization limits,
  including the frozen v1-derived container, depth, and byte budgets plus
  device overhead. `maxFrameBodyBytes` is explicitly the frozen
  `maxSessionMirrorEnvelopeBytes` plus `maxSnapshotFrameWrapperBytes`; the
  control-frame bound remains independent;
- `DEVICE_MIRROR_LISTING_STATUSES`,
  `DEVICE_MIRROR_LISTING_FRESHNESS`, `DEVICE_MIRROR_DROP_REASONS`, and
  `DEVICE_MIRROR_CLOSE_REASONS` — fixed evidence vocabularies;
- `DEVICE_MIRROR_ERROR_CODES` and `DEVICE_MIRROR_WIRE_ERROR_CODES` — the
  closed diagnostic and listener-error sets.

The boundary functions are:

- `validateDeviceMirrorAddress` and
  `validateDeviceMirrorListenerAddress` — accept only literal
  `100.64.0.0/10` IPv4; the listener variant applies both interface-table
  collection caps before child-address traversal or matching, invalidating the
  entire table when either cap is exceeded rather than skipping an oversized
  record, and otherwise requires the exact address on an injected active
  `utun` record;
- `validateDeviceMirrorFrame` — validate a parsed value for an explicit client
  or listener direction; the outer device snapshot `revision` accepts numeric
  `-0` at the inclusive zero bound and canonicalizes it to `0`, while nested
  revision semantics remain inherited from frozen `session-mirror/v1`;

Outer DeviceMirror normalized strings—including capability inputs, handles, and
request IDs—must be well-formed Unicode scalar sequences; valid astral scalars
remain valid, while unpaired UTF-16 surrogates fail closed. Capability names
remain ASCII-only values under their existing closed kebab-case grammar and
required prefix; this vocabulary rule is separate from scalar well-formedness. The outer rule does not change the frozen
nested session-mirror/v1 interpretation or require Swift to materialize an
invalid nested string outside raw/canonical v1 handling.

- `encodeDeviceMirrorLengthPrefixedFrame`,
  `decodeDeviceMirrorLengthPrefixedFrame`, `encodeDeviceMirrorFrame`, and
  `parseDeviceMirrorFrame` — enforce exact u32-BE framing, UTF-8, JSON, and
  per-kind bounds;
- `validateDeviceMirrorFrame`'s listener snapshot branch — revalidates the
  complete nested object through the frozen session-mirror/v1 boundary and
  accepts only its authoritative snapshot replacement shape;
- `createDeviceMirrorState`, `acceptDeviceMirrorHello`,
  `requestDeviceMirrorList`, `subscribeDeviceMirrorHandle`, and
  `replaceDeviceMirrorSnapshot` — model the bounded foreground listener state;
- `dropDeviceMirrorSnapshot`, `disconnectDeviceMirrorProducer`,
  `takeoverDeviceMirrorProducer`, `markDeviceMirrorAcceptedEvent`,
  `evictDeviceMirrorSnapshot`, `disconnectDeviceMirrorClient`,
  `backgroundDeviceMirrorClient`, and `stopDeviceMirrorListener` — model the
  immediate, idempotent drop/stop transitions.

The transition helper returns only a closed outcome code and listener frames.
Its returned state is deterministic test state and is not a wire result, log
record, or persistence API. It stores at most one validated whole snapshot per
opaque handle. A newer replacement supersedes the complete prior value;
non-increasing revisions are `stale-snapshot`. A drop removes and delists
the complete value immediately. A subscribed handle receives one bounded `dropped` frame
when the device channel remains connected; no notification is queued after a
channel disconnect or backgrounding.

Run the focused conformance test from the repository root:

```sh
node --test tests/device-mirror-conformance.test.mjs
```

Applicable focused static checks are:

```sh
npx oxfmt --check protocol/device-mirror/v0 tests/device-mirror-conformance.test.mjs
npx oxlint --deny-warnings protocol/device-mirror/v0 tests/device-mirror-conformance.test.mjs
npx tsc --noEmit
```

The full `npm run validate` pass is intentionally deferred to the final-
validation ticket. The fixture manifest also records byte hashes for the four
normative session-mirror/v1 files and does not record or modify local-bridge/v0.
