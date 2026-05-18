function sameToolSet(left, right) {
	if (!left || !right || left.length !== right.length) {
		return false;
	}
	const rightSet = new Set(right);
	return left.every((tool) => rightSet.has(tool));
}

function toolNameSet(toolNames) {
	const resolvedToolNames = typeof toolNames === "function" ? toolNames() : toolNames;
	return resolvedToolNames instanceof Set ? resolvedToolNames : new Set(resolvedToolNames);
}

export function filterAvailableTools(toolNames, availableToolNames) {
	const available = toolNameSet(availableToolNames);
	return toolNames.filter((toolName) => available.has(toolName));
}

export function createPrimaryToolState() {
	let prePrimaryActiveTools;
	let appliedPrimaryTools;

	function clear() {
		prePrimaryActiveTools = undefined;
		appliedPrimaryTools = undefined;
	}

	return {
		hasPrePrimaryTools() {
			return prePrimaryActiveTools !== undefined;
		},
		apply(validTools, currentTools) {
			if (prePrimaryActiveTools === undefined) {
				prePrimaryActiveTools = currentTools;
			}
			appliedPrimaryTools = validTools;
			return validTools;
		},
		restoreIfAppropriate(currentTools, availableToolNames) {
			if (prePrimaryActiveTools === undefined) {
				return undefined;
			}
			if (appliedPrimaryTools && !sameToolSet(currentTools, appliedPrimaryTools)) {
				clear();
				return undefined;
			}
			const restoredTools = filterAvailableTools(prePrimaryActiveTools, availableToolNames);
			clear();
			return restoredTools;
		},
	};
}
