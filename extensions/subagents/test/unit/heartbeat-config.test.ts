import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_HEARTBEAT_CONFIG,
  resolveHeartbeatConfig,
} from "../../src/runs/shared/heartbeat-config.ts";

describe("resolveHeartbeatConfig", () => {
  it("returns all defaults when called with no arguments", () => {
    const config = resolveHeartbeatConfig();
    assert.deepEqual(config, DEFAULT_HEARTBEAT_CONFIG);
  });

  it("defaults enabled to false", () => {
    assert.equal(resolveHeartbeatConfig().enabled, false);
  });

  it("defaults intervalMs to 255 000", () => {
    assert.equal(resolveHeartbeatConfig().intervalMs, 255_000);
  });

  it("defaults maxDurationMs to 3 600 000", () => {
    assert.equal(resolveHeartbeatConfig().maxDurationMs, 3_600_000);
  });

  it("defaults maxBeatsPerGap to 11", () => {
    assert.equal(resolveHeartbeatConfig().maxBeatsPerGap, 11);
  });

  it("accepts valid overrides from override config", () => {
    const config = resolveHeartbeatConfig(undefined, {
      enabled: true,
      intervalMs: 60_000,
      maxDurationMs: 1_800_000,
      maxBeatsPerGap: 5,
    });
    assert.equal(config.enabled, true);
    assert.equal(config.intervalMs, 60_000);
    assert.equal(config.maxDurationMs, 1_800_000);
    assert.equal(config.maxBeatsPerGap, 5);
  });

  it("override takes precedence over global config", () => {
    const config = resolveHeartbeatConfig(
      { intervalMs: 120_000, maxBeatsPerGap: 7 },
      { intervalMs: 60_000 },
    );
    assert.equal(config.intervalMs, 60_000); // override wins
    assert.equal(config.maxBeatsPerGap, 7); // global fills missing override field
  });

  it("global config fills fields absent from the override", () => {
    const config = resolveHeartbeatConfig({ intervalMs: 120_000 }, {});
    assert.equal(config.intervalMs, 120_000);
    assert.equal(config.maxDurationMs, DEFAULT_HEARTBEAT_CONFIG.maxDurationMs);
  });

  it("rejects non-integer positive-int fields and falls back to defaults", () => {
    const config = resolveHeartbeatConfig(undefined, {
      intervalMs: 0,
      maxDurationMs: -1,
      maxBeatsPerGap: 1.5,
    });
    assert.equal(config.intervalMs, DEFAULT_HEARTBEAT_CONFIG.intervalMs);
    assert.equal(config.maxDurationMs, DEFAULT_HEARTBEAT_CONFIG.maxDurationMs);
    assert.equal(config.maxBeatsPerGap, DEFAULT_HEARTBEAT_CONFIG.maxBeatsPerGap);
  });

  it("rejects Infinity for positive-int fields and falls back to defaults", () => {
    const config = resolveHeartbeatConfig(undefined, {
      intervalMs: Infinity as never,
      maxDurationMs: -Infinity as never,
    });
    assert.equal(config.intervalMs, DEFAULT_HEARTBEAT_CONFIG.intervalMs);
    assert.equal(config.maxDurationMs, DEFAULT_HEARTBEAT_CONFIG.maxDurationMs);
  });

  it("rejects string values for numeric fields and falls back to defaults", () => {
    const config = resolveHeartbeatConfig(undefined, {
      intervalMs: "60000" as never,
    });
    assert.equal(config.intervalMs, DEFAULT_HEARTBEAT_CONFIG.intervalMs);
  });

  it("preserves enabled=false when explicitly set", () => {
    const config = resolveHeartbeatConfig(undefined, { enabled: false });
    assert.equal(config.enabled, false);
  });

  it("allows enabled to be set by the global config", () => {
    const config = resolveHeartbeatConfig({ enabled: true });
    assert.equal(config.enabled, true);
  });

  // Finding 8: strict boolean validation — only actual booleans are accepted.
  it("rejects string 'true' for enabled and falls back to default (false)", () => {
    const config = resolveHeartbeatConfig(undefined, { enabled: "true" as never });
    assert.equal(config.enabled, false, "string 'true' must not enable heartbeat");
  });

  it("rejects string 'false' for enabled and falls back to default (false)", () => {
    const config = resolveHeartbeatConfig(undefined, { enabled: "false" as never });
    assert.equal(config.enabled, false, "string 'false' must be rejected — not passed as-is");
  });

  it("rejects number 1 for enabled and falls back to default (false)", () => {
    const config = resolveHeartbeatConfig(undefined, { enabled: 1 as never });
    assert.equal(config.enabled, false, "number 1 must not enable heartbeat");
  });

  it("rejects null for enabled and falls back to default (false)", () => {
    const config = resolveHeartbeatConfig(undefined, { enabled: null as never });
    assert.equal(config.enabled, false);
  });

  it("override boolean true takes precedence over global string 'true'", () => {
    // Global has invalid string value; override has valid boolean true
    const config = resolveHeartbeatConfig({ enabled: "true" as never }, { enabled: true });
    assert.equal(config.enabled, true, "boolean true in override must win");
  });

  it("global config boolean true applies when override is absent", () => {
    // Only global, valid boolean
    const config = resolveHeartbeatConfig({ enabled: true }, {});
    assert.equal(config.enabled, true);
  });

  it("global config string 'true' is rejected; falls back to default false", () => {
    const config = resolveHeartbeatConfig({ enabled: "true" as never }, {});
    assert.equal(config.enabled, false);
  });
});
