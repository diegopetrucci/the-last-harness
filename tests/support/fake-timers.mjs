export function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  function* dueTimers() {
    let ran = true;
    while (ran) {
      ran = false;
      for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now || !timers.has(id)) continue;
        timers.delete(id);
        yield timer;
        ran = true;
      }
    }
  }

  return {
    now: () => now,
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      timers.set(id, { fn, at: now + delay, delay });
      return { id, unref() {} };
    },
    clearTimeout(handle) {
      timers.delete(handle.id ?? handle);
    },
    advance(ms) {
      now += ms;
      for (const timer of dueTimers()) timer.fn();
    },
    async advanceAsync(ms) {
      now += ms;
      for (const timer of dueTimers()) {
        const result = timer.fn();
        if (result && typeof result.then === "function") await result;
      }
    },
    getPendingDelays() {
      return [...timers.values()].map((timer) => timer.delay).sort((a, b) => a - b);
    },
    pendingCount() {
      return timers.size;
    },
  };
}
