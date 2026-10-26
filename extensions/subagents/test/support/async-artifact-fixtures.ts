import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AsyncResultArtifact,
  AsyncResultArtifactResultItem,
  AsyncStatus,
  ContextPressureProjection,
  ContextPressureThreshold,
  ContextUsageDiagnostics,
  SubagentModelResolution,
  SubagentTerminationReason,
} from "../../src/shared/types.ts";

type AsyncStatusStepFixture = Pick<NonNullable<AsyncStatus["steps"]>[number], "agent" | "status"> &
  Omit<Partial<NonNullable<AsyncStatus["steps"]>[number]>, "agent" | "status">;

type AsyncResultItemFixture = Pick<AsyncResultArtifactResultItem, "agent"> &
  Omit<
    Partial<AsyncResultArtifactResultItem>,
    "agent" | "contextUsage" | "modelResolution" | "sessionFile" | "terminationReason"
  > & {
    contextUsage?: ContextUsageDiagnostics | { contextTokens: string };
    modelResolution?: SubagentModelResolution | { kind: "invalid"; reason: number };
    sessionFile?: AsyncResultArtifactResultItem["sessionFile"] | { path: string };
    terminationReason?: SubagentTerminationReason | "legacy-invalid";
    /** Legacy result artifacts may persist a child thinking level on each item. */
    thinking?: string;
  };

export type AsyncStatusArtifactFixture = Pick<
  AsyncStatus,
  "runId" | "mode" | "state" | "startedAt"
> &
  Omit<Partial<AsyncStatus>, "runId" | "mode" | "state" | "startedAt" | "sessionId" | "steps"> & {
    sessionId?: AsyncStatus["sessionId"] | { value: string };
    steps?: AsyncStatusStepFixture[];
  };

export type AsyncResultArtifactFixture = Pick<
  AsyncResultArtifact,
  "id" | "agent" | "success" | "state"
> &
  Omit<Partial<AsyncResultArtifact>, "id" | "agent" | "success" | "state" | "results"> & {
    contextPressure?: ContextPressureProjection;
    contextPressureCrossedThresholds?: ContextPressureThreshold[];
    results?: AsyncResultItemFixture[];
  };

export type PersistedAsyncArtifactFixture = AsyncStatusArtifactFixture | AsyncResultArtifactFixture;

export function writeAsyncArtifactJson(
  filePath: string,
  value: PersistedAsyncArtifactFixture,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}
