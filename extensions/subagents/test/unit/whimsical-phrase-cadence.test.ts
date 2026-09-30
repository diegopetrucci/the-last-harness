/**
 * Unit tests for the time-cadence phrase selection introduced in tmp-wkpw.
 *
 * Verifies:
 * - Stable within an 8 s window regardless of turnCount changes.
 * - Advances to the next slot when the window boundary is crossed.
 * - Falls back to turnCount-based selection when timing inputs are missing.
 * - needs_attention suppression is unchanged.
 * - elapsedMs API (for foreground card that has durationMs but not startedAt).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PHRASE_HOLD_MS,
  WHIMSICAL_THINKING_PHRASES,
  whimsicalThinkingPhrase,
} from "../../src/tui/whimsical-phrases.ts";
import { compactThinkingPhrase } from "../../src/tui/render-primitives.ts";

describe("whimsicalThinkingPhrase – time-cadence selection", () => {
  it("returns a string from the pool when both timing inputs are present", () => {
    const phrase = whimsicalThinkingPhrase(0, 10_000, 2_000);
    assert.ok(typeof phrase === "string" && phrase.length > 0);
    assert.ok(
      (WHIMSICAL_THINKING_PHRASES as readonly string[]).includes(phrase),
      "returned phrase must be in the pool",
    );
  });

  it("is stable within an 8 s window regardless of turnCount", () => {
    const startedAt = 0;
    // Snapshot at 1 s, 4 s, and 7.999 s – all within the first window.
    const phrase1s = whimsicalThinkingPhrase(0, 1_000, startedAt);
    const phrase4s = whimsicalThinkingPhrase(3, 4_000, startedAt);
    const phrase7s = whimsicalThinkingPhrase(99, 7_999, startedAt);
    assert.equal(phrase1s, phrase4s, "phrase must not change within window (1s vs 4s)");
    assert.equal(phrase1s, phrase7s, "phrase must not change within window (1s vs 7.999s)");
  });

  it("advances exactly at the 8 s boundary", () => {
    const startedAt = 0;
    const phraseBefore = whimsicalThinkingPhrase(0, PHRASE_HOLD_MS - 1, startedAt);
    const phraseAt = whimsicalThinkingPhrase(0, PHRASE_HOLD_MS, startedAt);
    assert.notEqual(phraseBefore, phraseAt, "phrase must change at the 8 s boundary");
  });

  it("continues advancing each additional 8 s window", () => {
    const startedAt = 0;
    const phrases = [0, 1, 2, 3].map((slot) =>
      whimsicalThinkingPhrase(0, slot * PHRASE_HOLD_MS, startedAt),
    );
    const unique = new Set(phrases);
    assert.equal(unique.size, 4, "each 8 s slot must produce a distinct phrase");
  });

  it("cycles through the full pool and wraps without repeating within a cycle", () => {
    const startedAt = 0;
    const cycle = Array.from({ length: WHIMSICAL_THINKING_PHRASES.length }, (_, slot) =>
      whimsicalThinkingPhrase(0, slot * PHRASE_HOLD_MS, startedAt),
    );
    assert.equal(
      new Set(cycle).size,
      WHIMSICAL_THINKING_PHRASES.length,
      "must visit every phrase exactly once per cycle",
    );
    // First phrase of the second cycle matches the first phrase of the first cycle.
    const wrapPhrase = whimsicalThinkingPhrase(
      0,
      WHIMSICAL_THINKING_PHRASES.length * PHRASE_HOLD_MS,
      startedAt,
    );
    assert.equal(wrapPhrase, cycle[0], "must wrap back to cycle start");
  });

  it("falls back to turnCount selection when snapshotNow is absent", () => {
    const phraseByTurn5 = whimsicalThinkingPhrase(5);
    const phraseByTurn5Explicit = whimsicalThinkingPhrase(5, undefined, 0);
    assert.equal(
      phraseByTurn5,
      phraseByTurn5Explicit,
      "omitting snapshotNow must trigger turnCount fallback",
    );
  });

  it("falls back to turnCount selection when startedAt is absent", () => {
    const phraseByTurn3 = whimsicalThinkingPhrase(3);
    const phraseByTurn3Explicit = whimsicalThinkingPhrase(3, 10_000, undefined);
    assert.equal(
      phraseByTurn3,
      phraseByTurn3Explicit,
      "omitting startedAt must trigger turnCount fallback",
    );
  });

  it("falls back to turnCount 0 when both timing inputs and turnCount are absent", () => {
    const phraseDefault = whimsicalThinkingPhrase();
    const phrase0 = whimsicalThinkingPhrase(0);
    assert.equal(phraseDefault, phrase0, "no-arg call must equal turnCount 0");
  });

  it("handles negative elapsed time gracefully (clamps to slot 0)", () => {
    // startedAt is in the future relative to snapshotNow
    const phrase = whimsicalThinkingPhrase(0, 1_000, 5_000);
    const slot0 = whimsicalThinkingPhrase(0);
    assert.equal(phrase, slot0, "negative elapsed must clamp to slot 0");
  });

  it("handles non-finite timing inputs by falling back to turnCount", () => {
    const phraseByTurn2 = whimsicalThinkingPhrase(2);
    assert.equal(
      whimsicalThinkingPhrase(2, NaN, 0),
      phraseByTurn2,
      "NaN snapshotNow must fall back",
    );
    assert.equal(
      whimsicalThinkingPhrase(2, Infinity, 0),
      phraseByTurn2,
      "Infinity snapshotNow must fall back",
    );
    assert.equal(whimsicalThinkingPhrase(2, 0, NaN), phraseByTurn2, "NaN startedAt must fall back");
  });
});

describe("compactThinkingPhrase – time-cadence integration", () => {
  it("returns undefined for needs_attention regardless of timing inputs", () => {
    assert.equal(
      compactThinkingPhrase("needs_attention", 0, 10_000, 0),
      undefined,
      "needs_attention must suppress the phrase",
    );
    assert.equal(
      compactThinkingPhrase("needs_attention", 5),
      undefined,
      "needs_attention must suppress with turnCount fallback too",
    );
  });

  it("returns a time-based phrase when both snapshotNow and startedAt are provided", () => {
    const startedAt = 0;
    const snapshotNow = 4_000; // slot 0
    const phrase = compactThinkingPhrase(undefined, 99, snapshotNow, startedAt);
    assert.notEqual(phrase, undefined);
    // Slot 0 phrase must equal the turnCount-0 fallback (same ORDER index).
    assert.equal(phrase, whimsicalThinkingPhrase(0));
  });

  it("falls back to turnCount when startedAt is missing", () => {
    const phrase = compactThinkingPhrase(undefined, 7, 10_000, undefined);
    assert.equal(phrase, whimsicalThinkingPhrase(7));
  });

  it("advances phrase between windows", () => {
    const startedAt = 0;
    const phraseSlot0 = compactThinkingPhrase(undefined, 0, 0, startedAt);
    const phraseSlot1 = compactThinkingPhrase(undefined, 0, PHRASE_HOLD_MS, startedAt);
    assert.notEqual(phraseSlot0, phraseSlot1, "phrase must advance at window boundary");
  });

  it("accepts elapsedMs to select slot directly, stable within window across turnCount", () => {
    const slot0Phrase = compactThinkingPhrase(undefined, 0, undefined, undefined, 0);
    const slot0PhraseHighTurn = compactThinkingPhrase(
      undefined,
      99,
      undefined,
      undefined,
      PHRASE_HOLD_MS - 1,
    );
    assert.equal(
      slot0Phrase,
      slot0PhraseHighTurn,
      "elapsedMs within first window must give the same phrase regardless of turnCount",
    );
  });

  it("elapsedMs advances phrase at the 8 s boundary", () => {
    const phraseSlot0 = compactThinkingPhrase(
      undefined,
      0,
      undefined,
      undefined,
      PHRASE_HOLD_MS - 1,
    );
    const phraseSlot1 = compactThinkingPhrase(undefined, 0, undefined, undefined, PHRASE_HOLD_MS);
    assert.notEqual(phraseSlot0, phraseSlot1, "phrase must advance when elapsedMs hits boundary");
  });

  it("elapsedMs takes priority over snapshotNow/startedAt", () => {
    // elapsedMs=0 \ slot 0; snapshotNow/startedAt would give slot 1 if used.
    const phraseViaElapsed = compactThinkingPhrase(undefined, 0, PHRASE_HOLD_MS, 0, 0);
    const phraseSlot0 = compactThinkingPhrase(undefined, 0, undefined, undefined, 0);
    assert.equal(
      phraseViaElapsed,
      phraseSlot0,
      "elapsedMs must take priority over snapshotNow/startedAt",
    );
  });

  it("falls back to turnCount when elapsedMs is undefined or non-finite", () => {
    const phraseByTurn4 = whimsicalThinkingPhrase(4);
    assert.equal(
      compactThinkingPhrase(undefined, 4, undefined, undefined, undefined),
      phraseByTurn4,
      "undefined elapsedMs must fall back to turnCount",
    );
    assert.equal(
      compactThinkingPhrase(undefined, 4, undefined, undefined, NaN),
      phraseByTurn4,
      "NaN elapsedMs must fall back to turnCount",
    );
  });
});
