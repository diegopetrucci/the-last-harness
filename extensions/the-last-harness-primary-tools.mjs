function sameToolSet(left, right) {
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((tool) => rightSet.has(tool));
}

function mergeMissingTools(baseTools, additionalTools) {
  const seen = new Set(baseTools);
  const mergedTools = [...baseTools];
  for (const tool of additionalTools) {
    if (seen.has(tool)) {
      continue;
    }
    seen.add(tool);
    mergedTools.push(tool);
  }
  return mergedTools;
}

function additiveLateTools(currentTools, appliedTools) {
  if (!currentTools || !appliedTools) {
    return undefined;
  }
  const currentToolSet = new Set(currentTools);
  if (!appliedTools.every((tool) => currentToolSet.has(tool))) {
    return undefined;
  }
  const appliedToolSet = new Set(appliedTools);
  return currentTools.filter((tool) => !appliedToolSet.has(tool));
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
        prePrimaryActiveTools = [...currentTools];
      } else if (appliedPrimaryTools) {
        const lateTools = additiveLateTools(currentTools, appliedPrimaryTools);
        if (lateTools && lateTools.length > 0) {
          prePrimaryActiveTools = mergeMissingTools(prePrimaryActiveTools, lateTools);
        }
      }
      appliedPrimaryTools = [...validTools];
      return validTools;
    },
    restoreIfAppropriate(currentTools, availableToolNames) {
      if (prePrimaryActiveTools === undefined) {
        return undefined;
      }
      if (appliedPrimaryTools && !sameToolSet(currentTools, appliedPrimaryTools)) {
        const lateTools = additiveLateTools(currentTools, appliedPrimaryTools);
        if (lateTools === undefined) {
          clear();
          return undefined;
        }
        if (lateTools.length > 0) {
          prePrimaryActiveTools = mergeMissingTools(prePrimaryActiveTools, lateTools);
        }
      }
      const restoredTools = filterAvailableTools(prePrimaryActiveTools, availableToolNames);
      clear();
      return restoredTools;
    },
  };
}
