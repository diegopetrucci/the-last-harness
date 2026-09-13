# TLH companion roadmap

This is the canonical, tracked planning record for the TLH companion reader. It
consolidates the former root plan, the iOS product plan, the Phase 0A
readiness review, the follow-up live-path review, the Mac architecture record,
and the approved constraints that reconcile them. The review artifacts used for
that consolidation are read-only, non-durable inputs; this document does not
replace or edit them.

Evidence in this document is durable by design. A source claim names a tracked
path and symbol, or the row records itself as canonical dated evidence. No
ignored artifact, removed planning document, sibling worktree, or unpinned
local path is required to understand a row or its closure check.

The roadmap contains no live credentials, pairing values, personal or Apple
identifiers, private endpoints, home-directory paths, transcript text, or raw
framework output. Examples below are capability descriptions, not wire data.

## Current status

| Area                                   | Status                                                    | Meaning                                                                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 0A                               | **Complete**                                              | The approved Phase 0A gate is closed. The post-review findings below are follow-on work, not a reopening of 0A.                                                                                                                      |
| Physical direct path                   | **Proven**                                                | Canonical evidence recorded on 2026-09-13 records TLS-PSK-authenticated delivery of a bounded snapshot to physical iOS hardware over Tailscale reachability. This proves feasibility, not production readiness or route enforcement. |
| Installed Mac composition              | **Observed in the current worktree; clean proof pending** | Canonical evidence recorded on 2026-09-13 records visible-app wiring of the local bridge handoff to device egress with explicit ordering. A clean, exact-revision, reproducible proof remains a validation task.                     |
| TLH hook/snapshot seam                 | **Implemented and validated**                             | Tracked observer lifecycle hooks and the authoritative snapshot projection are implemented and covered by the repository's observer/projection tests. Only compatibility with a future upstream runtime version remains open.        |
| Post-0A basic usability                | **Current**                                               | The narrow current slice is connection-profile-only protected persistence and one-shot foreground lifecycle reconnect on iOS, with safe state retirement, full-snapshot subscription, and navigation reset.                          |
| Prototype platform baseline            | **macOS 26/iOS 26 only**                                  | The prototype evidence is limited to those current platform baselines. Expansion to older OS versions is deferred until a later compatibility gate.                                                                                  |
| Mac launch configuration               | **Deferred**                                              | A stable Mac-side address, port, and pairing configuration for lifecycle/login launches is not part of the current slice. Re-pairing after a Mac process configuration change remains possible.                                      |
| Full transcript persistence            | **Prohibited**                                            | The Mac's existing isolated session store remains the sole durable full-transcript authority. Companion, phone, Keychain, server, notification, and evidence storage must not become a second transcript.                            |
| TLH producer retry and background sync | **Not approved**                                          | Producer publication remains marker-driven, bounded, asynchronous, and fail-open. No timer-driven retry, automatic producer reconnect loop, or background synchronization is added.                                                  |
| Original Swift/package/target caps     | **Superseded**                                            | The former hard package, target, and Swift line ceilings are not roadmap gates. Cohesion, safety, bounded runtime behavior, tests, and evidence are the review criteria.                                                             |
| Phase 0B                               | **Deferred**                                              | Persistent helper behavior, APNs/background delivery, encrypted previews, and interruption recovery require the Phase 0B entry gate.                                                                                                 |

## Status labels and terminology

- **Complete** means the approved gate has evidence sufficient to move on. It
  does not mean every later hardening item is finished.
- **Current** means included in the narrow post-0A slice described here.
- **Deferred** means intentionally out of the affected phase and requiring a
  later gate; it is not silently implied by a scaffold or a login item.
- **Accepted** means a review observation or constraint is retained as an
  actionable fact or policy.
- **Downgraded/rejected** means a review claim is not accepted as a defect,
  usually because an approved constraint or stronger evidence supersedes it.
- **Unverified** means the observation or its proposed closure still needs an
  explicit check. It must not be presented as either fixed or blocking without
  that check.
- **Login-scoped availability** means an explicitly approved visible main app
  may be eligible to launch at a later user login. It is not process
  persistence, crash supervision, durable recovery, or background sync.
- **Persistent helper behavior** is the separately gated Phase 0B property of
  surviving the required lifecycle interruptions with measured recovery and
  resource bounds.

## Product goals and non-goals

### Goals

1. Let a user check useful completed TLH work away from the terminal without
   changing ordinary terminal launch or operation.
2. Preserve session-tree, active-branch, lineage, compaction, and recovery
   semantics instead of presenting a lossy flat chat.
3. Keep the terminal path nonblocking and fail-open when the companion is
   absent, slow, disconnected, malformed, or broken.
4. Establish explicit application pairing, bounded data handling, profile
   confinement, and privacy-preserving transport before production services.
5. Use genuine sessions to test whether read-only checks are useful before
   investing in persistent helpers, APNs, or a server.
6. Leave an additive path for separately authorized replies and an encrypted
   relay without making either a hidden prerequisite for the reader.

### Non-goals for Phase 0, the current slice, and the initial reader

- Token, character, delta, or partial assistant streaming. The first reader
  shows completed assistant turns and optional coarse working/idle state only.
- Prompts, replies, steering, follow-up, abort, tool approval, branch creation,
  terminal control, file mutation, or any other iOS-originated command.
- Attaching to an arbitrary running terminal through stdin/stdout, terminal
  scraping, or session-file tailing. A headless RPC/SDK product would be a
  separately approved product variant.
- Durable full-transcript storage on a server, Mac companion cache, phone
  cache, settings store, Keychain, URL cache, logs, diagnostics, or evidence.
  A later encrypted offline projection requires a separate decision.
- Multi-user tenancy, account sharing, attachments, rich notification
  grouping, a general-purpose relay, production availability, or store
  submission.
- Treating APNs as reliable delivery, synchronization, authorization, or
  command transport; or treating Tailscale as application identity.
- A stable Mac-side launch profile in the current slice. The Mac's process
  configuration may still require explicit setup or re-pairing.
- Automatic producer retry, timer-driven publication, indefinite sockets,
  background networking, or background synchronization.
- Modification of the normal TLH profile. The observer is permitted only for
  the explicitly selected isolated profile.

## Approved decisions and reconciliations

These decisions are authoritative when older planning text conflicts with them.

| Decision            | Current rule                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase status        | Phase 0A is complete. Post-0A basics are the next slice and do not reopen the desirability gate.                                                                                                                                                   |
| Source session      | Use an ordinary terminal-started TLH session. Do not require a special launch command or replace the terminal with a mobile-owned process.                                                                                                         |
| Session cardinality | One persisted source session maps to one mobile conversation. In-place branches stay in that conversation; a fork or clone has a new opaque lineage. Ephemeral/no-session runs remain out of Phase 0.                                              |
| Authority           | The Mac/session source is authoritative. A phone view, cache, push, or local event is a view or hint, never a competing writer.                                                                                                                    |
| Completion          | Publish a turn only after final content is available and the source state is settled or persisted. Partial and delta events are not completed turns.                                                                                               |
| Physical transport  | The current direct path uses TLS-PSK pairing over Tailscale reachability. Tailscale remains reachability only; application pairing and authorization remain mandatory. The separate public-preview-key design is deferred with encrypted previews. |
| Local trust         | Phase 0A source ingress trusts the same macOS user account. File permissions and rendezvous checks make the boundary explicit but are not cryptographic authentication against another same-user process.                                          |
| Privacy             | No plaintext transcript crosses a server or APNs. Remote notifications remain generic until separately approved per-device encrypted previews are proven.                                                                                          |
| Persistence         | The only currently approved companion persistence is one bounded, protected iOS connection profile in Keychain. No transcript, listing, handle, selected conversation, cursor, revision, envelope, or rendered turn is persisted.                  |
| Reconnect           | The current foreground reconnect creates an authoritative full-snapshot subscription. It persists no cursor and performs no event replay; retained replay is a Phase 0B/later target only.                                                         |
| Mac lifecycle       | A visible development-signed `LSUIElement` main app with opt-in `SMAppService.mainApp` registration is the Phase 0A shape. Hidden helpers, raw launch-agent registration, privileged services, and silent registration are not.                    |
| Egress composition  | The former source-ingress-only prohibition is superseded for the current worktree composition: the visible app may own the bounded development device-egress handoff. APNs, server relay, replies, and terminal control remain out of scope.       |
| Code-size policy    | Former hard package, target, Swift LOC, and similar line-count gates are superseded and intentionally omitted as acceptance criteria. Runtime bounds and maintainability remain mandatory.                                                         |
| Producer behavior   | The TLH producer stays marker-driven and fail-open. A failed publication may remain dirty until a later lifecycle marker or explicit snapshot request; no automatic retry or background sync is inferred.                                          |
| Mac configuration   | Stable durable Mac endpoint/pairing configuration is deferred. A saved iOS profile is useful while the Mac configuration remains stable, but cannot promise effortless reconnect after a Mac restart that changes its pairing value.               |
| Platform baseline   | The prototype baseline is macOS 26/iOS 26 only. Older-version support and compatibility expansion require a later gate and are not implied by the current slice.                                                                                   |

