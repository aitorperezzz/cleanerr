// Serialize a read/modify/write transaction, including its reads, per resource.
export function createOperationQueue() {
  const pending = new Map();
  return function run(key, operation) {
    const previous = pending.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    pending.set(key, result);
    const cleanup = () => { if (pending.get(key) === result) pending.delete(key); };
    result.then(cleanup, cleanup);
    return result;
  };
}
