// Generated from extensions/subagents/src/shared/bench-scb-foreground.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
export const BENCH_SCB_ALLOW_DETACHED_ENV = "TLH_BENCH_SCB_ALLOW_DETACHED";
export function detachedWorkAllowed(env = process.env) {
    return env[BENCH_SCB_ALLOW_DETACHED_ENV] === "1";
}
