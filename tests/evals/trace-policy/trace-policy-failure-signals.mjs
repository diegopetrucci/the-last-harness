const MCP_FAILURE_CODES = new Set(["tool_error", "call_failed"]);

function toolName(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return "";
  }
  return typeof step.tool === "string"
    ? step.tool.trim().toLowerCase()
    : typeof step.name === "string"
      ? step.name.trim().toLowerCase()
      : typeof step.tool_name === "string"
        ? step.tool_name.trim().toLowerCase()
        : typeof step.toolName === "string"
          ? step.toolName.trim().toLowerCase()
          : "";
}

function meaningfulError(value) {
  return (typeof value === "string" && value.trim().length > 0) || Boolean(value);
}

function isMcpFailureCode(value) {
  return typeof value === "string" && MCP_FAILURE_CODES.has(value);
}

export function hasToolFailureSignal(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return false;
  }
  const details =
    step.details && typeof step.details === "object" && !Array.isArray(step.details)
      ? step.details
      : undefined;
  const statuses = [step.status, details?.status].filter((value) => typeof value === "string");
  const exitCodes = [step.exitCode, details?.exitCode].filter(Number.isInteger);
  const topLevelError = step.error;
  const nestedError = details?.error;
  const name = toolName(step);
  const isMcp = name === "mcp" || name.startsWith("mcp:");
  const errorFailure = isMcp
    ? meaningfulError(topLevelError) || isMcpFailureCode(nestedError)
    : meaningfulError(topLevelError) || meaningfulError(nestedError);

  return (
    step.isError === true ||
    step.ok === false ||
    details?.ok === false ||
    statuses.some((status) => ["failed", "error"].includes(status.trim().toLowerCase())) ||
    exitCodes.some((exitCode) => exitCode !== 0) ||
    errorFailure
  );
}
