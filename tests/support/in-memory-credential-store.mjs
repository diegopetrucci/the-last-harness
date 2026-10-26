export function createInMemoryCredentialStore() {
  const store = new Map();
  const tails = new Map();
  const noop = () => {};
  function enqueue(providerId, fn) {
    const tail = tails.get(providerId) ?? Promise.resolve();
    const result = tail.then(() => fn());
    tails.set(providerId, result.then(noop, noop));
    return result;
  }
  return {
    async read(providerId) {
      return store.get(providerId);
    },
    async list() {
      return [...store.entries()].map(([id, credential]) => ({
        providerId: id,
        type: credential.type,
      }));
    },
    modify(providerId, fn) {
      return enqueue(providerId, async () => {
        const current = store.get(providerId);
        const next = await fn(current);
        if (next === undefined) return current;
        store.set(providerId, next);
        return next;
      });
    },
    delete(providerId) {
      return enqueue(providerId, async () => {
        store.delete(providerId);
      });
    },
  };
}
