/**
 * A tiny process-wide async mutex.
 *
 * Serialises read-modify-write operations on shared state (`config.json`,
 * `tokens.json`) between the sync scheduler and web routes. Ordering rule: the
 * state lock is always acquired before the Actual API lock (`withActual`),
 * never the other way around, to avoid deadlock.
 */
let chain: Promise<unknown> = Promise.resolve();

export function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(() => fn());
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
