/**
 * Small AbortSignal helpers shared by the client and the runner. They exist so
 * the package keeps working on its whole engines range: `AbortSignal.any` only
 * arrived in Node 20.3, and the floor is 20.
 */

/**
 * A signal that aborts as soon as any of `signals` aborts (with that signal's
 * reason). `undefined` entries are ignored; with no signal left the result is
 * `undefined`, and a single signal is returned as is.
 */
export function anySignal(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
  const controller = new AbortController();
  const onAbort = (event: Event): void => {
    const source = event.target as AbortSignal;
    for (const s of present) s.removeEventListener("abort", onAbort);
    controller.abort(source.reason);
  };
  for (const s of present) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
  }
  if (!controller.signal.aborted) {
    for (const s of present) s.addEventListener("abort", onAbort);
  }
  return controller.signal;
}

/** The reason `signal` aborted with, as an `Error` (a DOMException-like value). */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(
    typeof reason === "string" ? reason : "The operation was aborted.",
  );
  err.name = "AbortError";
  return err;
}

/**
 * Settle with `promise`, or reject with the abort reason as soon as `signal`
 * aborts — so a transport that ignores its signal cannot hang the caller.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The abandoned promise may still reject; keep that from going unhandled.
    promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      promise.catch(() => undefined);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Sleep for `ms` milliseconds; rejects with the abort reason if `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