A historical source-sink size metric may be tracked by its owning
implementation review, but no code-size or target-count number is a canonical
roadmap stop condition. Any proposed limit must be approved separately and
must not displace safety or runtime evidence.

## Feasibility and architecture

### Known feasibility facts

- The TLH wrapper selects the isolated profile before starting the upstream
  runtime and exposes no attach endpoint for an ordinary interactive process.
  Evidence: `scripts/tlh-wrapper.mts` and `scripts/tlh-sessions.mts`.
- The upstream RPC client is a subprocess JSONL client, not a live-attach
  mechanism for the ordinary terminal process. A future compatibility spike
  may evaluate it without changing the Phase 0 product claim.
- The tracked TLH observer implements the lifecycle hook seam and authoritative
  snapshot projection through `createSessionMirrorObserverFacade`,
  `createSessionMirrorObserverProbe`, and `createSessionMirrorObserverRuntime`.
  The observer/projection tests validate the hook and snapshot behavior; only
  compatibility with a future upstream runtime version remains open.
- Persisted sessions are trees with parent links, active leaves, branches, and
  compaction-related entries. A flat append-only message list loses recovery
  semantics.
- Upstream event surfaces include completed and partial families, prompting
  controls, snapshots, and tree-related operations. The companion adapter must
  filter that richer surface to the completed-turn Phase 0 capability profile.
- APNs delivery and iOS background execution are bounded and best effort.
  The current foreground reconnect therefore creates a new authoritative
  full-snapshot subscription. It does not persist a cursor or replay events.
  Cursor retention and bounded event replay are Phase 0B/later work, not current
  reconnect behavior; no indefinite socket or delivery guarantee is assumed.
- Local-network permission and platform review rules are independent concerns.
  Tailscale-first reachability avoids requiring a public listener but does not
  remove app authorization or future platform review work.

### Topology

```text
ordinary `tlh` terminal session in the selected isolated profile
          │ optional in-process observer; bounded, asynchronous, fail-open
          ▼
visible Mac menu-bar app and local bridge
          │ application-authenticated direct sync; Tailscale is reachability
          ▼
iOS read-only reader and transient projection

future signal path: Mac or minimal control plane → generic APNs payload
future protected path: Mac → per-device encrypted notification envelope → APNs
future relay: Mac → authenticated outbound encrypted envelopes → owned server
```

The diagram describes interfaces, not a commitment to a socket library, HTTP
or WebSocket implementation, cryptographic primitive, provider, or deployment
arrangement.

### Repository and responsibility boundaries

The boundaries are provisional deployment boundaries, not proof of a final
repository split. There is no fourth protocol repository in this roadmap.

| Boundary                    | Owns                                                                                                                                         | Must not own                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| TLH repository              | Optional isolated-profile observer, source-side session semantics, initial mirror contract, conformance fixtures, and terminal compatibility | Mobile UI, APNs credentials, server transcript, or a second session writer                       |
| Mac companion repository    | Visible app lifecycle, local bridge, authoritative in-memory projection, bounded cursors/snapshots, pairing, and direct egress adapters      | Normal profile, arbitrary session paths, provider credentials, or unbounded transcript telemetry |
| iOS companion repository    | Read-only tree projection, Settings, protected connection profile, device-protected keys for a future preview path, and snapshot requests    | Agent execution, session mutation, APNs trust, or server-side transcript                         |
| Future server/control plane | Device registration/revocation and APNs submission; later opaque encrypted-envelope routing                                                  | Plaintext session data, agent execution, terminal commands, or mandatory relay dependence        |
| APNs boundary               | Best-effort bounded notification and generic fallback                                                                                        | Ordering, synchronization, authorization, or commands                                            |

Until an explicit ownership-transfer decision, the TLH repository is the
canonical owner of the source-side `session-mirror` contract and fixtures. A
future owner must migrate fixtures, publish compatibility information, and
coordinate releases rather than silently fork semantics.

### Mac app and actor boundary

The selected Phase 0A Mac shape is one visible per-user menu-bar app. It may be
explicitly registered and approved as a main login item, but this login-scoped
availability is not a persistent helper guarantee. The app must distinguish a
pending approval state from an enabled state and must keep pairing, disable,
status, and teardown user-auditable.

Visible app concerns own lifecycle, login-item state, user actions, aggregate
status, bounded diagnostics, cancellation, and teardown. Actor-owned core
modules own Unix-socket framing, rendezvous validation, source epochs,
backpressure, cursor/revision mechanics, and bounded memory. Transcript text
must not enter reducer state, diagnostics, aggregate status, or test output.

The local bridge may invoke an injected snapshot sink synchronously without
awaiting device or network work. The sink owns egress retention and transport;
the bridge owns neither. The TLH producer's whole-publication deadline remains
on the producer side. Egress starts before local bridge ingress and local
bridge shutdown emits drop notifications before egress is disabled. The
follow-up review observed this composition in the current Mac worktree; clean
exact-revision proof and race coverage remain open.

The direct-run device-egress probe is a development/conformance harness, not a
silently registered replacement for the visible app. It must not widen Phase 0A
into a hidden helper or a production service.

### Source projection and session semantics

The source adapter must:

1. Attest the selected isolated profile without sending a raw profile path to a
   peer or falling back to the normal profile.
2. Obtain session header and tree state through supported live APIs or an
   authoritative snapshot operation, not by tailing a session file.
3. Coalesce work away from the terminal critical path and return immediately
   after a bounded handoff.
4. Publish only final assistant turns after source persistence/settlement can
   be proven. If lifecycle ordering is not atomic, confirm a candidate with a
   snapshot first.
5. Project user messages, completed assistant text, safe structural markers,
   and optional coarse working/idle state. Tool arguments, tool output, raw
   working paths, provider details, and arbitrary extension data are excluded.
6. Preserve entry identity links, active-leaf state, branch lineage, compaction,
   branch summaries, revisions, and unknown/custom entry types as safe
   structure. Unknown content is redacted or represented by a neutral marker,
   never guessed into a message.
7. Mark a snapshot as required when continuity cannot be proven. Queue
   acceptance is not proof of delivery.

A Phase 0 capability profile has no assistant-delta, token, or equivalent kind.
A future phase must reject such a kind in conformance tests rather than forward
it merely because an upstream subscription exposes it.

### Snapshots, cursors, and recovery

#### Current foreground reconnect

- Every current pairing or foreground subscription receives an authoritative
  bounded full snapshot.
- A snapshot replaces in-memory state atomically. Incomplete data is discarded
  rather than merged optimistically. The reader never invents an entry or
  merges branches by arrival order.
- The current iOS slice persists no cursor, revision, envelope, or snapshot
  identity. Reconnect does not present a previously applied cursor and does
  not replay retained events; it starts a new full-snapshot subscription.
- APNs is not part of the current slice. A later wakeup hint must not advance
  state or replace the authoritative foreground snapshot.

#### Phase 0B/later recovery target

- A future bounded update family may carry opaque event identity, revision,
  cursor, and active-branch reference. Values must not be human-readable
  session or filesystem identifiers.
- Revisions must cover content and branch/active-leaf changes. Duplicate
  matching events are harmless; conflicting duplicates, impossible parents,
  revision regressions, and unrecoverable ordering errors quarantine the
  projection.
- After an explicit Phase 0B decision, a reconnect may present the last applied
  cursor. The Mac may replay retained events or return `snapshot_required`
  when the cursor is expired, unknown, inconsistent, or outside the bounded
  window. This is a later target, not current behavior.
- Producer overflow, helper loss, or uncertain ordering must set
  snapshot-required state. It must not grow an unbounded queue or claim
  continuity. Exactly-once transport is not promised; bounded replay and
  authoritative replacement remain the recovery target.

### Local IPC and transport independence

Phase 0A source ingress uses a per-user Unix socket with a randomized
rendezvous, restrictive runtime and socket permissions, owner/type checks,
symlink rejection, and a versioned per-process token. These measures prevent
stale or accidental endpoint use and support explicit teardown. They do not
provide confidentiality or adversarial authentication against another process
under the same user account; that is an accepted trust-boundary statement.

