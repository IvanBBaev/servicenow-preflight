// The local projection lock (ADR-007; delegated decision 2026-09-23).
//
// One projection at a time per lock path: a second `project()` against a held
// lock is REFUSED, never queued and never stolen. The lock is an `O_CREAT |
// O_EXCL` create (`flag: "wx"`), so exactly one creator wins.
//
// `@tessera/store`'s collaboration lock explains why `wx` alone is not a safe
// primitive THERE: its readers judge staleness from the file's bytes, and a
// racer can read a lock that is still being written. That hazard does not
// apply here because nothing ever judges this lock stale — there is no
// eviction. The bytes are written for a human reading the refusal (who holds
// it, since when) and are read back only to quote them. A lock left behind by
// a crashed process therefore refuses every later projection until a human
// removes it, which is the fail-closed direction: that process may have left
// a live run on the instance (DEV-17), and deciding it has not is a judgement
// the store has no evidence for.

import * as fs from "node:fs";
import * as path from "node:path";

import { TestStoreRefusalError } from "./client.js";

export interface ProjectionLock {
  readonly path: string;
  /** Remove the lock file. Idempotent; a second call is a no-op. */
  release(): void;
}

function describeHolder(lockPath: string): string {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    return raw === "" ? "an unknown holder" : raw;
  } catch {
    return "an unknown holder";
  }
}

/**
 * Take the projection lock at `lockPath`, creating its parent directory.
 * Throws {@link TestStoreRefusalError} (`lock-held`) when it already exists.
 */
export function acquireProjectionLock(
  lockPath: string,
  holder: { readonly runId: string },
): ProjectionLock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const body = JSON.stringify({
    runId: holder.runId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  try {
    fs.writeFileSync(lockPath, `${body}\n`, { flag: "wx", encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new TestStoreRefusalError(
        "lock-held",
        `refusing to project run ${holder.runId}: the projection lock ${lockPath} is held by ${describeHolder(lockPath)}. Only one projection may be live at a time; if its process is gone and no instance run is still executing, remove the file by hand`,
      );
    }
    throw error;
  }
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      fs.rmSync(lockPath, { force: true });
    },
  };
}
