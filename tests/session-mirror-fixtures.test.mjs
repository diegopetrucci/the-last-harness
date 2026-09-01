import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const repoRoot = resolve(import.meta.dirname, "..");
const profileDir = join(repoRoot, "protocol", "session-mirror", "v1");
const fixtureDir = join(profileDir, "fixtures");
const manifestPath = join(profileDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const packageManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

const REQUIRED_CAPABILITIES = [
  "session-tree",
  "completed-turns-only",
  "snapshot",
  "cursor-recovery",
  "custom-entries",
  "coarse-status",
];
const REQUIRED_EVENT_TYPES = new Set([
  "turn.completed",
  "active-leaf.changed",
  "status.changed",
  "summary.updated",
  "session.compacted",
]);
const REQUIRED_COVERAGE = [
  "empty-session",
  "branched-session",
  "multi-root",
  "non-empty-null-active",
  "interior-active",
  "active-leaf-change",
  "active-leaf-from-null",
  "active-leaf-clear",
  "completed-assistant-turn",
  "snapshot-replacement",
  "cursor-recovery",
  "compaction",
  "compaction-event",
  "inline-summary",
  "first-kept-entry",
  "summary",
  "source-placeholder-tool",
  "source-placeholder-provider",
  "source-placeholder-image",
  "source-placeholder-custom",
  "source-placeholder-unsupported",
  "unknown-custom-entry",
  "unknown-envelope-metadata",
  "unknown-known-entry-field",
  "coarse-status",
];
const KNOWN_ENTRY_KINDS = new Set([
  "user-turn",
  "assistant-turn",
  "summary",
  "compaction",
  "source-placeholder",
]);
const SOURCE_PLACEHOLDER_TYPES = new Set(["tool", "provider", "image", "custom", "unsupported"]);
const { SESSION_MIRROR_FAILURE_CATEGORIES } = await createJiti(import.meta.url).import(
  "../protocol/session-mirror/v1/conformance.ts",
);
const CLOSED_FAILURE_CATEGORIES = new Set(SESSION_MIRROR_FAILURE_CATEGORIES);
const FORBIDDEN_STREAMING_CAPABILITIES = new Set([
  "assistant-streaming",
  "assistant-delta",
  "assistant-token",
]);

function fixturePath(item) {
  return join(profileDir, item.path);
}

function readFixture(item) {
  return JSON.parse(readFileSync(fixturePath(item), "utf8"));
}

function collectStringValues(value, key = "", output = []) {
  if (typeof value === "string") {
    output.push({ key, value });
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      collectStringValues(child, key, output);
    }
    return output;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      collectStringValues(child, childKey, output);
    }
  }
  return output;
}

function entriesIn(fixture) {
  return fixture.message?.snapshot?.tree?.entries ?? [];
}

function assertCompletedAssistantEntry(entry, label) {
  assert.equal(entry.kind, "assistant-turn", `${label} must be an assistant turn`);
  assert.equal(entry.status, "completed", `${label} must be completed`);
  assert.ok(entry.payload && typeof entry.payload === "object");
  assert.ok(entry.payload.content && typeof entry.payload.content === "object");
  assert.deepEqual(Object.keys(entry.payload.content).sort(), ["format", "text"]);
  assert.equal(entry.payload.content.format, "text");
  assert.equal(typeof entry.payload.content.text, "string");
}

