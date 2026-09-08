import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  handleSubagentControlNotice,
  type SubagentControlMessageDetails,
} from "../../src/extension/control-notices.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";
import {
  available,
  createEventRecorder,
  createState,
  trackerMod,
  type AsyncJobTrackerModule,
  waitForCondition,
} from "../support/async-job-tracker-fixtures.ts";

function appendIdleControlEvent(
  eventsPath: string,
  input: { runId: string; episodeId?: string; message: string; ts: number },
): void {
  fs.appendFileSync(
    eventsPath,
    `${JSON.stringify({
      type: "subagent.control",
      channels: ["event"],
      event: {
        type: "needs_attention",
        to: "needs_attention",
        ts: input.ts,
        runId: input.runId,
        agent: "worker",
        index: 0,
        message: input.message,
        reason: "idle",
        ...(input.episodeId ? { idleEpisodeId: input.episodeId } : {}),
      },
    })}\n`,
    "utf-8",
  );
}

describe(
  "async job tracker health",
  { skip: !available ? "pi packages not available" : undefined },
  () => {
    it("round-trips idle episodes through the real tracker and notice dedupe without stale-status gating", async () => {
      const asyncRoot = createTempDir("pi-async-job-health-events-");
      let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
      try {
        const runId = "run-health-events";
        const sessionId = "session-health-events";
        const episodeOne = "attempt-health~idle~1";
        const episodeTwo = "attempt-health~idle~2";
        const runDir = path.join(asyncRoot, runId);
        const eventsPath = path.join(runDir, "events.jsonl");
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId,
            mode: "single",
            state: "running",
            sessionId,
            startedAt: 1000,
            lastUpdate: 1000,
            steps: [{ agent: "worker", status: "running" }],
          }),
          "utf-8",
        );

        const state = createState();
        state.currentSessionId = sessionId;
        const recorder = createEventRecorder();
        tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs: 10,
        });
        tracker.handleStarted({ id: runId, asyncDir: runDir, sessionId, agent: "worker" });
        await waitForCondition(
          () => state.asyncJobs.get(runId)?.steps?.length === 1,
          "initial stale status snapshot",
        );

        // The producer writes the event before its status snapshot. The event
        // must still reach the consumer on this poll.
        appendIdleControlEvent(eventsPath, {
          runId,
          episodeId: episodeOne,
          message: "first idle episode",
          ts: 1100,
        });
        await waitForCondition(() => recorder.events.length === 1, "first fresh control event");

        appendIdleControlEvent(eventsPath, {
          runId,
          episodeId: episodeOne,
          message: "duplicate idle episode",
          ts: 1101,
        });
        appendIdleControlEvent(eventsPath, {
          runId,
          episodeId: episodeTwo,
          message: "second idle episode",
          ts: 1102,
        });
        await waitForCondition(() => recorder.events.length === 3, "second idle episode events");

        const details = recorder.events.map((entry) => entry.data as SubagentControlMessageDetails);
        assert.deepEqual(
          details.map((entry) => entry.event.idleEpisodeId),
          [episodeOne, episodeOne, episodeTwo],
        );

        const sent: unknown[] = [];
        const nudges: string[] = [];
        const noticePi = {
          sendMessage(message: unknown) {
            sent.push(message);
          },
          sendUserMessage(text: string) {
            nudges.push(text);
          },
        };
        const visible = new Set<string>();
        for (const entry of details) {
          handleSubagentControlNotice({
            pi: noticePi,
            state: createState() as never,
            visibleControlNotices: visible,
            details: entry,
            isIdle: () => false,
          });
        }
        assert.equal(sent.length, 2, "duplicate events in one episode should be deduplicated");
        assert.equal(nudges.length, 0);

        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            runId,
            mode: "single",
            state: "running",
            sessionId,
            startedAt: 1000,
            lastUpdate: 1200,
            steps: [
              {
                agent: "worker",
                status: "running",
                activityState: "needs_attention",
                idleEpisodeId: episodeTwo,
              },
            ],
          }),
          "utf-8",
        );
        await waitForCondition(
          () => state.asyncJobs.get(runId)?.steps?.[0]?.idleEpisodeId === episodeTwo,
          "current idle episode status snapshot",
        );
      } finally {
        tracker?.resetJobs();
        removeTempDir(asyncRoot);
      }
    });
  },
);
