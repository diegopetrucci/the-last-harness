import { resolveIntercomSessionTarget } from "../intercom/intercom-bridge.js";
import { buildDoctorReport } from "../extension/doctor.js";
import { SLASH_TEXT_RESULT_TYPE, } from "../shared/types.js";
function sendSlashText(pi, text) {
    pi.sendMessage({ customType: SLASH_TEXT_RESULT_TYPE, content: text, display: true });
}
function doctorReportForContext(pi, state, config, ctx) {
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
    let orchestratorTarget;
    try {
        orchestratorTarget = resolveIntercomSessionTarget(pi.getSessionName(), ctx.sessionManager.getSessionId());
    }
    catch (error) {
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
    });
}
export function registerSlashCommands(pi, state, config) {
    pi.registerCommand("subagents-doctor", {
        description: "Show subagent diagnostics",
        handler: async (_args, ctx) => {
            sendSlashText(pi, doctorReportForContext(pi, state, config, ctx));
        },
    });
}
