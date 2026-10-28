import { type SubagentResultStatus } from "./types.ts";

export function resolveSubagentResultStatus(input: {
  exitCode?: number;
  success?: boolean;
  state?: string;
  interrupted?: boolean;
}): SubagentResultStatus {
  if (input.interrupted || input.state === "paused") return "paused";
  if (typeof input.success === "boolean") return input.success ? "completed" : "failed";
  if (input.state === "complete") return "completed";
  if (input.state === "failed") return "failed";
  if (typeof input.exitCode === "number") return input.exitCode === 0 ? "completed" : "failed";
  return "failed";
}
