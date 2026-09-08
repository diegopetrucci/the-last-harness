import type { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";

export function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

export function textContent(result: ReturnType<typeof inspectSubagentStatus>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}
