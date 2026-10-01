// A cross-process advisory lock for the namespaces more than one process may
// append to: the per-host infra ledger (infra.ts) and the per-run event log
// (runEvents.ts). Delegated decision 2026-09-23.
//
// The run ledger does not use it — §4b gives one run to one owning process
// (see the SEAM on `withLock` in ledger.ts). A host namespace has no such
// owner: two `preflight_apply` invocations against one instance are two
// processes by design, and the host-scoped idempotency dedupe is only as good
// as the read-then-append it runs under. So that read-then-append is
// serialized here, across processes, by a lock FILE:
//
//   * acquire = `open(lock, "wx")` — O_CREAT|O_EXCL, atomic on every local
//     filesystem Node supports; the holder writes its pid into it.
//   * release = unlink, in a `finally`.
//   * a lock whose holder pid is no longer alive (`kill(pid, 0)` → ESRCH), or
//     whose content never got written and is older than `STALE_EMPTY_MS`, is
//     a crash residue and is removed before retrying.
//
// SEAM: breaking a stale lock is check-then-unlink, so two waiters that both
// find the SAME dead holder can race, and the slower one's unlink can remove
// the faster one's fresh lock. The window needs a holder that died while two
// others were waiting on it; it is recorded rather than engineered away. A
// network filesystem without O_EXCL semantics is out of scope, as it is for
// the ledger's rename-based atomic writes.

import { promises as fsp } from "node:fs";

import { LedgerError } from "./errors.js";

const STALE_EMPTY_MS = 5_000;
const MAX_BACKOFF_MS = 100;

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else — alive.
    return errnoCode(error) !== "ESRCH";
  }
}

/** True when the lock at `file` was left by a holder that can no longer release it. */
async function isStale(file: string): Promise<boolean> {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = await fsp.readFile(file, "utf8");
    mtimeMs = (await fsp.stat(file)).mtimeMs;
  } catch (error) {
    // Released between our failed open and this read — not stale, just gone;
    // the caller's next attempt will take it.
    if (errnoCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
  let pid: unknown;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown }).pid;
  } catch {
    pid = undefined;
  }
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
    return !isAlive(pid);
  }
  // Created but never written: the holder died between open and write, or is
  // writing right now. Only age separates the two.
  return Date.now() - mtimeMs > STALE_EMPTY_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `work` while holding the lock file `file`. The directory must exist.
 * Throws `LedgerError("lock-timeout")` — having done nothing — when the lock
 * stays held for `timeoutMs`.
 */
export async function withFileLock<T>(
  file: string,
  work: () => Promise<T>,
  timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let backoff = 2;
  for (;;) {
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    try {
      handle = await fsp.open(file, "wx");
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") {
        throw error;
      }
    }
    if (handle !== undefined) {
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid }), "utf8");
      } finally {
        await handle.close();
      }
      break;
    }
    if (await isStale(file)) {
      await fsp.rm(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LedgerError(
        "lock-timeout",
        `${file} is held by another process and was not released within ${timeoutMs} ms; nothing was written`,
      );
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
  try {
    return await work();
  } finally {
    await fsp.rm(file, { force: true });
  }
}
