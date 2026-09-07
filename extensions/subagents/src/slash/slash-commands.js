import { buildDoctorReport } from "../extension/doctor.js";
import { SLASH_TEXT_RESULT_TYPE, } from "../shared/types.js";
function sendSlashText(pi, text) {
    pi.sendMessage({ customType: SLASH_TEXT_RESULT_TYPE, content: text, display: true });
}
function doctorReportForContext(pi, state, config, ctx, getHeartbeatSummary) {
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
    return buildDoctorReport({
        cwd: ctx.cwd,
        config,
        state,
        currentSessionFile,
        currentSessionId,
        sessionError,
        ...(getHeartbeatSummary ? { heartbeat: getHeartbeatSummary() } : {}),
    });
}
export function registerSlashCommands(pi, state, config, getHeartbeatSummary) {
    pi.registerCommand("subagents-doctor", {
        description: "Show subagent diagnostics",
        handler: async (_args, ctx) => {
            sendSlashText(pi, doctorReportForContext(pi, state, config, ctx, getHeartbeatSummary));
        },
    });
}
