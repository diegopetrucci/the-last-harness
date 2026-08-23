import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AcceptanceLedger,
  AcceptanceRuntimeCheck,
  AcceptanceVerifyCommand,
  AcceptanceVerifyResult,
  AsyncResultArtifact,
  AsyncResultArtifactResultItem,
  AsyncStatus,
  ContextPressureProjection,
  ContextPressureThreshold,
  ContextUsageDiagnostics,
  ResolvedAcceptanceConfig,
  ResolvedAcceptanceGate,
  SubagentModelResolution,
  SubagentTerminationReason,
} from "../../src/shared/types.ts";

export type AcceptanceConfigFixture = Omit<
  Partial<ResolvedAcceptanceConfig>,
  "criteria" | "verify"
> & {
  criteria?: Array<Partial<ResolvedAcceptanceGate> | null>;
  verify?: Array<Partial<AcceptanceVerifyCommand>>;
};

export type AcceptanceLedgerFixture = Omit<
  Partial<AcceptanceLedger>,
  "effectiveAcceptance" | "criteria" | "runtimeChecks" | "verifyRuns"
> & {
  effectiveAcceptance?: AcceptanceConfigFixture;
  criteria?: Array<Partial<ResolvedAcceptanceGate>>;
  runtimeChecks?: Array<Partial<AcceptanceRuntimeCheck>>;
  verifyRuns?: Array<Partial<AcceptanceVerifyResult>>;
};

type AsyncStatusStepFixture = Pick<NonNullable<AsyncStatus["steps"]>[number], "agent" | "status"> &
  Omit<Partial<NonNullable<AsyncStatus["steps"]>[number]>, "agent" | "status" | "acceptance"> & {
    acceptance?: AcceptanceLedgerFixture;
  };

type AsyncResultItemFixture = Pick<AsyncResultArtifactResultItem, "agent"> &
  Omit<
    Partial<AsyncResultArtifactResultItem>,
    | "agent"
    | "acceptance"
    | "contextUsage"
    | "modelResolution"
    | "sessionFile"
    | "terminationReason"
  > & {
    acceptance?: AcceptanceLedgerFixture;
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