function assertTreeInvariants(tree, label) {
  assert.ok(tree && typeof tree === "object", `${label} must be an object`);
  assert.ok(Array.isArray(tree.entries), `${label}.entries must be an array`);

  const entriesById = new Map();
  for (const entry of tree.entries) {
    assert.ok(entry && typeof entry === "object", `${label} has an invalid entry`);
    assert.equal(typeof entry.id, "string", `${label} entry id must be a string`);
    assert.ok(entry.id.length > 0, `${label} entry id must be non-empty`);
    assert.equal(entriesById.has(entry.id), false, `${label} has duplicate entry id ${entry.id}`);
    entriesById.set(entry.id, entry);
    assert.equal(
      entry.parentId === null || typeof entry.parentId === "string",
      true,
      `${label} entry ${entry.id} has an invalid parent id`,
    );
    assert.equal(typeof entry.kind, "string", `${label} entry ${entry.id} kind must be a string`);
    assert.ok(entry.payload && typeof entry.payload === "object");
    if (KNOWN_ENTRY_KINDS.has(entry.kind)) {
      assert.equal(entry.status, "completed", `${label} known entry ${entry.id} must be completed`);
    }
    if (entry.kind === "assistant-turn") {
      assertCompletedAssistantEntry(entry, `${label} entry ${entry.id}`);
    }
    if (entry.kind === "source-placeholder") {
      assert.deepEqual(Object.keys(entry).sort(), ["id", "kind", "parentId", "payload", "status"]);
      assert.deepEqual(Object.keys(entry.payload), ["sourceType"]);
      assert.equal(SOURCE_PLACEHOLDER_TYPES.has(entry.payload.sourceType), true);
    }
  }

  const empty = tree.entries.length === 0;
  assert.equal(Array.isArray(tree.rootIds), true, `${label}.rootIds must be an array`);
  assert.equal(tree.activeLeafId === null || typeof tree.activeLeafId === "string", true);
  if (empty) {
    assert.deepEqual(tree.rootIds, []);
    assert.equal(tree.activeLeafId, null);
    return;
  }

  const roots = tree.entries.filter((entry) => entry.parentId === null);
  assert.equal(tree.rootIds.length, roots.length, `${label}.rootIds must list every root`);
  assert.deepEqual(
    new Set(tree.rootIds),
    new Set(roots.map((entry) => entry.id)),
    `${label}.rootIds must identify every root`,
  );
  for (const rootId of tree.rootIds) {
    assert.equal(entriesById.has(rootId), true, `${label}.rootIds must identify an entry`);
    assert.equal(
      entriesById.get(rootId).parentId,
      null,
      `${label}.rootIds must identify only roots`,
    );
  }
  if (tree.activeLeafId !== null) {
    assert.ok(entriesById.has(tree.activeLeafId), `${label}.activeLeafId must identify an entry`);
  }
  for (const entry of tree.entries) {
    if (entry.kind === "compaction") {
      assert.equal(typeof entry.payload.summary, "string");
      assert.equal(typeof entry.payload.firstKeptEntryId, "string");
      assert.ok(
        entriesById.has(entry.payload.firstKeptEntryId),
        `${label} compaction firstKeptEntryId must identify an entry`,
      );
    }
  }

  const childrenById = new Map();
  for (const entry of tree.entries) {
    if (entry.parentId !== null) {
      assert.ok(entriesById.has(entry.parentId), `${label} parent ${entry.parentId} must exist`);
      assert.notEqual(entry.parentId, entry.id, `${label} entry ${entry.id} cannot parent itself`);
      const children = childrenById.get(entry.parentId) ?? [];
      children.push(entry.id);
      childrenById.set(entry.parentId, children);
    }
  }

  const visited = new Set();
  const visiting = new Set();
  function visit(entryId) {
    if (visiting.has(entryId)) {
      assert.fail(`${label} contains a parent cycle at ${entryId}`);
    }
    if (visited.has(entryId)) {
      return;
    }
    visiting.add(entryId);
    const parentId = entriesById.get(entryId).parentId;
    if (parentId !== null) {
      visit(parentId);
    }
    visiting.delete(entryId);
    visited.add(entryId);
  }
  for (const entry of tree.entries) {
    visit(entry.id);
  }
}

