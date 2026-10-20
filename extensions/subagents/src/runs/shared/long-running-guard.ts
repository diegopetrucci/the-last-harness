export function resolveCurrentPath(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolName || !args) return undefined;
  const direct = ["path", "file", "filename", "target", "cwd"];
  for (const key of direct) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : undefined;
    if (!command) return undefined;
    const redirect = command.match(/(?:>|>>|tee\s+)(\S+)/);
    if (redirect?.[1]) return redirect[1];
  }
  return undefined;
}
