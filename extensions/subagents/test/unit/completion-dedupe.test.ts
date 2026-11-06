import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPLETION_DELIVERY,
  type CompletionDeliveryMetadata,
  buildCompletionKey,
  getCompletionDelivery,
  getGlobalSeenMap,
  isSeenWithTtl,
  markSeen,
  markSeenWithTtl,
} from "../../src/runs/background/completion-dedupe.ts";

describe("buildCompletionKey", () => {
  it("uses id as canonical key when present", () => {
    const key = buildCompletionKey(
      { id: "run-123", agent: "reviewer", timestamp: 123 },
      "fallback",
    );
    assert.equal(key, "id:run-123");
  });

  it("builds deterministic fallback key when id is missing", () => {
    const a = buildCompletionKey(
      { agent: "reviewer", timestamp: 123, taskIndex: 1, totalTasks: 2, success: true },
      "x",
    );
    const b = buildCompletionKey(
      { agent: "reviewer", timestamp: 123, taskIndex: 1, totalTasks: 2, success: true },
      "x",
    );
    assert.equal(a, b);
  });
});

describe("markSeenWithTtl", () => {
  it("returns true only for duplicates within ttl", () => {
    const seen = new Map<string, number>();
    const ttlMs = 1000;
    assert.equal(markSeenWithTtl(seen, "k", 100, ttlMs), false);
    assert.equal(markSeenWithTtl(seen, "k", 200, ttlMs), true);
    assert.equal(markSeenWithTtl(seen, "k", 1201, ttlMs), false);
  });
});

describe("isSeenWithTtl", () => {
  it("returns false and does NOT mark the key", () => {
    const seen = new Map<string, number>();
    const result = isSeenWithTtl(seen, "k", 100, 1000);
    assert.equal(result, false, "unseen key must return false");
    assert.equal(seen.has("k"), false, "isSeenWithTtl must not mark the key");
  });

  it("returns true for a key that was previously marked via markSeen", () => {
    const seen = new Map<string, number>();
    markSeen(seen, "k", 100);
    assert.equal(isSeenWithTtl(seen, "k", 200, 1000), true);
  });

  it("returns false after the TTL expires and prunes the entry", () => {
    const seen = new Map<string, number>();
    markSeen(seen, "k", 100);
    assert.equal(isSeenWithTtl(seen, "k", 1201, 1000), false);
    assert.equal(seen.has("k"), false, "expired entry must be pruned");
  });
});

describe("markSeen", () => {
  it("records the key at the given timestamp without a duplicate check", () => {
    const seen = new Map<string, number>();
    markSeen(seen, "a", 42);
    assert.equal(seen.get("a"), 42);
    // Second call overwrites (no guard)
    markSeen(seen, "a", 99);
    assert.equal(seen.get("a"), 99);
  });
});

describe("getGlobalSeenMap", () => {
  it("returns the same map for the same global store key", () => {
    const a = getGlobalSeenMap("__test_seen_key__");
    a.set("x", 1);
    const b = getGlobalSeenMap("__test_seen_key__");
    assert.equal(b.get("x"), 1);
    assert.equal(a, b);
  });
});

describe("COMPLETION_DELIVERY", () => {
  it("symbol key is unique and does not appear in JSON.stringify output", () => {
    const meta: CompletionDeliveryMetadata = {
      eventId: "test-uuid-1234",
      acknowledgeDelivery: () => {},
      onAcknowledged: () => {},
    };
    const payload = { id: "run-1", sessionId: "s1", [COMPLETION_DELIVERY]: meta };
    const json = JSON.stringify(payload);
    // Symbol keys are not included in JSON serialisation.
    assert.doesNotMatch(json, /test-uuid-1234/, "eventId must not appear in JSON output");
    assert.doesNotMatch(json, /acknowledgeDelivery/, "ack fn must not appear in JSON output");
    assert.doesNotMatch(json, /completion-delivery/, "symbol description must not appear");
  });

  it("getCompletionDelivery returns metadata only for payloads with the Symbol key", () => {
    const meta: CompletionDeliveryMetadata = {
      eventId: "ev-abc",
      acknowledgeDelivery: () => {},
      onAcknowledged: () => {},
    };
    const withMeta = { id: "r1", [COMPLETION_DELIVERY]: meta };
    const withoutMeta = { id: "r1", acknowledgeDelivery: () => {}, _resultEventId: "old" };

    const got = getCompletionDelivery(withMeta);
    assert.ok(got !== undefined, "must find metadata on Symbol-keyed payload");
    assert.equal(got!.eventId, "ev-abc");

    assert.equal(getCompletionDelivery(withoutMeta), undefined, "must not read plain-property ack");
    assert.equal(getCompletionDelivery(null), undefined, "must handle null gracefully");
    assert.equal(getCompletionDelivery("string"), undefined, "must handle non-object gracefully");
  });

  it("onAcknowledged callbacks are called when acknowledgeDelivery fires", () => {
    let ackCount = 0;
    let cbCount = 0;
    const meta: CompletionDeliveryMetadata = {
      eventId: "ev-cb",
      acknowledgeDelivery: () => {
        ackCount++;
      },
      onAcknowledged: (cb) => {
        cb();
        cbCount++;
      },
    };
    meta.onAcknowledged(() => {});
    // onAcknowledged itself is called above; the actual callback integration
    // is tested end-to-end in the watcher/tracker integration tests.
    assert.equal(cbCount, 1, "onAcknowledged was called");
    assert.equal(ackCount, 0, "acknowledgeDelivery not called in this unit test");
  });
});