test("session-mirror manifest inventories every repository-local fixture exactly once", () => {
  assert.deepEqual(manifest.profile, {
    family: "session-mirror",
    major: 1,
    minor: 0,
  });
  assert.equal(manifest.manifestVersion, 1);
  assert.ok(Array.isArray(manifest.fixtures));
  assert.ok(manifest.fixtures.length > 0);

  const ids = new Set();
  const paths = new Set();
  for (const item of manifest.fixtures) {
    assert.equal(typeof item.id, "string");
    assert.match(item.id, /^(?:valid|invalid)-[a-z0-9-]+$/);
    assert.equal(ids.has(item.id), false, `duplicate fixture id: ${item.id}`);
    ids.add(item.id);

    assert.equal(typeof item.path, "string");
    assert.match(item.path, /^fixtures\/[a-z0-9-]+\.json$/);
    assert.equal(paths.has(item.path), false, `duplicate fixture path: ${item.path}`);
    paths.add(item.path);
    assert.equal(item.id, basename(item.path, ".json"));

    const path = fixturePath(item);
    assert.equal(relative(fixtureDir, path).startsWith(".."), false);
    assert.equal(lstatSync(path).isFile(), true);
    assert.doesNotThrow(() => readFixture(item));

    assert.equal(typeof item.valid, "boolean");
    assert.ok(Array.isArray(item.covers) && item.covers.length > 0);
    if ("applyAfter" in item) {
      assert.equal(typeof item.applyAfter, "string");
      assert.notEqual(item.applyAfter, item.id);
    }
    if (item.valid) {
      assert.equal("expectedFailureCategory" in item, false);
    } else {
      assert.match(item.expectedFailureCategory, /^[a-z][a-z0-9-]+$/);
      assert.equal(
        CLOSED_FAILURE_CATEGORIES.has(item.expectedFailureCategory),
        true,
        `${item.id} uses an undeclared failure category`,
      );
    }
  }

  for (const [itemIndex, item] of manifest.fixtures.entries()) {
    if ("applyAfter" in item) {
      const prerequisiteIndex = manifest.fixtures.findIndex(
        (candidate) => candidate.id === item.applyAfter,
      );
      assert.ok(prerequisiteIndex >= 0, `${item.id} references an unknown applyAfter fixture`);
      assert.ok(prerequisiteIndex < itemIndex, `${item.id} must follow its applyAfter fixture`);
      assert.equal(manifest.fixtures[prerequisiteIndex].valid, true);
    }
  }

  const actualFiles = readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => `fixtures/${name}`)
    .sort();
  assert.deepEqual([...paths].sort(), actualFiles);
});

test("valid fixtures keep the v1 envelope shape and message payloads nested", () => {
  const validFixtures = manifest.fixtures.filter((item) => item.valid);
  assert.ok(validFixtures.length > 0);

  for (const item of validFixtures) {
    const fixture = readFixture(item);
    for (const requiredKey of ["capabilities", "message", "protocol", "sessionId", "source"]) {
      assert.equal(Object.hasOwn(fixture, requiredKey), true, `${item.id} lacks ${requiredKey}`);
    }
    assert.deepEqual(fixture.protocol, {
      family: "session-mirror",
      major: 1,
      minor: 0,
    });
    assert.deepEqual(Object.keys(fixture.source).sort(), [
      "runtimeVersion",
      "sessionSchemaVersion",
    ]);
    assert.deepEqual(fixture.capabilities, REQUIRED_CAPABILITIES);
    assert.equal(
      fixture.capabilities.every((capability) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(capability)),
      true,
    );
    assert.equal(
      fixture.capabilities.some((capability) => FORBIDDEN_STREAMING_CAPABILITIES.has(capability)),
      false,
    );
    assert.equal(typeof fixture.sessionId, "string");
    assert.ok(fixture.sessionId.length > 0);

    const { message } = fixture;
    assert.equal(typeof message, "object");
    assert.equal(typeof message.eventId, "string");
    assert.ok(message.eventId.length > 0);
    assert.equal(Number.isInteger(message.revision), true);
    assert.ok(message.revision >= 0);
    assert.equal(typeof message.cursor, "string");
    assert.ok(message.cursor.length > 0);
    assert.equal("snapshot" in fixture, false);
    assert.equal("replacement" in fixture, false);
    assert.equal("event" in fixture, false);
    assert.equal("revision" in fixture, false);
    assert.equal("cursor" in fixture, false);

    if (message.kind === "snapshot") {
      assert.equal(message.operation, "replace");
      assert.ok(message.snapshot && typeof message.snapshot === "object");
      assert.equal(typeof message.snapshot.snapshotId, "string");
      assert.ok(message.snapshot.snapshotId.length > 0);
      assert.ok(message.snapshot.snapshotId.length <= 128);
      assert.equal("event" in message, false);
      assert.equal("baseRevision" in message, false);
      assert.ok(message.snapshot.tree && Array.isArray(message.snapshot.tree.entries));
    } else {
      assert.equal(message.kind, "event");
      assert.equal(message.operation, "append");
      assert.equal(message.baseRevision, message.revision - 1);
      assert.ok(message.event && typeof message.event === "object");
      assert.ok(REQUIRED_EVENT_TYPES.has(message.event.type));
      assert.equal("snapshot" in message, false);
      if (
        message.event.type === "turn.completed" &&
        message.event.entry.kind === "assistant-turn"
      ) {
        assertCompletedAssistantEntry(message.event.entry, `${item.id} completed event`);
      }
    }
  }
});

