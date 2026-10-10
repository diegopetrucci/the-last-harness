import * as os from "node:os";
import * as path from "node:path";
function sanitizeTempScopeSegment(value) {
    const sanitized = value
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return sanitized || "unknown";
}
function resolveTempScopeId(options) {
    const env = options?.env ?? process.env;
    const getuid = options && Object.hasOwn(options, "getuid") ? options.getuid : process.getuid?.bind(process);
    if (typeof getuid === "function") {
        return `uid-${getuid()}`;
    }
    for (const key of ["USERNAME", "USER", "LOGNAME"]) {
        const value = env[key];
        if (value)
            return `user-${sanitizeTempScopeSegment(value)}`;
    }
    const userInfo = options && Object.hasOwn(options, "userInfo") ? options.userInfo : os.userInfo;
    try {
        const username = userInfo?.().username;
        if (username)
            return `user-${sanitizeTempScopeSegment(username)}`;
    }
    catch {
    }
    const homedir = env.USERPROFILE ?? env.HOME;
    if (homedir)
        return `home-${sanitizeTempScopeSegment(homedir)}`;
    const resolveHomedir = options && Object.hasOwn(options, "homedir") ? options.homedir : os.homedir;
    try {
        const fallbackHomedir = resolveHomedir?.();
        if (fallbackHomedir)
            return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
    }
    catch {
    }
    return "shared";
}
export function resolveTempRootDir(options) {
    const env = options?.env ?? process.env;
    const override = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
    if (override) {
        return override;
    }
    return path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId(options)}`);
}
