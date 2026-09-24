import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProjectAgentTrustOptions } from "../agents/project-agent-loader.ts";
import { buildDoctorReport, resolveProjectAgentDoctorTrust } from "../extension/doctor.ts";
import {
  SLASH_TEXT_RESULT_TYPE,
  type ExtensionConfig,
  type SubagentState,
} from "../shared/types.ts";

function sendSlashText(pi: ExtensionAPI, text: string): void {
  pi.sendMessage({ customType: SLASH_TEXT_RESULT_TYPE, content: text, display: true });
}

async function doctorReportForContext(
  pi: ExtensionAPI,
  state: SubagentState,
  config: ExtensionConfig,
  ctx: ExtensionContext,
  getProjectAgentTrustOptions?: (cwd: string) => ProjectAgentTrustOptions,
): Promise<string> {
  let currentSessionFile: string | null = null;
  let currentSessionId = state.currentSessionId;
  let sessionError: string | undefined;
  try {
    currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
    currentSessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  const projectAgentTrust = await resolveProjectAgentDoctorTrust(
    ctx.cwd,
    getProjectAgentTrustOptions?.(ctx.cwd),
  );
  return buildDoctorReport({
    cwd: ctx.cwd,
    config,
    state,
    currentSessionFile,
    currentSessionId,
    sessionError,
    projectAgentTrust,
  });
}

export function registerSlashCommands(
  pi: ExtensionAPI,
  state: SubagentState,
  config: ExtensionConfig,
  getProjectAgentTrustOptions?: (cwd: string) => ProjectAgentTrustOptions,
): void {
  pi.registerCommand("subagents-doctor", {
    description: "Show subagent diagnostics",
    handler: async (_args, ctx) => {
      sendSlashText(
        pi,
        await doctorReportForContext(pi, state, config, ctx, getProjectAgentTrustOptions),
      );
    },
  });
}
