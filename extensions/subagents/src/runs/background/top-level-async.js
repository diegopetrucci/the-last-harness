export function applyForceTopLevelAsyncOverride(params, depth, forceTopLevelAsync) {
    if (!(depth === 0 && forceTopLevelAsync))
        return params;
    return { ...params, async: true, clarify: false };
}