test("valid snapshot fixtures satisfy tree and completed-entry invariants", () => {
  const snapshotFixtures = manifest.fixtures.filter((item) => {
    const fixture = readFixture(item);
    return item.valid && fixture.message.kind === "snapshot";
  });
  assert.ok(snapshotFixtures.length > 0);
  for (const item of snapshotFixtures) {
    const fixture = readFixture(item);
    assertTreeInvariants(fixture.message.snapshot.tree, item.id);
  }
});

test("all snapshot payloads carry a bounded opaque snapshot identity", () => {
  const snapshotFixtures = manifest.fixtures.filter((item) => {
    const fixture = readFixture(item);
    return fixture.message?.kind === "snapshot";
  });
  assert.ok(snapshotFixtures.length > 0);
  for (const item of snapshotFixtures) {
    const snapshot = readFixture(item).message.snapshot;
    assert.equal(typeof snapshot.snapshotId, "string", `${item.id} needs snapshotId`);
    assert.ok(snapshot.snapshotId.length > 0);
    assert.ok(snapshot.snapshotId.length <= 128);
  }
});

test("manifest coverage includes tree, completed-turn, replacement, summary, custom, and status cases", () => {
  const covered = new Set(
    manifest.fixtures.filter((item) => item.valid).flatMap((item) => item.covers),
  );
  for (const scenario of REQUIRED_COVERAGE) {
    assert.equal(covered.has(scenario), true, `missing valid fixture coverage: ${scenario}`);
  }

  const branched = readFixture(
    manifest.fixtures.find((item) => item.id === "valid-branched-session"),
  );
  const branchedEntries = entriesIn(branched);
  assert.equal(new Set(branchedEntries.map((entry) => entry.parentId)).has("entry-b1"), true);
  assert.equal(branched.message.snapshot.tree.activeLeafId, "entry-b1");
  assert.ok(
    branchedEntries.some(
      (entry) =>
        entry.parentId === "entry-b1" && entry.id !== branched.message.snapshot.tree.activeLeafId,
    ),
  );
  assert.ok(
    branchedEntries
      .filter((entry) => entry.kind === "assistant-turn")
      .every((entry) => entry.status === "completed"),
  );

  const replacement = readFixture(
    manifest.fixtures.find((item) => item.id === "valid-snapshot-replacement"),
  );
  assert.equal(replacement.message.operation, "replace");
  assert.deepEqual(replacement.message.replaces, {
    snapshotId: "opaque-snapshot-e2",
    revision: 2,
    cursor: "opaque-cursor-e2",
  });
  assert.ok(replacement.message.replaces.revision < replacement.message.revision);
  assert.notEqual(replacement.message.replaces.snapshotId, replacement.message.snapshot.snapshotId);
  assert.notEqual(replacement.message.replaces.cursor, replacement.message.cursor);
  assert.equal(
    manifest.fixtures
      .find((item) => item.id === "valid-snapshot-replacement")
      .covers.includes("cursor-recovery"),
    true,
  );

  const activeLeafItem = manifest.fixtures.find((item) => item.id === "valid-active-leaf-change");
  const activeLeafChange = readFixture(activeLeafItem);
  assert.equal(activeLeafItem.covers.includes("cursor-recovery"), false);
  assert.equal(activeLeafChange.message.event.previousActiveLeafId, null);
  assert.equal(typeof activeLeafChange.message.event.activeLeafId, "string");
  assert.notEqual(activeLeafChange.message.event.activeLeafId, null);

  const activeLeafClearedItem = manifest.fixtures.find(
    (item) => item.id === "valid-active-leaf-cleared",
  );
  const activeLeafCleared = readFixture(activeLeafClearedItem);
  assert.equal(activeLeafCleared.message.event.previousActiveLeafId, "entry-c4");
  assert.equal(activeLeafCleared.message.event.activeLeafId, null);

  const custom = readFixture(manifest.fixtures.find((item) => item.id === "valid-custom-entry"));
  assert.deepEqual(custom.metadata, {
    marker: "synthetic-envelope-metadata",
    ordinal: 3,
  });
  const knownEntry = entriesIn(custom).find((entry) => entry.kind === "user-turn");
  assert.deepEqual(knownEntry.unknownMetadata, {
    marker: "synthetic-known-entry-field",
    ordinal: 9,
  });
  const customEntry = entriesIn(custom).find((entry) => entry.kind === "custom.note");
  assert.ok(customEntry);
  assert.deepEqual(customEntry.payload.unknownField, {
    preserve: true,
    value: "synthetic-preserved-value",
  });

  const compacted = readFixture(
    manifest.fixtures.find((item) => item.id === "valid-compaction-summary"),
  );
  const compactedEntries = entriesIn(compacted);
  const compactedKinds = new Set(compactedEntries.map((entry) => entry.kind));
  assert.equal(compactedKinds.has("summary"), false);
  assert.equal(compactedKinds.has("compaction"), true);
  const compactionEntry = compactedEntries.find((entry) => entry.kind === "compaction");
  assert.equal(typeof compactionEntry.payload.summary, "string");
  assert.equal(compactionEntry.payload.firstKeptEntryId, "entry-f2");
  assert.equal(
    compactedEntries.some((entry) => entry.id === compactionEntry.payload.firstKeptEntryId),
    true,
  );

  const compactionEvent = readFixture(
    manifest.fixtures.find((item) => item.id === "valid-compaction-event"),
  );
  assert.equal(compactionEvent.message.event.type, "session.compacted");
  assert.equal(compactionEvent.message.event.entry.kind, "compaction");
  assert.equal(compactionEvent.message.event.entry.status, "completed");
  assert.equal("compactedEntryIds" in compactionEvent.message.event, false);
  assert.equal("summaryEntryId" in compactionEvent.message.event.entry.payload, false);
  assert.equal("compactedEntryIds" in compactionEvent.message.event.entry.payload, false);
  assert.equal(typeof compactionEvent.message.event.entry.payload.summary, "string");
  assert.equal(compactionEvent.message.event.entry.payload.firstKeptEntryId, "entry-r2");
});