The protocol still validates framing, versions, capabilities, schema, size,
queue depth, freshness, and profile scope. Malformed, oversized, replayed,
expired, or unsupported input is rejected without taking down TLH. Backpressure
coalesces non-authoritative status and marks a fresh snapshot as needed; the
terminal never waits for a socket write, encryption operation, helper
acknowledgement, reconnect, or network response.

Keep these interfaces separate:

1. TLH source ingress to the Mac bridge.
2. Paired Mac-to-iOS direct sync, with Tailscale as one reachability adapter.
3. APNs submission of an opaque, bounded notification envelope.
4. A future outbound encrypted relay, where the server routes opaque data but
   cannot decrypt it or accept terminal commands.

A direct-path failure must not force a relay. A relay must not turn into an
inbound terminal-control channel. LAN discovery is optional future work, not a
Phase 0 dependency.

### Durable public feasibility references

These public references were reviewed during consolidation. They are
architectural feasibility sources, not proof that a future server, RPC client,
APNs extension, or background task is approved for the current slice.

| Topic                          | Durable reference                                                                                                                                   | Use and limit                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream server shape          | <https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/server/README.md>                                      | Pinned upstream server description; informs a future managed-runtime evaluation only.                                                       |
| Upstream session handle        | <https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/client/src/session-handle.ts>                          | Pinned upstream client/session-handle source; informs session-tree and lifecycle compatibility work, not live attach in the current reader. |
| Upstream RPC                   | <https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/docs/rpc.md>                              | Pinned RPC guidance; does not change the ordinary terminal-session source authority or authorize a headless product.                        |
| APNs payloads                  | <https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CreatingtheNotificationPayload.html> | Apple payload guidance; supports bounded generic notifications and does not make APNs a sync log or transcript channel.                     |
| Notification Service Extension | <https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension>                                                        | Official Apple extension contract; future encrypted-preview handling remains separately gated.                                              |
| Background execution           | <https://developer.apple.com/documentation/backgroundtasks>                                                                                         | Official Apple BackgroundTasks guidance; informs bounded future work and is not evidence of current background delivery.                    |
| Local-network behavior         | <https://developer.apple.com/news/?id=0oi77447>                                                                                                     | Official Apple local-network guidance; informs disclosure and review work without promising approval or route enforcement.                  |

## Security, privacy, and retention invariants

### Pairing and authorization

The current direct path uses explicit TLS-PSK pairing. The canonical pairing
code is one validated connection value; it is not a transcript, a session
handle, or a public preview key. The PSK path is carried over Tailscale
reachability, while application pairing and authorization remain mandatory.
Reachability, a LAN, Bonjour, an APNs device token, or a QR/deep link alone
never pairs a device.

Pairing is visibly confirmed on both sides, bound to the selected installation
and device, and read-only. It grants no shell, profile, or future reply
authority. The Mac-side binding is authoritative; re-pairing or reviewed
rotation is required for a binding change, and revocation closes active
channels.

Public-preview-key design is separate future work. A future encrypted-preview
capability may use a per-device public/private key arrangement, but that key
must not be inferred from the current TLS-PSK pairing or stored in the current
connection profile. Its generation, rotation, notification-extension handling,
and server visibility require the Phase 0B/Phase 3 gates below.

### Current connection-profile persistence

The approved post-0A store is exactly one bounded, versioned connection profile
in one app-private Keychain item of class `kSecClassGenericPassword`. It contains
only validated connection configuration: a literal address, a numeric port, and
the canonical pairing code. It contains no transcript or session state.

The implementation must:

