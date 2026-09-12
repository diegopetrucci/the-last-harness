/** Deterministic foreground watchdog health regressions. */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import {
  available,
  mockAssistantMessage,
  runSync,
  type RunSyncResult,
} from "../support/single-execution-fixtures.ts";
import { ACTIVITY_MONITOR_GAP_THRESHOLD_MS } from "../../src/runs/shared/health-transition.ts";

type ControlEvent = NonNullable<RunSyncResult["controlEvents"]>[number];

const IDLE_CONTROL_CONFIG = {
  enabled: true,
  needsAttentionAfterMs: 200,
  activeNoticeAfterMs: 999_999,
  activeNoticeAfterTurns: 999_999,
  activeNoticeAfterTokens: 999_999,
  notifyOn: ["active_long_running", "needs_attention"],
} as const;

describe(
  "foreground execution health",
  { skip: !available ? "pi packages not available" : undefined },
  () => {
    let tempDir: string;
    let mockPi: MockPi;

    before(() => {
      mockPi = createMockPi();
      mockPi.install();
    });

    after(() => {
      mockPi.uninstall();
    });

    beforeEach(() => {
      tempDir = createTempDir();
      mockPi.reset();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    it("does not charge a delayed foreground monitor tick as idle time", async () => {
      const release = path.join(tempDir, "foreground-monitor-gap-release");
      mockPi.onCall({
        steps: [
          { jsonl: [mockAssistantMessage("quiet baseline", "tool_use")] },
          { waitForMarker: release },
          { jsonl: [events.assistantMessage("completed after the monitor gap")] },
        ],
      });
      const controlEvents: ControlEvent[] = [];
      let blocked = false;
      const safetyRelease = setTimeout(() => {
        if (!fs.existsSync(release)) fs.writeFileSync(release, "", "utf-8");
      }, scaleTestTimeout(10_000));
      safetyRelease.unref?.();
      try {
        const result = await runSync(
          tempDir,
          [makeAgent("scout", { completionGuard: false })],
          "scout",
          "Investigate monitor timing",
          {
            runId: "foreground-monitor-gap",
            controlConfig: IDLE_CONTROL_CONFIG,
            onControlEvent: (event: ControlEvent) => controlEvents.push(event),
            onUpdate: () => {
              if (blocked) return;
              blocked = true;
              const blocker = new Int32Array(new SharedArrayBuffer(4));
              Atomics.wait(blocker, 0, 0, ACTIVITY_MONITOR_GAP_THRESHOLD_MS + 500);
              setTimeout(() => {
                if (!fs.existsSync(release)) fs.writeFileSync(release, "", "utf-8");
              }, 500);
            },
          },
        );
        assert.equal(result.exitCode, 0);
        assert.equal(blocked, true);
        assert.equal(
          controlEvents.find((event) => event.reason === "idle"),
          undefined,
        );
        assert.equal(
          result.controlEvents?.find((event) => event.reason === "idle"),
          undefined,
        );
      } finally {
        clearTimeout(safetyRelease);
        if (!fs.existsSync(release)) fs.writeFileSync(release, "", "utf-8");
      }
    });

    it("emits idle attention after continuously observed foreground silence", async () => {
      const release = path.join(tempDir, "foreground-genuine-idle-release");
      mockPi.onCall({
        steps: [
          { jsonl: [mockAssistantMessage("quiet baseline", "tool_use")] },
          { waitForMarker: release },
          { jsonl: [events.assistantMessage("completed after genuine idle")] },
        ],
      });
      const controlEvents: ControlEvent[] = [];
      const result = await runSync(
        tempDir,
        [makeAgent("scout", { completionGuard: false })],
        "scout",
        "Investigate genuine idle timing",
        {
          runId: "foreground-genuine-idle",
          controlConfig: IDLE_CONTROL_CONFIG,
          onControlEvent: (event: ControlEvent) => {
            controlEvents.push(event);
            if (event.reason === "idle" && !fs.existsSync(release))
              fs.writeFileSync(release, "", "utf-8");
          },
        },
      );
      const idleEvents = controlEvents.filter((event) => event.reason === "idle");
      assert.equal(result.exitCode, 0);
      assert.equal(idleEvents.length, 1);
      assert.equal(idleEvents[0]?.type, "needs_attention");
      assert.ok((idleEvents[0]?.elapsedMs ?? 0) >= 200);
    });
  },
);