test("invalid fixture inventory names stable future conformance failure categories", () => {
  const invalidFixtures = manifest.fixtures.filter((item) => !item.valid);
  assert.ok(invalidFixtures.length > 0);
  assert.ok(invalidFixtures.every((item) => item.expectedFailureCategory));

  const byCategory = new Map();
  for (const item of invalidFixtures) {
    assert.equal(byCategory.has(item.id), false);
    byCategory.set(item.id, item.expectedFailureCategory);
    assert.doesNotThrow(() => readFixture(item));
  }

  assert.equal(byCategory.get("invalid-malformed-envelope"), "malformed-envelope");
  const malformed = readFixture(
    manifest.fixtures.find((item) => item.id === "invalid-malformed-envelope"),
  );
  assert.deepEqual(malformed.protocol, { family: "session-mirror", major: 1 });
  assert.equal(Number.isInteger(malformed.message.revision), true);
  assert.equal(typeof malformed.message.cursor, "string");
  assert.deepEqual(malformed.message.snapshot.tree, {
    activeLeafId: null,
    entries: [],
    rootIds: [],
  });

  assert.equal(byCategory.get("invalid-bounds-exceeded"), "bounds-exceeded");
  assert.equal(byCategory.get("invalid-compaction-bounds"), "bounds-exceeded");
  assert.equal(byCategory.get("invalid-compaction-structure"), "malformed-envelope");
  assert.equal(byCategory.get("invalid-malformed-root-ids"), "malformed-envelope");
  assert.equal(byCategory.get("invalid-active-leaf-reference"), "malformed-envelope");
  assert.equal(byCategory.get("invalid-source-placeholder-field"), "malformed-envelope");
  assert.equal(byCategory.get("invalid-source-placeholder-category"), "malformed-envelope");
  assert.equal(byCategory.get("invalid-incompatible-protocol"), "incompatible-protocol");
  assert.equal(byCategory.get("invalid-incompatible-capability"), "incompatible-capability");
  assert.deepEqual(
    manifest.fixtures.find((item) => item.id === "invalid-incompatible-capability").covers,
    ["missing-required-capability"],
  );
  assert.equal(byCategory.get("invalid-incompatible-message"), "incompatible-message-kind");
  assert.equal(byCategory.get("invalid-forbidden-streaming-capability"), "forbidden-streaming");
  assert.equal(byCategory.get("invalid-forbidden-assistant-content"), "forbidden-streaming");
  const forbiddenContent = readFixture(
    manifest.fixtures.find((item) => item.id === "invalid-forbidden-assistant-content"),
  );
  assert.equal(forbiddenContent.message.snapshot.tree.entries[1].kind, "assistant-turn");
  assert.equal(forbiddenContent.message.snapshot.tree.entries[1].payload.content.partial, true);
  assert.equal(byCategory.get("invalid-forbidden-assistant-delta"), "forbidden-streaming");
  assert.equal(byCategory.get("invalid-forbidden-assistant-token"), "forbidden-streaming");
  assert.equal(byCategory.get("invalid-incomplete-assistant-turn"), "incomplete-turn");
  assert.equal(byCategory.get("invalid-revision-gap"), "revision-gap");
  assert.equal(byCategory.get("invalid-conflicting-duplicate"), "conflicting-duplicate");

  const revisionGapItem = manifest.fixtures.find((item) => item.id === "invalid-revision-gap");
  assert.equal(revisionGapItem.applyAfter, "valid-status-update");
  const revisionGap = readFixture(revisionGapItem);
  const revisionBaseline = readFixture(
    manifest.fixtures.find((item) => item.id === revisionGapItem.applyAfter),
  );
  assert.equal(revisionGap.sessionId, revisionBaseline.sessionId);
  assert.notEqual(revisionGap.message.eventId, revisionBaseline.message.eventId);
  assert.equal(revisionGap.message.kind, "event");
  assert.equal(revisionGap.message.operation, "append");
  assert.equal(revisionGap.message.baseRevision, revisionGap.message.revision - 1);
  assert.ok(revisionGap.message.baseRevision > revisionBaseline.message.revision);
  assert.ok(revisionGap.message.revision > revisionBaseline.message.revision + 1);

  const incompatibleCapability = readFixture(
    manifest.fixtures.find((item) => item.id === "invalid-incompatible-capability"),
  );
  assert.deepEqual(
    incompatibleCapability.capabilities,
    REQUIRED_CAPABILITIES.filter((capability) => capability !== "cursor-recovery"),
  );

  const forbiddenCapability = readFixture(
    manifest.fixtures.find((item) => item.id === "invalid-forbidden-streaming-capability"),
  );
  assert.ok(
    forbiddenCapability.capabilities.some((capability) =>
      FORBIDDEN_STREAMING_CAPABILITIES.has(capability),
    ),
  );
  assert.equal(forbiddenCapability.capabilities.includes("assistant-streaming"), true);

  const boundsExceeded = readFixture(
    manifest.fixtures.find((item) => item.id === "invalid-bounds-exceeded"),
  );
  assert.ok(boundsExceeded.message.cursor.length > 256);

  const compactionBounds = readFixture(
    manifest.fixtures.find((item) => item.id === "invalid-compaction-bounds"),
  );
  const compactionBoundEntry = entriesIn(compactionBounds).find(
    (entry) => entry.kind === "compaction",
  );
  assert.ok(compactionBoundEntry.payload.summary.length > 32 * 1024);

  const placeholderFixture = readFixture(
    manifest.fixtures.find((item) => item.id === "valid-source-placeholders"),
  );
  assert.deepEqual(
    placeholderFixture.message.snapshot.tree.rootIds,
    entriesIn(placeholderFixture).map((entry) => entry.id),
  );
  assert.deepEqual(
    new Set(entriesIn(placeholderFixture).map((entry) => entry.payload.sourceType)),
    SOURCE_PLACEHOLDER_TYPES,
  );

  const duplicateItem = manifest.fixtures.find(
    (item) => item.id === "invalid-conflicting-duplicate",
  );
  assert.equal(duplicateItem.applyAfter, "valid-status-update");
  const duplicate = readFixture(duplicateItem);
  const applied = readFixture(
    manifest.fixtures.find((item) => item.id === duplicateItem.applyAfter),
  );
  assert.equal(duplicate.sessionId, applied.sessionId);
  assert.equal(duplicate.message.eventId, applied.message.eventId);
  assert.equal(duplicate.message.revision, applied.message.revision);
  assert.equal(duplicate.message.cursor, applied.message.cursor);
  assert.notDeepEqual(duplicate.message.event, applied.message.event);

  const forbiddenKinds = invalidFixtures
    .map(readFixture)
    .map((fixture) => fixture.message?.event?.type)
    .filter(Boolean);
  assert.ok(forbiddenKinds.includes("assistant.delta"));
  assert.ok(forbiddenKinds.includes("assistant.token"));
});

