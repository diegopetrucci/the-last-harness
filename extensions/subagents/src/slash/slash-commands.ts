import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveIntercomSessionTarget } from "../intercom/intercom-bridge.ts";
import { buildDoctorReport } from "../extension/doctor.ts";
import {
  SLASH_TEXT_RESULT_TYPE,
  type ExtensionConfig,
  type SubagentState,
} from "../shared/types.ts";

function sendSlashText(pi: ExtensionAPI, text: string): void {
  pi.sendMessage({ customType: SLASH_TEXT_RESULT_TYPE, content: text, display: true });
}

function doctorReportForContext(
  pi: ExtensionAPI,
  state: SubagentState,
  config: ExtensionConfig,
  ctx: ExtensionContext,
  getHeartbeatSummary?: () => import("../extension/heartbeat-wiring.ts").HeartbeatSessionSummary,
): string {
  let currentSessionFile: string | null = null;
  let currentSessionId = state.currentSessionId;
  let sessionError: string | undefined;
  try {
    currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
    currentSessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  let orchestratorTarget: string | undefined;
  try {
    orchestratorTarget = resolveIntercomSessionTarget(
      pi.getSessionName(),
      ctx.sessionManager.getSessionId(),
    );
  } catch (error) {
    if (!sessionError)
      sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  return buildDoctorReport({
    cwd: ctx.cwd,
    config,
    state,
    currentSessionFile,
    currentSessionId,
    orchestratorTarget,
    sessionError,
    ...(getHeartbeatSummary ? { heartbeat: getHeartbeatSummary() } : {}),
  });
}

export function registerSlashCommands(
  pi: ExtensionAPI,
  state: SubagentState,
  config: ExtensionConfig,
  getHeartbeatSummary?: () => import("../extension/heartbeat-wiring.ts").HeartbeatSessionSummary,
): void {
  pi.registerCommand("subagents-doctor", {
    description: "Show subagent diagnostics",
    handler: async (_args, ctx) => {
      sendSlashText(pi, doctorReportForContext(pi, state, config, ctx, getHeartbeatSummary));
    },
  });
}
