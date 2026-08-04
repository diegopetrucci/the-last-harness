function isValidParallelGroup(group, stepCount, chainStepCount) {
    if (typeof group !== "object" || group === null)
        return false;
    const { start, count, stepIndex } = group;
    return typeof start === "number"
        && typeof count === "number"
        && typeof stepIndex === "number"
        && Number.isInteger(start)
        && Number.isInteger(count)
        && Number.isInteger(stepIndex)
        && start >= 0
        && count > 0
        && stepIndex >= 0
        && stepIndex < chainStepCount
        && start + count <= stepCount;
}
export function normalizeParallelGroups(groups, stepCount, chainStepCount) {
    if (!Array.isArray(groups))
        return [];
    return groups
        .filter((group) => isValidParallelGroup(group, stepCount, chainStepCount))
        .sort((left, right) => left.stepIndex - right.stepIndex || left.start - right.start);
}
export function flatToLogicalStepIndex(flatIndex, chainStepCount, groups) {
    let logicalIndex = 0;
    let cursor = 0;
    for (const group of groups) {
        while (cursor < group.start && logicalIndex < chainStepCount) {
            if (cursor === flatIndex)
                return logicalIndex;
            cursor++;
            logicalIndex++;
        }
        if (flatIndex >= group.start && flatIndex < group.start + group.count)
            return group.stepIndex;
        cursor = group.start + group.count;
        logicalIndex = group.stepIndex + 1;
    }
    while (cursor <= flatIndex && logicalIndex < chainStepCount) {
        if (cursor === flatIndex)
            return logicalIndex;
        cursor++;
        logicalIndex++;
    }
    return Math.max(0, chainStepCount - 1);
}