test("synthetic fixture content contains no sensitive or infrastructure identifiers", () => {
  const unsafePatterns = [
    { name: "personal path", pattern: /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|~\/)/i },
    {
      name: "credential assignment",
      pattern: /(?:api[_ -]?key|access[_ -]?token|password|secret|private[_ -]?key|bearer)\s*[:=]/i,
    },
    {
      name: "credential token",
      pattern: /\b(?:sk|ghp|github_pat|xox[bap])[-_][A-Za-z0-9_-]{10,}\b/i,
    },
    {
      name: "URL or hostname",
      pattern: /\b(?:https?|wss?):\/\/|\b[a-z0-9-]+\.(?:com|net|org|io|dev|local)\b/i,
    },
    {
      name: "provider identifier",
      pattern: /\b(?:anthropic|openai|azure|bedrock|gemini|claude|gpt)\b/i,
    },
    { name: "IPv4 address", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
    { name: "UUID or infrastructure digest", pattern: /\b[0-9a-f]{32,}\b/i },
  ];

  for (const item of manifest.fixtures) {
    const raw = readFileSync(fixturePath(item), "utf8");
    for (const { name, pattern } of unsafePatterns) {
      assert.equal(pattern.test(raw), false, `${item.id} contains a ${name}`);
    }
    for (const { key, value } of collectStringValues(readFixture(item))) {
      if (["text", "summary"].includes(key)) {
        assert.match(value, /^synthetic\b/, `${item.id}.${key} must be synthetic content`);
      }
    }
  }
});

test("the repository-local profile is not wired into package publication", () => {
  assert.equal(
    packageManifest.files.some((entry) => entry === "protocol" || entry.startsWith("protocol/")),
    false,
  );
  assert.equal(dirname(manifestPath), join(repoRoot, "protocol", "session-mirror", "v1"));
});
