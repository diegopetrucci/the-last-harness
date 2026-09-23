import { buildDoctorReport, resolveProjectAgentDoctorTrust } from "../extension/doctor.js";
import { SLASH_TEXT_RESULT_TYPE, } from "../shared/types.js";
function sendSlashText(pi, text) {
    pi.sendMessage({ customType: SLASH_TEXT_RESULT_TYPE, content: text, display: true });
}
async function doctorReportForContext(pi, state, config, ctx, getHeartbeatSummary, getProjectAgentTrustOptions) {
    let currentSessionFile = null;
    let currentSessionId = state.currentSessionId;
    let sessionError;
    try {
        currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
        currentSessionId = ctx.sessionManager.getSessionId();
    }
    catch (error) {
        sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const projectAgentTrust = await resolveProjectAgentDoctorTrust(ctx.cwd, getProjectAgentTrustOptions?.(ctx.cwd));
    return buildDoctorReport({
        cwd: ctx.cwd,
        config,
        state,
        currentSessionFile,
        currentSessionId,
        sessionError,
        projectAgentTrust,
        ...(getHeartbeatSummary ? { heartbeat: getHeartbeatSummary() } : {}),
    });
}
export function registerSlashCommands(pi, state, config, getHeartbeatSummary, getProjectAgentTrustOptions) {
    pi.registerCommand("subagents-doctor", {
        description: "Show subagent diagnostics",
        handler: async (_args, ctx) => {
            sendSlashText(pi, await doctorReportForContext(pi, state, config, ctx, getHeartbeatSummary, getProjectAgentTrustOptions));
        },
    });
}
