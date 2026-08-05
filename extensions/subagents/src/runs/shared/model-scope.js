import { splitKnownThinkingSuffix } from "../../shared/model-info.js";
function stripThinkingSuffix(model) {
    return splitKnownThinkingSuffix(model).baseModel;
}
function globToRegExp(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i");
}
export function matchesScopePattern(model, pattern) {
    return globToRegExp(pattern).test(stripThinkingSuffix(model));
}
export function checkModelScope(model, scope, source) {
    if (!model || !scope?.enforce)
        return undefined;
    const allow = scope.allow;
    if (!allow || allow.length === 0)
        return undefined;
    if (allow.some((pattern) => matchesScopePattern(model, pattern)))
        return undefined;
    const baseModel = stripThinkingSuffix(model);
    const severity = source === "explicit" ? "error" : "warn";
    return {
        model: baseModel,
        severity,
        allowedPatterns: allow,
        message: `Model '${baseModel}' is outside the configured subagent model scope. ` +
            `Allowed patterns: ${allow.join(", ")}.`,
    };
}
export function parseModelScopeConfig(value, meta) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Subagent settings in '${meta.filePath}' have invalid 'modelScope'; expected an object.`);
    }
    const input = value;
    const config = {};
    if ("enforce" in input) {
        if (typeof input.enforce !== "boolean") {
            throw new Error(`Subagent settings in '${meta.filePath}' have invalid 'modelScope.enforce'; expected a boolean.`);
        }
        config.enforce = input.enforce;
    }
    if ("allow" in input) {
        if (!Array.isArray(input.allow)) {
            throw new Error(`Subagent settings in '${meta.filePath}' have invalid 'modelScope.allow'; expected an array of strings.`);
        }
        const allow = [];
        for (const entry of input.allow) {
            if (typeof entry !== "string") {
                throw new Error(`Subagent settings in '${meta.filePath}' have invalid 'modelScope.allow'; expected an array of strings.`);
            }
            const trimmed = entry.trim();
            if (trimmed)
                allow.push(trimmed);
        }
        if (allow.length === 0) {
            throw new Error(`Subagent settings in '${meta.filePath}' have invalid 'modelScope.allow'; expected a non-empty array of patterns.`);
        }
        config.allow = allow;
    }
    if (config.enforce === true && (!config.allow || config.allow.length === 0)) {
        throw new Error(`Subagent settings in '${meta.filePath}' set modelScope.enforce without a non-empty 'allow' list; supply allowed model patterns or disable enforcement.`);
    }
    return Object.keys(config).length > 0 ? config : undefined;
}
