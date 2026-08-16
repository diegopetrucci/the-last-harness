export function isParallelGroup(step) {
    return "parallel" in step && Array.isArray(step.parallel);
}
export function flattenSteps(steps) {
    const flat = [];
    for (const step of steps) {
        if (isParallelGroup(step)) {
            for (const task of step.parallel)
                flat.push(task);
        }
        else {
            flat.push(step);
        }
    }
    return flat;
}
export const DEFAULT_GLOBAL_CONCURRENCY_LIMIT = 20;
export class Semaphore {
    available;
    queue = [];
    constructor(limit) {
        this.available = Math.max(1, Math.floor(limit) || 1);
    }
    acquire() {
        if (this.available > 0) {
            this.available--;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.queue.push(resolve);
        });
    }
    release() {
        const next = this.queue.shift();
        if (next) {
            next();
        }
        else {
            this.available++;
        }
    }
}
export async function mapConcurrent(items, limit, fn, globalSemaphore) {
    const safeLimit = Math.max(1, Math.floor(limit) || 1);
    const results = Array.from({ length: items.length });
    let next = 0;
    async function worker(_workerIndex) {
        while (next < items.length) {
            const i = next++;
            if (globalSemaphore) {
                await globalSemaphore.acquire();
                try {
                    results[i] = await fn(items[i], i);
                }
                finally {
                    globalSemaphore.release();
                }
            }
            else {
                results[i] = await fn(items[i], i);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(safeLimit, items.length) }, (_, wi) => worker(wi)));
    return results;
}
export function aggregateParallelOutputs(results, headerFormat = (i, agent) => `=== Parallel Task ${i + 1} (${agent}) ===`) {
    return results
        .map((r, i) => {
        const header = headerFormat(r.taskIndex ?? i, r.agent);
        const hasOutput = Boolean(r.output?.trim());
        const notice = r.modelFallbackNotice ? `Notice: ${r.modelFallbackNotice}` : "";
        const status = r.timedOut
            ? `TIMED OUT${r.error ? `: ${r.error}` : ""}`
            : r.exitCode === -1
                ? "SKIPPED"
                : r.exitCode !== 0 && r.exitCode !== null
                    ? `FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}`
                    : r.error
                        ? `WARNING: ${r.error}`
                        : !hasOutput && r.outputTargetPath && r.outputTargetExists === false
                            ? `EMPTY OUTPUT (expected output file missing: ${r.outputTargetPath})`
                            : !hasOutput && !r.outputTargetPath
                                ? "EMPTY OUTPUT (no textual response returned)"
                                : "";
        const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
        return `${header}\n${[notice, body].filter(Boolean).join("\n")}`;
    })
        .join("\n\n");
}
export const MAX_PARALLEL_CONCURRENCY = 4;
