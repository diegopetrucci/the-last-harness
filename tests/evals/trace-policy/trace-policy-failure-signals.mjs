function meaningfulError(value) {
  return (typeof value === "string" && value.trim().length > 0) || Boolean(value);
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
  const errorFailure = meaningfulError(topLevelError) || meaningfulError(nestedError);

  return (
    step.isError === true ||
    step.ok === false ||
    details?.ok === false ||
    statuses.some((status) => ["failed", "error"].includes(status.trim().toLowerCase())) ||
    exitCodes.some((exitCode) => exitCode !== 0) ||
    errorFailure
  );
}
