/**
 * Run `fn` over `items` with at most `limit` calls in flight, writing each
 * result at its item's index — so the output keeps the input order whatever
 * order the calls settle in. Items start in input order; `fn` must not reject
 * (the runner's `runCheck` never does).
 */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/** Bounds of the check concurrency (`--concurrency`, `SNPF_CONCURRENCY`). */
export const CONCURRENCY_RANGE = { min: 1, max: 32 } as const;

/** Why `value` is not a valid concurrency, or `undefined` when it is. */
export function concurrencyProblem(value: number): string | undefined {
  const { min, max } = CONCURRENCY_RANGE;
  return Number.isInteger(value) && value >= min && value <= max
    ? undefined
    : `must be a whole number between ${min} and ${max}`;
}
