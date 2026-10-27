/**
 * bench/scb-only: this branch runs one-shot `tlh --print --mode json` sessions,
 * so any detached child (async:true dispatch, durable resume) would outlive the
 * parent process. Detached launches are rejected unless the opt-out env var is
 * set. Only the subagents test loader sets it, so legacy detached-path tests
 * keep exercising the machinery; production never does.
 */
export const BENCH_SCB_ALLOW_DETACHED_ENV = "TLH_BENCH_SCB_ALLOW_DETACHED";

export function detachedWorkAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BENCH_SCB_ALLOW_DETACHED_ENV] === "1";
}