- use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`;
- omit access groups and synchronization, and add no Keychain Sharing
  entitlement;
- keep service, account, and label metadata fixed and non-sensitive while
  storing connection values only in item data;
- bound encoded data before decoding and distinguish absent, temporarily
  inaccessible, malformed, and unsupported-version records internally;
- reduce storage failures to fixed UI-safe messages, without logging raw
  status values or deleting an unknown/newer record automatically;
- skip the read when live mode is unavailable, the build is Release, or the
  process is a UI test;
- canonicalize an immutable candidate when Connect is pressed and bind it to
  that connection generation;
- save once, and only after the matching generation receives the protocol
  `Ready` frame; failed edits leave the prior profile intact;
- document that protected storage may survive app deletion and make in-app
  Clear the supported deletion path; and
- preserve current transcript-clearing and privacy behavior.

An unlocked device with the saved profile can reconnect without re-entering the
pairing code. The accepted tradeoff is convenience rather than per-connection
biometric confirmation; protected storage prevents synchronization and device
migration but does not itself require user presence for every use.

### Foreground lifecycle reconnect

Launch and active-state handling share one single-flight, idempotent foreground
activation path. Repeated callbacks while connecting or ready are no-ops. Each
launch or foreground transition gets at most one attempt, not a timer or retry
loop. The current slice does not claim that connection or request deadlines are
complete; that adjacent reliability work is tracked separately below.

On background, the controller synchronously invalidates the generation, closes
the transport, clears listings/projections/wire mappings, clears the selected
conversation and detail route, and discards derived in-memory connection
material. The next active transition reloads the protected profile and may make
one new foreground attempt. A per-generation ordinal or route must never be
reused across that boundary.

Clear first invalidates the generation and closes the client, then wipes
editable/candidate state and deletes the Keychain item. An `errSecItemNotFound`
result is success for Clear/delete because the item is already absent; another
deletion failure remains visible because an old profile must not auto-connect
later. Temporary protected-storage unavailability is retried only on a later
foreground lifecycle event, not classified as corruption and not used to trigger
background work.

### Notification and metadata privacy

Remote notifications are generic until an independently reviewed encrypted
preview capability is enabled. The generic alert contains no prompt, assistant
text, path, repository, branch, provider, or session value. A notification
never replaces a snapshot.

For a future encrypted preview, the device keeps a unique private key in
platform-protected storage; the Mac encrypts a minimal bounded preview for that
device; and the server/APNs boundary sees only opaque ciphertext and minimal
routing metadata. Associated data binds protocol/version, opaque device and
installation scope, revision/branch reference, notification kind, and expiry.
The notification extension verifies target, authenticity, freshness, and size
on device. Any lock, timeout, malformed envelope, failed authentication,
expired revision, or unavailable key leaves the generic alert in place.

Decrypted previews are user-opt-in and visible OS notification content. They
may remain in system notification history beyond app deletion controls, so
previews must be short, non-sensitive, and no more detailed than necessary.
Generic-only mode is the safe default. Revocation cannot recall text already
delivered or displayed.

No custom cryptography is permitted. Primitive/library selection requires
platform support, secure randomness, authenticated encryption, key separation,
nonce uniqueness, replay and expiry handling, test vectors, dependency and
license review, and independent security review.

Encryption does not hide all metadata. Timing, frequency, payload size,
device relationships, and network topology may remain visible to relevant
operators. Minimize this through opaque values, bounded/coarsened status,
short retention, and redacted diagnostics.

### Retention and resource bounds

The Mac's existing isolated session store is the only durable full-transcript
store for the initial reader. The phone projection, replay payloads, snapshot
chunks, and egress data remain transient. Only bounded protected operational
state needed for pairing and recovery may persist, such as the connection
profile and the highest applied opaque cursor or snapshot identity if a later
decision allows it. The current post-0A slice persists only the connection
profile; it does not persist cursors or snapshot identity.

The server, if introduced, stores only minimum device/control metadata and
short-lived opaque ciphertext. It never stores prompts, assistant text, tool
output, branch history, or a durable transcript. Logs, metrics, crash reports,
and support bundles exclude content, keys, raw paths, identity-bearing values,
provider details, and endpoints.

The retained-state contract is: at most one validated snapshot for each of
eight opaque per-launch handles, with a shared retained payload maximum of
`8 * 256 KiB`; a 60-minute idle eviction remains a provisional guardrail until
realistic sessions and supported devices are measured. A reader disconnect or
send failure removes only that authenticated reader and retains producer
snapshots. Producer drop or listener lifecycle clearing clears retained
snapshots and notifies readers, preserving mandatory `producerDisconnect`
semantics. On exhaustion, drop/coalesce non-authoritative status and request a
new snapshot. Never grow queues, disk, memory, logs, or transcript storage
without a bound. These are runtime safety bounds, not code-size or target-count
caps.

### Teardown and rollback

There must be one documented, idempotent **Disable and remove everything**
operation, and the visible app action must use the same verified cleanup path.
It unregisters the visible main app, closes the bridge and egress, removes only
managed runtime artifacts and the explicitly enabled isolated-profile observer
setting, and leaves normal-profile and unmanaged files untouched. It must not
install raw launch-agent files, use privileged services, force-kill unrelated
processes, or treat process disappearance as proof of registration settlement.

The managed rollback inventory is limited to the visible app bundle, its
explicit main-app registration, the companion runtime socket/rendezvous
artifacts, the enabled isolated-profile observer setting, and a content-free
versioned teardown receipt. A receipt is written only after lifecycle cleanup
and registration absence are independently verified. A removed app without a
valid receipt requires the documented exact-bundle recovery path; it does not
authorize broad artifact reclamation or machine registration.

## Actual Phase 0A validation evidence

The entries below are canonical evidence records dated 2026-09-13. They
summarize read-only consolidation inputs; they are not newly re-verified
physical or runtime source proof. No raw logs, framework output, secrets,
identifiers, paths, or transcript content are copied here. Tracked TLH source
and tests are cited where they are the durable source; cross-repository and
physical observations are recorded by the row itself.

| Evidence                                                                                                                                                                | Status                                                    | Durable evidence source                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated TLS-PSK transport and bounded snapshot delivery from the Mac path to physical iOS hardware over Tailscale reachability                                    | **Canonical evidence record (2026-09-13)**                | This row is the canonical dated record; it is a consolidation of the read-only physical-path review.                                                                                                                                                                                                                                        |
| Current foreground reconnect uses an authoritative full-snapshot subscription with completed-turn-only, branch-aware projection and no persisted cursor or event replay | **Canonical evidence record (2026-09-13)**                | This row is the canonical dated record; current TLH projection remains tracked at `extensions/the-last-harness/session-mirror/session-adapter.ts:projectSessionMirrorSnapshot`.                                                                                                                                                             |
| Physical transport is feasible, but iOS route/interface enforcement is not as strong as the Mac listener's selected-interface behavior                                  | **Canonical limitation record (2026-09-13)**              | This row is the canonical dated record; route enforcement remains an open Phase 0B/Phase 1 check.                                                                                                                                                                                                                                           |
| Canonical running/stopped teardown, registration absence, profile restoration, and content-free receipt behavior                                                        | **Canonical evidence record (2026-09-13)**                | This row is the canonical dated record; no machine or lifecycle state is required to understand it.                                                                                                                                                                                                                                         |
| Local bridge bounds, fail-open producer behavior, privacy suppression, and disconnect/eviction clearing                                                                 | **Canonical evidence record (2026-09-13)**                | This row is the canonical dated record; TLH fail-open state and bounded publication are also represented by `extensions/the-last-harness/session-mirror/observer.ts:createSessionMirrorObserverRuntime`.                                                                                                                                    |
| Visible-app LocalBridge-to-device-egress composition has ordered startup and shutdown, but clean exact-revision proof remains pending                                   | **Canonical evidence record (2026-09-13)**                | This row is the canonical dated record; the clean proof is an actionable register item and is not claimed here.                                                                                                                                                                                                                             |
| The production iOS UI is conversations-first and hides synthetic fixtures, while fixture boundaries/resources remain compiled and bundled; UI tests deny live transport | **Canonical evidence and limitation record (2026-09-13)** | This row is the canonical dated record; release-target fixture cleanup is an actionable register item.                                                                                                                                                                                                                                      |
| The TLH hook/snapshot API is implemented and validated; only future upstream runtime-version compatibility remains open                                                 | **Implemented and validated**                             | `extensions/the-last-harness/session-mirror-observer-facade.ts:createSessionMirrorObserverFacade`, `extensions/the-last-harness/session-mirror-observer-probe.ts:createSessionMirrorObserverProbe`, `extensions/the-last-harness/session-mirror/observer.ts:createSessionMirrorObserverRuntime`, and the tracked observer/projection tests. |
| Phase 0A product evidence is genuine-session/read-only evidence rather than a single simulated notification                                                             | **Canonical gate-basis record (2026-09-13)**              | This row is the canonical dated record; the Phase 0A gate remains closed and is not reopened by later hardening.                                                                                                                                                                                                                            |

These records do not establish clean cross-repository revisions, durable
login-item configuration, production background behavior, older-platform
support, or Phase 0B recovery. Those limits are represented as register items
rather than hidden claims of completion.

## Phase 0A — completed desirability prototype

**Status: complete; do not reopen.** Phase 0A established the first useful
product hypothesis: a paired read-only view of completed turns from ordinary
terminal-started sessions, with the Mac as authority and the terminal workflow
unchanged.

The completed intent and gates were:

- an optional isolated-profile TLH observer and bounded local bridge;
- a visible development Mac app with explicit pairing, truthful lifecycle
  state, and opt-in login-item availability rather than a hidden helper;
- a read-only iOS projection of at least one genuine session with completed
  turns and structural branch/leaf state;
- foreground direct delivery with app authentication and Tailscale used only
  for reachability;
- reconnect through an authoritative snapshot rather than a flat or silently
  gapped stream;
- generic or simulated notification UX only, with no claim of APNs reliability;
- strict profile confinement, no transcript persistence, bounded resources,
  and fail-open terminal behavior; and
- qualitative multi-day usefulness evidence, including whether read-only
  checks saved time or context and whether ordinary sessions needed a recurring
  workaround. No transcript content belongs in that evidence.

Phase 0A did not include persistent/crash-supervised helper behavior, real APNs
background delivery, encrypted previews, durable replay, multi-user service,
replies, relay hosting, production operations, or store review. The earlier
reviewed app-composition blocker is carried as a closure/reproducibility item
below because the follow-up worktree changed it; it is not a reason to reopen
the completed desirability gate.

## Post-0A basic usability

**Status: current narrow slice.** This slice implements the approved connection
profile and foreground lifecycle convenience after the Phase 0A reader became
useful. It is not a new Phase 0A trial and does not authorize Mac stable
configuration, transcript persistence, retries, background sync, or Phase 0B
work.

### Baseline carried forward

- The iOS root is conversations-first, with connection fields and controls in
  Settings. New Chat and mobile-originated commands remain out of scope.
- The production UI hides synthetic fixtures and remains live-only, but the
  fixture boundary and resources are still compiled and bundled today. UI-test
  transport denial must remain structural; removing fixture resources from a
  release target is an actionable later cleanup, not a claim about this slice.
- Existing privacy-cover, transcript-clearing, aggregate-status, and
  fail-closed parsing behavior is preserved while the lifecycle state is
  improved.
- The prototype baseline is macOS 26/iOS 26 only. Do not expand older OS
  support in this slice.
- Human-owned iOS project-file, signing, and project-format churn is outside
  this slice. Preserve it without copying signing values into this roadmap or
  changing it as part of the profile implementation; any required project-file
  edit needs separate authorization.

### Profile-store work

1. Add a redacted versioned profile model and an injectable profile-store
   boundary.
2. Implement the exact protected-storage attributes and fixed metadata listed
   in the connection-persistence invariant above.
3. Test absent, load, save, update, delete, canonicalization, size bounds,
   malformed and unsupported versions, temporary unavailability, deletion
   failure, redaction, and query attributes without emitting protected values.
4. Keep the previous working profile after failed edits or stale credentials.

### Controller and lifecycle work

1. Make launch and foreground resume idempotent and single-flight.
2. Load and validate the profile only in an active permitted live process.
3. Capture a generation-bound candidate on Connect and save only after the
   matching protocol Ready frame.
4. On foreground reconnect, subscribe to one authoritative full snapshot; do
   not persist a cursor or replay events in this slice.
5. On background, retire the generation synchronously, close transport, clear
   live/transcript projection and detail navigation, and discard derived
   connection material.
6. On active, reload protected configuration and make one foreground attempt.
7. On Clear, invalidate and close first, then wipe editable state and delete the
   profile; suppress future automatic foreground connection after a successful
   clear.
8. Reconcile the iOS README and SECURITY documentation with this exact
   connection-profile-only Keychain scope, save-after-Ready behavior,
   foreground-only reconnect, no-transcript rule, and Clear/deletion guidance.

The saved profile is intentionally useful only while the Mac's configured
address, port, and pairing value remain stable. A durable Mac-side connection
profile or stable login-launch environment is a later phase, not an implicit
part of this slice.

### Current-slice validation gate

The slice is ready only when deterministic tests prove the exact profile-store
and lifecycle contract: profile persistence is bounded and protected,
connection candidates save once after the matching Ready frame, activation is
single-flight, stale callbacks cannot save or revive a retired generation,
background retirement resets navigation and projection, Clear cannot leave an
old profile that reconnects later, and the iOS README/SECURITY documentation
matches those rules. Reconnect validation must require listing, subscription,
and snapshot delivery. Treat reader admission as valid only after listing,
subscription, and snapshot delivery prove sendability. It must assert a fresh
authoritative full snapshot with no persisted cursor or event replay. The
disconnected-producer-drop regression must verify that reconnect listing is empty
and old handles yield `unknownHandle`, while preserving mandatory
`producerDisconnect` notification semantics. UI-test and Release processes must
deny live transport before any protected profile read. No test may include real
prompts, paths, credentials, pairing values, or transcript text.

### Adjacent post-0A follow-up

These findings are intentionally separate from the current Keychain/reconnect
mechanics: bounded connection/list/subscribe deadlines and fixed timeout
states; privacy coverage for modal Settings and every non-active scene state;
coarse connection-state diagnostics; route/interface enforcement; and other
foreground reliability hardening. They remain actionable Post-0A findings and
must not be silently treated as completed by profile persistence or
single-flight lifecycle work.

### Explicitly outside this slice

Mac stable launch configuration, QR pairing, device re-pair UX, persistent or
crash-supervised helper behavior, reader keepalive/takeover, durable cursor
replay, sleep/wake recovery, sustained-load tuning, real APNs, encrypted
previews, server control plane, replies, relays, older-version platform
expansion, fixture-resource cleanup, and automatic TLH producer retry or
background synchronization remain separately gated. Deadline and modal-privacy
work is tracked as the adjacent Post-0A follow-up above, not as an unspoken
extension of the current Keychain mechanics.

## Phase 0B — hard technical validation

**Status: deferred.** Enter only after the Phase 0A usefulness decision is
accepted with no unresolved terminal, profile, authentication, or privacy
blocker, and after the cost of persistent helper and APNs testing is explicitly
accepted.

The Phase 0B plan is to:

- select and measure a platform-appropriate persistent/crash-supervised helper
  lifecycle for sleep, wake, logout, restart, and crash cases; this may
  evaluate a hidden helper mechanism only as a new gated decision, never as a
  retroactive Phase 0A behavior;
- exercise real APNs/background delivery on supported development hardware,
  with a generic fallback whenever protected decryption or execution is
  unavailable;
- use a minimal APNs-capable control plane only if needed, with opaque-only
  storage and bounded retention, never a general relay or transcript store;
- test helper crash, network loss, app suspension, push duplication/drop/
  reordering, expired cursors, queue overflow, snapshot chunk loss, duplicate
  and conflicting events, and branch changes during reconnect;
- preserve completed-turn-only conformance, allowing coarse working/idle state
  but rejecting token/delta events; and
- test key generation, explicit pairing, rotation/revocation, generic fallback,
  redacted diagnostics, profile confinement, and resource limits on genuine
  hardware.

No Phase 0B item authorizes an automatic producer retry or background sync in
the TLH source. Recovery must remain bounded, explicit, and snapshot-based
unless a separate product decision changes that constraint.

The 0B gate passes only when protected previews, authorization/revocation,
limits, fail-open behavior, and cursor/snapshot recovery are demonstrated on
genuine hardware and privacy review accepts residual metadata leakage. APNs
nondelivery alone is not a defect if foreground reconciliation remains correct;
plaintext disclosure, unauthenticated access, terminal blocking, or misleading
continuity is a stop condition.

## Phase 1 — productization after validation

**Status: deferred.** After 0B, stabilize provisional repository boundaries,
finish read-only branch navigation, decide whether any protected offline phone
projection is justified, document install/update/revoke/recovery, harden direct
transport adapters, and perform formal dependency, supply-chain, and security
review.

Phase 1 also owns the deferred stable Mac launch configuration: choose a
reproducible, user-auditable way to keep address, port, and pairing material
consistent across an approved login launch without placing secrets or personal
values in the repository. Until then, direct developer launch and explicit
re-pairing remain honest behavior.

Close the rows explicitly targeted **Post-0A follow-up** before treating the
current reader as dependable: connection/request deadlines, modal privacy
coverage, navigation reset, production-wiring integration coverage, malformed
configuration visibility, and other bounded foreground reliability work. Phase
1 then owns only the rows marked **Phase 1**, including asynchronous egress
failure coupling, durable package provenance, shell profile guards,
state-directory ownership, stable Mac launch configuration, pairing/detail
redaction, teardown diagnostics, dependency review, fixture-resource cleanup,
and governing-document reconciliation. Phase 0B rows remain separate and are
not silently pulled into productization.

## Phase 2 — additive capabilities

**Status: deferred.** Only after the read-only path is trusted may the product
evaluate a separately negotiated reply capability or an owned-server encrypted
relay.

A reply must target an exact opaque installation/device/session/branch/leaf and
source revision, carry an idempotency key and expiry, require visible separate
authorization, and return an accepted/rejected/stale/busy receipt. Offline
commands are rejected or explicitly expired, never silently replayed. The plan
must decide live/idle eligibility, streaming behavior, stale-leaf handling,
shutdown behavior, and whether a command means a new prompt, steer, follow-up,
or another explicitly named operation. It must not silently map to upstream
controls with different semantics.

A relay is outbound from the Mac, carries authenticated encrypted envelopes,
expires ciphertext after a bounded window, and cannot decrypt snapshots,
previews, replies, or transcripts. Direct Tailscale sync remains a separate
transport option.

## Phase 3 — production and platform-review readiness

**Status: deferred.** Re-check current platform SDK and review rules for APNs,
local-network disclosure, background execution, notification extensions,
privacy labels, transport security, and required usage descriptions. Existing
public guidance is architectural evidence, not an approval promise.

Before production or store submission, demonstrate pairing, revocation,
encryption, generic fallback, offline recovery, and privacy behavior using a
clean public-safe environment with synthetic fixtures. Expand beyond the
macOS 26/iOS 26 prototype baseline only after older-version compatibility is
explicitly tested and accepted. Complete dependency and license review, secret
scanning, supply-chain review, threat-model and key-management sign-off,
redacted observability, retention/deletion controls, rate limits,
incident/revocation procedures, and backup/restore tests. Only then decide
operations, scaling, multi-user support, relay hosting, and store submission.

## Review evidence register

Every item below has a durable evidence source, an explicit disposition, a
target, and a closure check. A tracked source path/symbol is cited when one is
available; otherwise the row records itself as canonical dated evidence from
2026-09-13. “Accepted” does not mean the item is fixed; it means the
observation remains actionable. “Downgraded/rejected” records a claim that
must not be reintroduced as a defect without new evidence. “Unverified” records
a claim whose state is not yet safe to assert. Target labels are authoritative:
Post-0A follow-up is separate from current Keychain mechanics, Phase 0B is
technical validation, and Phase 1 is productization.

### TLH source and producer findings

| Severity | Observation                                                                                                                                                                                             | Durable evidence source                                                                                                                                                                                                                                                                                                                | Disposition                                                                                                                                                                        | Target phase                                        | Validation needed                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | The TLH hook/snapshot API is implemented and validated, but a future upstream runtime version could change the supported hook or session-manager contract.                                              | `extensions/the-last-harness/session-mirror-observer-facade.ts:createSessionMirrorObserverFacade`, `extensions/the-last-harness/session-mirror-observer-probe.ts:createSessionMirrorObserverProbe`, `extensions/the-last-harness/session-mirror/observer.ts:createSessionMirrorObserverRuntime`, and tracked observer/projection tests | **Unverified only for future compatibility** — the current implementation and validation are complete; compatibility with a future upstream version is the remaining API question. | Phase 1                                             | Run a compatibility spike against any future pinned runtime, preserving isolated-profile attestation, completed-turn ordering, authoritative snapshots, and fail-open behavior. |
| High     | The exact producer revision used by the physical/live proof is not yet reproducible from a clean committed or packaged source without sweeping in unrelated worktree changes.                           | `extensions/the-last-harness/session-mirror-observer-facade.ts:SESSION_MIRROR_OBSERVER_RUNTIME_VERSION` and this canonical dated register record (2026-09-13)                                                                                                                                                                          | **Unverified** — this is proof provenance, not a claim that the tracked hook/snapshot API is unimplemented.                                                                        | Post-0A follow-up                                   | Build from a clean exact revision, verify generated/runtime siblings and package exclusions, and record only safe revision metadata.                                            |
| High     | The shell normal-profile guard combines boolean operators without the intended grouping.                                                                                                                | Canonical roadmap evidence (2026-09-13; current source-review record)                                                                                                                                                                                                                                                                  | **Accepted** — an independent Node guard reduces current exposure, but defense in depth is defective.                                                                              | Phase 1                                             | Add shell tests for unset and differing selected-home values and prove the normal profile is never selected.                                                                    |
| Medium   | Companion-directory presence is latched at TLH session start; a fresh setup can miss a later-started helper. Oversized sessions use a bounded recent window without an explicit omitted-history marker. | Canonical roadmap evidence (2026-09-13; companion-directory and bounded-window source-review record)                                                                                                                                                                                                                                   | **Accepted** — intentional bounded/product limitations, not unboundedness defects.                                                                                                 | Phase 1 and Phase 0B                                | Test fresh setup, late helper start, large-session behavior, and an explicit safe indication when earlier history is omitted.                                                   |
| Medium   | Repeated bounded-window scanning and serialization can consume avoidable work under sustained load.                                                                                                     | Canonical roadmap evidence (2026-09-13; bounded-window performance source-review record)                                                                                                                                                                                                                                               | **Accepted** — boundedness is intentional, while repeated-scan cost and user-visible omission signaling remain open reliability work.                                              | Phase 0B                                            | Measure repeated lifecycle markers across realistic session sizes, retain a safe bound, and expose no transcript or path data in diagnostics.                                   |
| Medium   | A long relocated isolated-profile path can exceed the Unix-socket path limit and fail closed without a dedicated status.                                                                                | Canonical roadmap evidence (2026-09-13; long-path source-review record)                                                                                                                                                                                                                                                                | **Accepted** — fail-closed behavior is safer than truncating or falling back, but the failure should be diagnosable without exposing the path.                                     | Post-0A follow-up and Phase 0B                      | Exercise a safely generated long path, return a fixed status, and prove no fallback to the normal profile or unbounded path handling.                                           |
| Medium   | The source-side observer and Swift bridge have no deterministic production-wiring integration test spanning real Node framing and Swift lifecycle.                                                      | Canonical roadmap evidence (2026-09-13; cross-repository source-review record)                                                                                                                                                                                                                                                         | **Accepted** — high-return regression coverage remains missing.                                                                                                                    | Post-0A follow-up                                   | Use temporary state and synthetic payloads to cover hello/ready, accepted replacement, retained producer connection, and producer-disconnect drop.                              |
| Medium   | Relative sibling package references make cross-repository provenance depend on current worktrees.                                                                                                       | Canonical roadmap evidence (2026-09-13; cross-repository source-review record)                                                                                                                                                                                                                                                         | **Accepted** — reproducibility is required before release work.                                                                                                                    | Phase 1                                             | Record exact source revisions for each proof and adopt an immutable package provenance mechanism.                                                                               |
| Medium   | Dependency advisories were reported, but reachability and exploitability were not assessed.                                                                                                             | `package-lock.json` and this canonical dated register record (2026-09-13)                                                                                                                                                                                                                                                              | **Unverified** — do not infer impact or run an automatic audit fix.                                                                                                                | Phase 1 and Phase 3                                 | Review dependency reachability, lockfile impact, patches, and supply-chain exposure deliberately.                                                                               |
| Low      | A publication-retry review claim conflicts with the approved marker-driven behavior.                                                                                                                    | `extensions/the-last-harness/session-mirror/observer.ts:createSessionMirrorObserverRuntime`                                                                                                                                                                                                                                            | **Downgraded/rejected** — automatic producer retry and background sync are not approved.                                                                                           | Ongoing invariant; revisit only by product decision | Verify failed publication marks state dirty, no timer/retry loop exists, and a later lifecycle marker or explicit snapshot request can recover it.                              |
| Low      | DEBUG-only live mode, no background operation, and clearing transient state on background or memory warning were reported as defects.                                                                   | Canonical roadmap evidence (2026-09-13; current product-constraint record)                                                                                                                                                                                                                                                             | **Downgraded/rejected** — these are approved Phase 0 constraints.                                                                                                                  | Ongoing invariant                                   | Keep Release/UI-test transport disabled and document foreground-only behavior without implying durable state.                                                                   |

### Mac companion findings

| Severity | Observation                                                                                                                                                                                                                   | Durable evidence source                                                   | Disposition                                                                                                                                | Target phase      | Validation needed                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blocker  | The earlier installed app used a no-op local snapshot sink while device delivery lived in a separate probe executable.                                                                                                        | Canonical roadmap evidence (2026-09-13; historical composition record)    | **Accepted** — the historical blocker is addressed in the current composition record; clean closure remains unverified.                    | Post-0A follow-up | Build the visible app from exact revisions, prove source-to-device delivery in one artifact, and run canonical teardown.                             |
| High     | The installed app duplicates lifecycle coordination and can race a start against disable or quit.                                                                                                                             | Canonical roadmap evidence (2026-09-13; current composition record)       | **Accepted** — stale starts must be made inert by one generation-guarded coordinator.                                                      | Post-0A follow-up | Add coordinator-level race tests for concurrent start, stop, disable, quit, and stale callbacks while preserving egress-before-bridge startup order. |
| High     | An asynchronous egress failure can leave the bridge apparently healthy; a bridge restart can meet a busy reader and remain wedged.                                                                                            | Canonical roadmap evidence (2026-09-13; current composition record)       | **Accepted** — aggregate status and coupled lifecycle need a single owner.                                                                 | Phase 1           | Inject listener/address/interface failure, restart each component, and verify fixed component-specific status and recovery.                          |
| High     | Login-managed app configuration is process-environment-only and is not a durable stable Mac profile.                                                                                                                          | Canonical roadmap evidence (2026-09-13; current composition record)       | **Accepted and deferred** — stable Mac configuration is intentionally later; current iOS convenience is useful while values remain stable. | Phase 1           | Test direct and approved login launches with safe placeholders; document when re-pairing is required without storing private values in source.       |
| Medium   | State-directory ownership behavior differs between the committed Mac revision and an apparent human-owned worktree fix.                                                                                                       | Canonical roadmap evidence (2026-09-13; state-directory review record)    | **Unverified** — the fix must be deliberately reviewed and landed by its owner.                                                            | Phase 1           | From a clean revision, test pre-existing safe directories, manager-created directories, modes, provenance, and non-owned cleanup refusal.            |
| Medium   | One authenticated reader can remain held after silent path loss because post-authentication keepalive or idle liveness is absent.                                                                                             | Canonical roadmap evidence (2026-09-13; transport-liveness record)        | **Accepted** — this is a reliability concern, not a contradiction of the canonical full-snapshot reconnect record.                         | Phase 0B          | Test abrupt suspension/process death, bounded liveness detection, foreground reconnect, and any newest-reader policy with a security review.         |
| Medium   | Malformed Mac egress configuration is swallowed and looks like intentional disablement.                                                                                                                                       | Canonical roadmap evidence (2026-09-13; configuration-diagnostics record) | **Accepted** — fixed non-sensitive configuration errors should be visible.                                                                 | Post-0A follow-up | Supply malformed values and verify a bounded diagnostic without echoing values, paths, or framework errors.                                          |
| Medium   | Pairing details remain continuously visible in the lifecycle-managed status menu.                                                                                                                                             | Canonical roadmap evidence (2026-09-13; pairing-visibility record)        | **Accepted** — useful for development pairing but unnecessarily exposed after setup.                                                       | Phase 1           | Add reveal-on-demand behavior and ensure details never enter aggregate state, logs, screenshots, or diagnostics.                                     |
| Medium   | Service-management settlement can be pending or leave a menu with no useful diagnostics; post-quit failures lack a durable status channel.                                                                                    | Canonical roadmap evidence (2026-09-13; teardown-observability record)    | **Accepted** — successful teardown records exist, but failure observability is weak.                                                       | Phase 1           | Exercise pending, failed, quit, and post-quit cases and expose only fixed content-free outcomes.                                                     |
| Medium   | Low-level hardening remains incomplete: path-free publication status, constant-time launch-token comparison, allow-listed teardown environment, monotonic resubscribe revision floor, and accessibility/keyboard affordances. | Canonical roadmap evidence (2026-09-13; security-hardening record)        | **Accepted** — hardening backlog, not a reason to change the current product boundary.                                                     | Phase 1           | Add focused security, lifecycle, accessibility, and input tests with no content or identity leakage.                                                 |
| Medium   | Mac README, architecture, and security descriptions lag the installed-app device-egress composition.                                                                                                                          | Canonical roadmap evidence (2026-09-13; governing-document record)        | **Accepted** — governing documentation needs reconciliation after source behavior is stable.                                               | Phase 1           | Compare docs with the tested target graph, lifecycle owner, retention, and teardown behavior; keep all machine values out.                           |
| Medium   | The app's duplicate composition is not covered by existing coordinator tests; current subprocess coverage uses a stub bridge.                                                                                                 | Canonical roadmap evidence (2026-09-13; test-coverage record)             | **Accepted** — executable-target lifecycle behavior needs deterministic coverage.                                                          | Post-0A follow-up | Add bounded app/coordinator tests for start/stop races, async failure coupling, restart, and aggregate status.                                       |
| Low      | The Mac-to-device implementation needs protocol and negotiated-suite evidence before making stronger transport-security claims.                                                                                               | Canonical roadmap evidence (2026-09-13; transport-security record)        | **Accepted** — physical TLS-PSK feasibility is recorded, but suite and forward-secrecy claims remain scoped.                               | Phase 0B          | Record negotiated safe suite properties in redacted evidence and retain generic fallback on failure.                                                 |

### iOS companion findings

| Severity | Observation                                                                                                                                                | Durable evidence source                                                 | Disposition                                                                                                                                          | Target phase          | Validation needed                                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Connection setup, list, and subscribe operations can wait indefinitely; post-ready path loss is not consistently treated as disconnected.                  | Canonical roadmap evidence (2026-09-13; client-lifecycle record)        | **Accepted** — bounded deadlines are adjacent Post-0A foreground reliability work, not part of the current Keychain mechanics.                       | Post-0A follow-up     | Test unavailable Mac/tunnel, path loss, pairing refusal, list timeout, subscribe timeout, cancellation, and fixed non-sensitive error states.                       |
| High     | The privacy cover is applied only to the root and only in the inactive state; a Settings sheet can sit above it, and background timing can expose content. | Canonical roadmap evidence (2026-09-13; privacy-cover record)           | **Accepted** — app-switcher and modal privacy must be structural and remain separate from profile persistence.                                       | Post-0A follow-up     | Cover and hide accessibility content whenever not active, dismiss or cover Settings, and validate app-switcher snapshots on physical hardware.                      |
| High     | Background retirement can retain a selected detail ordinal and return to a stale or indefinitely loading route.                                            | Canonical roadmap evidence (2026-09-13; navigation-generation record)   | **Accepted** — generation-bound navigation reset is part of the current lifecycle contract.                                                          | Post-0A follow-up     | Background and foreground repeatedly, verify list-first navigation, and prove stale ordinals cannot select a new-generation conversation.                           |
| Medium   | The iOS client validates a CGNAT-shaped address but does not prove that traffic uses the Tailscale packet-tunnel interface.                                | Canonical roadmap evidence (2026-09-13; route-enforcement record)       | **Accepted with narrowed claim** — TLS-PSK remains the application authentication boundary; Tailscale-only routing is not yet proven.                | Phase 0B and Phase 1  | Evaluate a supported interface/path constraint or narrow documentation; test cellular and alternate-route cases without exposing values.                            |
| Medium   | A fresh simulator screenshot run is safe because it has no profile, not because live transport is structurally denied.                                     | Canonical roadmap evidence (2026-09-13; UI-test policy record)          | **Accepted** — this must be fixed before Keychain auto-connect can be trusted.                                                                       | Current post-0A slice | Deny live transport by process/test policy before reading protected configuration or opening a live path.                                                           |
| Medium   | The conversations surface does not distinguish failed, closed, ready-empty, and connecting states well; refresh can silently no-op without a client.       | Canonical roadmap evidence (2026-09-13; conversation-state record)      | **Accepted** — coarse status improves diagnosis without exposing content.                                                                            | Post-0A follow-up     | Add fixed status states and test refresh cancellation/completion under absent, failed, and ready clients.                                                           |
| Medium   | iOS README and SECURITY descriptions still prohibit protected connection persistence and automatic foreground connection.                                  | Canonical roadmap evidence (2026-09-13; iOS documentation record)       | **Accepted** — reconcile both documents in the current Keychain slice; the old blanket prohibition is superseded by the exact profile-only approval. | Current post-0A slice | Document exact Keychain attributes, save-after-Ready, foreground-only behavior, no-transcript rule, Clear/deletion guidance, and the accepted convenience tradeoff. |
| Medium   | Human-owned iOS project-file, signing, and project-format churn is unrelated to the current profile slice.                                                 | Canonical roadmap evidence (2026-09-13; project-state record)           | **Accepted boundary** — preserve that churn without values and do not sweep it into this roadmap task.                                               | Current post-0A slice | Keep implementation changes out of project metadata unless separately authorized; never record signing values or identifiers here.                                  |
| Medium   | The production UI hides fixtures, but fixture boundaries and resources remain compiled and bundled.                                                        | Canonical roadmap evidence (2026-09-13; fixture-boundary record)        | **Accepted** — release footprint and fixture separation need explicit cleanup.                                                                       | Phase 1               | Remove fixture resources and boundary code from the production release target while retaining synthetic test fixtures and structural UI-test transport denial.      |
| Medium   | The prototype baseline is macOS 26/iOS 26 only; older-version expansion is not validated.                                                                  | Canonical roadmap evidence (2026-09-13; platform-baseline record)       | **Accepted and deferred** — do not imply older-version support from the prototype.                                                                   | Phase 3               | Define supported older versions, run compatibility and privacy validation, and accept the matrix before expansion.                                                  |
| Medium   | The claim that the Keychain slice is in the wrong order conflicts with the approved product sequence.                                                      | Canonical roadmap evidence (2026-09-13; product-sequence record)        | **Downgraded/rejected** — iOS persistence may precede stable Mac configuration; it remains useful while Mac values are stable.                       | Current post-0A slice | Verify generation-bound save-after-Ready and failed-edit preservation; do not block the slice on stable Mac launch configuration.                                   |
| Medium   | The claim that no persisted transcript exists on the delivery path was raised as a defect.                                                                 | `docs/companion-roadmap.md:Security, privacy, and retention invariants` | **Downgraded/rejected** — no transcript persistence is an explicit security invariant.                                                               | Ongoing invariant     | Inspect stores, settings, Keychain data, URL cache, restoration state, and logs for connection configuration only.                                                  |
| Low      | The claim that an installed app can never receive shell environment was not established.                                                                   | Canonical roadmap evidence (2026-09-13; launch-configuration record)    | **Unverified** — durable login configuration is absent, but direct launch remains possible.                                                          | Phase 1               | Test approved launch modes with safe placeholders and then choose a stable Mac configuration; do not infer inheritance.                                             |

### Cross-system and adjudicated findings

| Severity | Observation                                                                                                                       | Durable evidence source                                                                                                                                                         | Disposition                                                                                                                                 | Target phase                                 | Validation needed                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | A review claim said TLS-PSK had never completed from iOS.                                                                         | Canonical roadmap evidence (2026-09-13; physical direct-path record)                                                                                                            | **Downgraded/rejected** — the canonical physical-path record confirms authenticated transport and snapshot delivery.                        | Phase 0A complete; strengthen in Phase 0B    | Preserve the existing record and add wrong-key, replay, expiry, route, and negotiated-suite negative cases without copying sensitive values. |
| High     | A review claim said real from-app teardown survival was unproven.                                                                 | Canonical roadmap evidence (2026-09-13; teardown record)                                                                                                                        | **Downgraded/rejected** — canonical running/stopped teardown records passed after lifecycle settlement; failure observability remains open. | Phase 1                                      | Re-run bounded failure cases and retain only fixed receipt/absence outcomes.                                                                 |
| High     | Same-user local peer access was described as a missing mutual-authentication defect.                                              | Canonical roadmap evidence (2026-09-13; local-trust record)                                                                                                                     | **Downgraded/rejected** — the same-user account is the accepted Phase 0A local trust boundary, not an app-authentication claim.             | Ongoing invariant; threat review in Phase 0B | Keep the limitation explicit, preserve restrictive rendezvous checks, and require separate device pairing/authentication.                    |
| High     | Earlier Phase 0A wording prohibited all device egress from the visible app, while the current composition records bounded egress. | Canonical roadmap evidence (2026-09-13; historical composition record)                                                                                                          | **Downgraded/rejected as stale** — internal bounded composition is allowed; production APNs/server/reply behavior remains deferred.         | Post-0A follow-up                            | Verify one visible-app artifact, lifecycle ordering, fail-open source handoff, and no hidden helper or privileged service.                   |
| Medium   | Former hard package/target/Swift line ceilings were treated as acceptance gates.                                                  | `docs/companion-roadmap.md:Approved decisions and reconciliations`                                                                                                              | **Downgraded/rejected as superseded** — no hard code-size or target-count gate is carried into this roadmap.                                | Ongoing engineering review                   | Check this document and future phase tickets for cohesion, measured runtime limits, and test evidence rather than stale numeric caps.        |
| Medium   | Hard bounds, queue coalescing, handle retention, and idle eviction were classified as usability defects.                          | `extensions/the-last-harness/session-mirror-observer-probe.ts:SESSION_MIRROR_OBSERVER_PROBE_BOUNDS` and `docs/companion-roadmap.md:Security, privacy, and retention invariants` | **Downgraded/rejected as defects** — bounded behavior is intentional; product policy and measurements remain open.                          | Phase 0B                                     | Measure realistic sessions/devices, test overload and eviction, and document safe omitted-history or fresh-snapshot behavior.                |
| Medium   | No production-wiring test spans TLH, Node framing, Swift bridge, egress, and iOS.                                                 | Canonical roadmap evidence (2026-09-13; cross-system test-coverage record)                                                                                                      | **Accepted** — the canonical physical record covers the seam, but deterministic regression coverage is absent.                              | Post-0A follow-up and Phase 1                | Build one synthetic, bounded cross-repository harness and assert fail-open, replacement, disconnect, and teardown semantics.                 |
| Medium   | Crash recovery, sleep/wake, sustained load, durable replay, and reader takeover were proposed as immediate blockers.              | Canonical roadmap evidence (2026-09-13; phase-boundary record)                                                                                                                  | **Downgraded/rejected for the current slice** — these are Phase 0B technical-validation work.                                               | Phase 0B                                     | Run the explicit interruption, resource, cursor, and liveness matrix before selecting persistent-helper behavior.                            |
| Low      | Governing records across the Mac and iOS repositories are inconsistent with the approved current boundary.                        | Canonical roadmap evidence (2026-09-13; governing-document record)                                                                                                              | **Accepted** — this canonical roadmap is reconciled now; source-repository docs remain untouched by this task.                              | Phase 1                                      | Update each owning document in a separately authorized task and compare claims against tested source.                                        |
| Low      | Public upstream and Apple feasibility guidance could be mistaken for implementation approval or current runtime proof.            | `docs/companion-roadmap.md:Durable public feasibility references`                                                                                                               | **Accepted** — the references are durable architectural citations only.                                                                     | Phase 3                                      | Re-check current platform guidance and preserve the distinction between public feasibility, canonical evidence, and implemented behavior.    |

## Conformance fixtures and evidence hygiene

Future fixtures remain synthetic and repository-safe. They should cover:

- a versioned session tree with multiple branches, active-leaf changes, fork
  lineage, compaction, branch summaries, labels, unknown/custom entries, and an
  empty session;
- completed turns, working/idle status, aborted/error status, and a deliberately
  forbidden delta/token message;
- revision gaps and regressions, duplicates and conflicting duplicates,
  out-of-order parents, expired cursors, chunk loss, replay, and atomic
  snapshot replacement;
- malformed JSON/schema, oversized or deep frames, queue overflow, helper
  restart, profile-boundary rejection, and fail-open terminal behavior;
- pairing success/failure, wrong device, revocation/rotation, expired
  envelopes, unavailable protected keys, invalid authentication, notification
  clipping/timeout, and generic fallback; and
- version negotiation, unknown optional fields, unsupported required features,
  and server-as-untrusted-ciphertext behavior.

Producer, Mac, iOS, and any activated server CI should consume the same fixtures
or a generated equivalent. A protocol change is incomplete until conformance,
compatibility, and redaction checks pass. Fixtures must not contain real
prompts, paths, secrets, provider data, personal names, endpoint values, or
infrastructure identifiers.

## Open decisions and gates

| Open decision                                                                                   | Required gate                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Future upstream runtime compatibility for the TLH extension hook and authoritative snapshot API | Validate only compatibility with a future pinned runtime; the current hook/snapshot seam is implemented and validated. Preserve ordinary capture, final-turn ordering, isolated-profile attestation, and no session-file tailing. |
| Phase 0B helper lifecycle                                                                       | Measure permissions, portability, CPU, memory, disk, queue, and recovery across sleep, wake, logout, restart, and crash before selecting a supervisor.                                                                            |
| Direct framing and application session security                                                 | Choose an audited maintained implementation with bounded parsing, authenticated integrity, freshness, version negotiation, and safe reconnect.                                                                                    |
| Preview cryptography and key derivation                                                         | Independent security review, platform support, key separation, replay/expiry handling, test vectors, dependency/license review, and no custom cryptography.                                                                       |
| Protected offline phone projection                                                              | Default remains no durable transcript projection; decide scope, duration, deletion UX, backups, keys, and stale-state warnings before changing it.                                                                                |
| Preview length and metadata minimization                                                        | Test payload size, extension timeout, locked-device behavior, and generic fallback before enabling decrypted previews.                                                                                                            |
| Need for a 0B server                                                                            | Prove direct/local submission is insufficient; if used, prove opaque-only storage and bounded TTL.                                                                                                                                |
| Stable Mac launch configuration                                                                 | Phase 1 productization gate with user-auditable setup, safe persistence, explicit re-pair/revoke behavior, and no private values in repository evidence.                                                                          |
| Branch UX                                                                                       | Keep tree semantics now; choose active-branch-only versus branch picker after genuine-session observations.                                                                                                                       |
| Future reply policy                                                                             | Decide live/idle eligibility, exact revision binding, streaming/busy behavior, expiry, receipts, idempotency, and offline handling before implementation.                                                                         |
| Protocol ownership transfer                                                                     | Require an ADR, fixture migration, compatibility matrix, independent reuse/release need, and coordinated versions.                                                                                                                |
| Current platform review requirements                                                            | Re-check current SDK and review documentation in Phase 3 using a clean public-safe demo.                                                                                                                                          |
| Runtime/resource limits                                                                         | Measure realistic sessions and supported devices, then document and test bounds; do not substitute stale code-size caps.                                                                                                          |

## Rejected alternatives and redesign triggers

The following alternatives are not silently reintroduced:

- Tailing persisted session JSONL as the live event source: rejected because
  flush timing and tree changes are not a reliable live transport.
- Attaching iOS to terminal stdin/stdout: rejected because it changes terminal
  ownership and ordinary habits.
- Immediately adopting an experimental upstream server/client: deferred until
  a separately approved managed-runtime variant and application-auth design.
- Using Tailscale, LAN, Bonjour, socket permissions, or an APNs token as the
  sole security boundary: rejected; pairing, authorization, freshness, and
  revocation remain application responsibilities.
- Sending plaintext previews or storing them on a server: rejected; generic
  fallback remains mandatory until encrypted previews pass their gate.
- Treating APNs as a sync log: rejected; cursor reconciliation and snapshots are
  authoritative.
- Keeping an indefinite mobile socket or token stream: rejected for Phase 0;
  foreground completed turns and resumable state are the product boundary.
- Using a hidden `SMAppService.agent`, raw launch agent, launch daemon, root
  service, or privileged helper for Phase 0A: rejected; persistent helper
  behavior belongs to Phase 0B.
- Auto-spawning a detached hidden bridge as the selected default: rejected; a
  probe may remain only as an explicitly approved conformance harness.
- Making three permanent repositories or adding a fourth protocol repository
  now: deferred/rejected until independent ownership and release cadence are
  justified.
- Implementing replies in the read-only prototype: deferred; write authority
  must be explicit and separately authorized.

Immediate safety stop conditions are: crossing into the normal profile;
following an unapproved path or symlink; accepting an unpaired or revoked
device; plaintext transcript or preview leakage; blocking or materially
changing terminal TLH; unbounded queue/disk/log growth; false login-item or
persistence claims; flattened or falsely authoritative recovery; failed
revocation or decryption fallback; a second durable transcript; or teardown
that cannot remove only managed artifacts with one idempotent command.

Product stop conditions are: no repeated useful read-only checks in genuine
sessions; recurring special launch workarounds; views that cannot be reconciled
authoritatively; or privacy/operational cost disproportionate to demonstrated
value. If ordinary-session observation cannot remain safe and nonblocking,
evaluate a clearly labeled headless-session product or stop. If background or
encrypted-preview behavior is unreliable, retain generic signaling and
foreground reconciliation rather than adding token streaming or weakening the
privacy baseline.

## Roadmap acceptance map

- Current status, reconciliations, and phase state: `Current status`,
  `Approved decisions and reconciliations`, and `Phase 0A` through `Phase 3`.
- Source integration, completed turns, tree semantics, snapshots, cursors, and
  bounded fail-open behavior: `Feasibility and architecture`.
- Pairing, local trust, TLS-PSK/Tailscale separation, Keychain profile-only
  persistence, notification privacy, retention, and teardown: `Security,
privacy, and retention invariants`.
- Actual validation evidence and its limits: `Actual Phase 0A validation
evidence`.
- Accepted, downgraded/rejected, and unverified findings for TLH, Mac, iOS, and
  cross-system work: `Review evidence register`.
- Synthetic conformance material and public-safe evidence rules: `Conformance
fixtures and evidence hygiene`.
- Future decisions, gates, alternatives, and kill criteria: `Open decisions and
gates` and `Rejected alternatives and redesign triggers`.
