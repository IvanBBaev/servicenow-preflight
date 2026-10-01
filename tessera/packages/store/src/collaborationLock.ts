// Vendored from github.com/IvanBBaev/syncrona @ 73cae76 (packages/core/src/pushCommand.ts,
// collaboration-lock machinery only — the push flow itself is not vendored).
// GPL-3.0 upstream; dual-licensed for this use by the sole author/copyright owner (ADR-002 option 4).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Adaptations (see VENDORED.md): upstream resolves its state directory through the
// ConfigManager singleton (`getStateBaseDir`, project root with a cwd fallback) and
// keeps the held-owner token in module state. This copy is a factory — the state
// directory is injected and `heldLockOwner` lives in the factory closure — so two
// independent locks can coexist in one process and tests drive a real temp dir with
// no module mocking. Function names and comments are otherwise preserved verbatim,
// except three catch-block comments (acquire, release, reclaimStaleLock) that named
// ENOENT as the only cause of a failed read; they now state what the un-narrowed
// catch actually admits (TODO 1199(c), delegated decision 2026-09-23). Behaviour diverges
// since 2026-09-26 (W7b L6/L7): a future-dated or unparseable createdAt is stale, and
// release no longer drops ownership when eviction is refused — see VENDORED.md.

import { createHash, randomUUID } from "crypto";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";

export type CollaborationLock = {
  command: string;
  pid: number;
  createdAt: string;
  instanceProfile?: string;
  // REV-205: identity of the acquisition, not of the process. A pid cannot
  // establish ownership — the same pid can hold the lock twice in a row (release
  // then re-acquire), and a lock written on another host may carry a pid that
  // happens to match ours. Release compares this token so it can only ever
  // remove the lock file it created. Optional so a legacy lock (written before
  // this field existed) still parses; such a lock is simply never recognized as
  // ours, which fails safe — we leave it for the age/liveness reclaim path.
  owner?: string;
  // W5a #4 (2026-09-26): the host that wrote the lock. A pid is only meaningful
  // in the process table of the host that issued it, so the liveness check runs
  // only when this matches os.hostname(). Optional so a legacy lock still parses;
  // a lock without it is treated as foreign (age is its only authority).
  hostname?: string;
};

export const COLLABORATION_LOCK_FILE = "sync.collaboration.lock.json";
export const COLLABORATION_LOCK_MAX_AGE_MS = 30 * 60 * 1000;

// REV-233: emptying the lock path is the one operation that can break mutual
// exclusion, so it is mediated by an *eviction claim* — a file named after the exact
// bytes being removed, created with the same atomic 'wx' as the lock itself. See
// evictLockFile for why the atomic create on the lock alone was not enough.
export const COLLABORATION_EVICT_PREFIX = "sync.collaboration.evict.";
export const COLLABORATION_EVICT_SUFFIX = ".json";
// Where a lock or a claim is assembled before it is published under its real name.
// Never inspected by anyone, so its contents are allowed to be momentarily incomplete.
export const COLLABORATION_STAGING_PREFIX = "sync.collaboration.staging.";
// A claim is held across three filesystem calls, so ten seconds is roughly four
// orders of magnitude of headroom: a claim older than that is abandoned, not slow.
export const COLLABORATION_EVICT_MAX_AGE_MS = 10 * 1000;
// How many abandoned claims one eviction steps over before giving up and letting the
// caller retry. Reached only after repeated crashes inside the eviction itself.
export const COLLABORATION_EVICT_MAX_GENERATIONS = 8;
// Acquisition retries: enough for a racer that lost the eviction to observe the
// winner's lock, short enough that a wedged path fails the CLI in well under a second.
export const COLLABORATION_LOCK_ACQUIRE_ATTEMPTS = 4;
export const COLLABORATION_LOCK_RETRY_MS = 20;
// Delegated decision 2026-09-26 (W7b L6): how far in the future a lock's createdAt
// may lie and still be taken at face value. Hosts sharing a state directory can
// disagree about the time; five minutes absorbs ordinary NTP drift and VM clock
// jumps, while anything beyond it is a broken clock or a corrupt file.
export const COLLABORATION_LOCK_FUTURE_SKEW_MS = 5 * 60 * 1000;
// Delegated decision 2026-09-26 (W7b L7): how many times release retries an
// eviction that a live claim blocked, before it gives up and throws.
export const COLLABORATION_LOCK_RELEASE_ATTEMPTS = 4;

export function parseCollaborationLock(raw: string): CollaborationLock | null {
  try {
    const parsed = JSON.parse(raw) as CollaborationLock;
    return parsed &&
      typeof parsed === "object" &&
      typeof parsed.command === "string" &&
      typeof parsed.createdAt === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

// process.kill(pid, 0) sends no signal but performs the permission/existence
// check: it throws ESRCH when no such process exists (owner crashed/exited) and
// EPERM when the process exists but is owned by another user. "Alive" therefore
// means "did not throw ESRCH". A non-finite/absent pid is treated as unknown →
// alive, so the age check stays the sole authority for legacy/foreign locks.
export function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists (we just can't signal it) → still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Delegated decision 2026-09-26 (W7b L6): why a lock's createdAt cannot be used as
// an age, or null when it can. A foreign-host lock is reclaimable by age alone, and
// age is `now - createdAt`: a createdAt in the future (a writer whose clock runs
// fast, or a corrupt/hand-edited file — the repro used the year 2999) never ages
// past the window, so the lock blocked every collaborator permanently and nothing
// short of deleting the file by hand could clear it. Unparseable was already read
// as stale, silently.
export function describeCollaborationLockTimeAnomaly(
  lock: Pick<CollaborationLock, "createdAt">,
  nowMs: number = Date.now(),
): string | null {
  const createdAtMs = Date.parse(lock.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return `its createdAt ${JSON.stringify(lock.createdAt)} is unparseable`;
  }
  if (createdAtMs - nowMs > COLLABORATION_LOCK_FUTURE_SKEW_MS) {
    return `its createdAt ${lock.createdAt} is more than ${COLLABORATION_LOCK_FUTURE_SKEW_MS / 60000} minutes in the future`;
  }
  return null;
}

export function isCollaborationLockStale(lock: CollaborationLock): boolean {
  // Delegated decision 2026-09-26 (W7b L6): a lock whose createdAt cannot be an
  // age (unparseable, or beyond COLLABORATION_LOCK_FUTURE_SKEW_MS in the future) is
  // stale on any host. Choosing between "block forever" and "reclaim" there, the
  // lock chooses reclaim: a permanent wedge is certain harm, while the cost of
  // reclaiming is confined to a writer whose clock is more than five minutes fast —
  // and that writer's lock is already unjudgeable by everyone else. The eviction is
  // not silent: acquire/reclaimStaleLock warn (options.warn) before it, naming the
  // timestamp, so the broken clock gets fixed rather than lost in the noise.
  if (describeCollaborationLockTimeAnomaly(lock) !== null) {
    return true;
  }
  const createdAtMs = Date.parse(lock.createdAt);
  // A lock whose owning process is gone is stale immediately, even inside the
  // 30-minute window: a crashed push must not block collaborators for half an
  // hour. Age remains the backstop for locks whose owner is still alive (or
  // whose pid can't be checked, e.g. a lock written on another host).
  //
  // Delegated decision 2026-09-26 (W5a #4): the comment above always meant
  // foreign-host locks to be left to the age backstop, but the pid was checked
  // against the LOCAL process table whatever host wrote it — so a live push on
  // another host sharing this state dir had its lock stolen at once whenever its
  // pid happened to be free here. The pid is now consulted only when the lock
  // names this host. Fail-closed: a lock with no hostname (legacy) or a
  // different one is foreign, and only age can reclaim it.
  if (lock.hostname === os.hostname() && !isProcessAlive(lock.pid)) {
    return true;
  }
  return Date.now() - createdAtMs > COLLABORATION_LOCK_MAX_AGE_MS;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Judged on `createdAt` alone — deliberately looser than parseCollaborationLock, so
// a legacy lock written before the `command` field existed is still reclaimable
// rather than permanently immovable. Anything less structured than that is junk, and
// junk is stale.
export function isRawLockStale(raw: string): boolean {
  let parsed: CollaborationLock | null;
  try {
    parsed = JSON.parse(raw) as CollaborationLock;
  } catch {
    return true;
  }
  return parsed &&
    typeof parsed === "object" &&
    typeof parsed.createdAt === "string"
    ? isCollaborationLockStale(parsed)
    : true;
}

// An eviction claim records who is currently allowed to remove one specific lock
// content from the lock path, and nothing else. `hostname` scopes the pid the same
// way it does on the lock (W5a #4); optional so a legacy claim still parses.
type EvictionClaim = { pid: number; createdAt: string; hostname?: string };

// Create `targetPath` carrying `body`, atomically, failing rather than overwriting.
//
// `writeFile(..., {flag:"wx"})` looks like this primitive but is not: O_CREAT|O_EXCL
// publishes the *name* first and the bytes second, so a racer that reads in between
// gets an empty or half-written file. That is not theoretical here — every reader of
// the lock path decides "is this stale?" from the bytes, and unparseable bytes read as
// stale, so a racer could judge a lock that was being born as abandoned and remove it.
// Measured with sixteen racers: 1/20 rounds lost a live lock to exactly that.
//
// link() has no such split. The staging file is fully written under a name nobody
// inspects, and link() then publishes it complete-or-not-at-all, still failing EEXIST
// if someone else got there first — the same mutual exclusion, without the window.
export async function createExclusiveWithContent(
  targetPath: string,
  body: string,
): Promise<boolean> {
  // Delegated decision 2026-09-26 (W5a #5): the staging name was `<pid>.<target>`,
  // so two lock handles in one process racing for the same target shared one
  // staging file — one handle's finally-unlink removed the other's bytes, and a
  // link() could publish the OTHER handle's owner token, wedging the lock after
  // release. Each call now stages under `<pid>.<uuid>`, opened `wx` so a
  // collision (or a planted file) is an error rather than an overwrite.
  const stagingPath = `${COLLABORATION_STAGING_PREFIX}${process.pid}.${randomUUID()}.${path.basename(targetPath)}`;
  const staging = path.join(path.dirname(targetPath), stagingPath);
  await fsp.writeFile(staging, body, { encoding: "utf8", flag: "wx" });
  try {
    await fsp.link(staging, targetPath);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw e;
  } finally {
    await fsp.unlink(staging).catch(() => undefined);
  }
}

// A claim is abandoned only on *positive* evidence: a holder that no longer exists, or
// an age no live eviction could reach. Absence of evidence is not evidence — 'wx'
// creates the file and fills it in two steps, so a racer can legitimately read a claim
// that is still empty or half-written, and judging that "abandoned" is precisely what
// lets two evictors exist for the same content. Measured with sixteen racers: 2/20
// rounds lost a *live* lock that way, the second racer walking into the path the rogue
// evictor had emptied. Unjudgeable content therefore falls back to the file's own
// mtime, which a claim being written right now cannot fake.
export function isEvictionClaimAbandoned(
  raw: string,
  mtimeMs: number,
): boolean {
  const abandonedByMtime =
    Number.isFinite(mtimeMs) &&
    Date.now() - mtimeMs > COLLABORATION_EVICT_MAX_AGE_MS;
  let parsed: EvictionClaim | null;
  try {
    parsed = JSON.parse(raw) as EvictionClaim;
  } catch {
    return abandonedByMtime;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.pid !== "number"
  ) {
    return abandonedByMtime;
  }
  const createdAtMs = Date.parse(parsed.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return abandonedByMtime;
  }
  // Delegated decision 2026-09-26: the same host rule as isCollaborationLockStale.
  // A pid is meaningful only in the process table of the host that issued it, so a
  // dead pid is positive evidence only for a claim that names this host. Fail-closed:
  // a claim from another host, or a legacy claim with no hostname, is foreign and
  // only the COLLABORATION_EVICT_MAX_AGE_MS backstop can abandon it.
  if (parsed.hostname === os.hostname() && !isProcessAlive(parsed.pid)) {
    return true;
  }
  return Date.now() - createdAtMs > COLLABORATION_EVICT_MAX_AGE_MS;
}

export interface CollaborationLockOptions {
  /**
   * Directory the lock, claim and staging files live in. (Adaptation: upstream
   * resolves this per call via ConfigManager — project root with a cwd fallback —
   * so runs from subdirectories share the same state. Here the composition root
   * decides once and injects it.)
   */
  stateDir: string;
  /**
   * Receives loud operational warnings — today, that a lock is being reclaimed
   * because its timestamp is unusable (W7b L6). Defaults to process.emitWarning
   * with code TESSERA_LOCK_TIMESTAMP, so the warning is never silently dropped.
   */
  warn?: (message: string) => void;
}

export interface CollaborationLockHandle {
  acquireCollaborationLock(
    command: string,
    instanceProfile?: string,
  ): Promise<{ acquired: boolean; reason?: string }>;
  releaseCollaborationLock(): Promise<void>;
  reclaimStaleLock(): Promise<void>;
  loadCollaborationLock(): Promise<CollaborationLock | null>;
  getCollaborationLockPath(): string;
  // REV-233 eviction-claim primitives.
  evictLockFile(raw: string): Promise<boolean>;
  getEvictionClaimPath(raw: string, generation: number): string;
  sweepEvictionClaims(): Promise<void>;
}

export function createCollaborationLock(
  options: CollaborationLockOptions,
): CollaborationLockHandle {
  const { stateDir } = options;
  const warn =
    options.warn ??
    ((message: string): void => {
      process.emitWarning(message, {
        type: "TesseraLockWarning",
        code: "TESSERA_LOCK_TIMESTAMP",
      });
    });

  // W7b L6: say so before evicting a lock whose createdAt made it stale by
  // anomaly rather than by age or a dead owner. Loosely parsed like isRawLockStale.
  function warnIfTimeAnomaly(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as CollaborationLock).createdAt !== "string"
    ) {
      return;
    }
    const lockInfo = parsed as CollaborationLock;
    const anomaly = describeCollaborationLockTimeAnomaly(lockInfo);
    if (anomaly === null) {
      return;
    }
    const holder =
      typeof lockInfo.pid === "number" ? `pid ${lockInfo.pid}` : "unknown pid";
    const host =
      typeof lockInfo.hostname === "string"
        ? `host ${lockInfo.hostname}`
        : "unknown host";
    warn(
      `Reclaiming the collaboration lock at ${getCollaborationLockPath()} (${holder}, ${host}) because ${anomaly}. ` +
        "If that host is still running a push, its lock has been taken over; check the clocks of the hosts sharing this state directory.",
    );
  }

  const getCollaborationLockPath = (): string =>
    path.join(stateDir, COLLABORATION_LOCK_FILE);

  async function loadCollaborationLock(): Promise<CollaborationLock | null> {
    try {
      return parseCollaborationLock(
        await fsp.readFile(getCollaborationLockPath(), "utf8"),
      );
    } catch {
      // ENOENT (no lock) and an unreadable lock are both reported as "nothing usable
      // here" — every caller treats the two identically, so they are not separated.
      return null;
    }
  }

  // The owner token of the lock this process currently holds, or null when it
  // holds none. Set only after a successful atomic create, cleared on release.
  // (Adaptation: module-level in upstream; per-factory closure state here.)
  let heldLockOwner: string | null = null;

  // Named after the exact bytes it authorizes removing, so every racer looking at the
  // same stale lock competes for the same file — and the atomic 'wx' create picks
  // exactly one of them. `generation` exists only to keep the scheme live: a claim
  // whose holder was killed mid-eviction would otherwise wedge the lock path forever,
  // so racers that agree it is abandoned all step to the same next generation and
  // again exactly one wins.
  const getEvictionClaimPath = (raw: string, generation: number): string => {
    const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    return path.join(
      stateDir,
      `${COLLABORATION_EVICT_PREFIX}${digest}.${generation}${COLLABORATION_EVICT_SUFFIX}`,
    );
  };

  // REV-233: WHY REMOVAL NEEDS A CLAIM, when the lock create is already an atomic 'wx'.
  //
  // Atomicity of the create was never the hole. The hole was the *removal*. To drop a
  // stale lock without blindly unlinking a lock a racer may have just created, the old
  // reclaim took custody of the path with a rename and put the file back if it turned
  // out to be live. Between that rename and the restore the lock path stood EMPTY — and
  // a third push's 'wx' create walked straight into it and reported success. The restore
  // then overwrote that push's lock, so two processes both believed they held the lock
  // and pushed the same records concurrently. Reproduced with a real multi-process
  // harness against a planted stale lock: 2/15 rounds with three racers, 9/12 with five
  // (three simultaneous winners in two of those). With no stale lock present, 0/12 — the
  // plain 'wx' path was always sound.
  //
  // No amount of care inside a rename-based reclaim closes that window, and a mutex over
  // the path only moves it: the mutex file is itself a contended path that has to be
  // reclaimed when abandoned, which is the same problem one level up (measured — a guard
  // built that way held at three and five racers and broke at eight).
  //
  // So removal is made exclusive the same way creation already is, with one atomic 'wx'
  // on a path derived from the bytes being removed. The path is never held aside and
  // never restored: it is emptied by exactly one process, and everyone else meets either
  // the old content (and re-evaluates) or a free path (and races for it with 'wx', which
  // is atomic). That is the whole invariant — the lock file is removed only by the winner
  // of a claim on its exact content — and it holds for the acquire path and the release
  // path alike.
  //
  // Residual: a claim holder that neither dies nor finishes for over
  // COLLABORATION_EVICT_MAX_AGE_MS is stepped over, so two evictors can be live at once;
  // they would have to interleave two syscalls precisely for the second to remove a lock
  // the first already replaced. That needs a process stalled inside three filesystem calls
  // for ten seconds — the same class of assumption the lock's own 30-minute age window
  // already rests on.
  async function evictLockFile(raw: string): Promise<boolean> {
    let generation = 0;
    // `generation` advances only on a claim we confirmed abandoned, so a claim that
    // merely vanished is retried at the same generation — stepping over it would let a
    // racer win the freed name while we win the next one, and two evictors is exactly
    // what this is here to prevent. `step` bounds the retries either way.
    for (
      let step = 0;
      step < COLLABORATION_EVICT_MAX_GENERATIONS * 2;
      step += 1
    ) {
      if (generation >= COLLABORATION_EVICT_MAX_GENERATIONS) {
        return false;
      }
      const claimPath = getEvictionClaimPath(raw, generation);
      const won = await createExclusiveWithContent(
        claimPath,
        JSON.stringify(
          {
            pid: process.pid,
            createdAt: new Date().toISOString(),
            hostname: os.hostname(),
          },
          null,
          2,
        ),
      );
      if (!won) {
        let existing: string | null;
        let mtimeMs = Number.NaN;
        try {
          // Read and stat together: the content answers "whose claim is this", and the
          // mtime answers "how old is it" for a claim the content cannot answer for.
          const [content, stats] = await Promise.all([
            fsp.readFile(claimPath, "utf8"),
            fsp.stat(claimPath),
          ]);
          existing = content;
          mtimeMs = stats.mtimeMs;
        } catch {
          existing = null;
        }
        if (existing !== null && isEvictionClaimAbandoned(existing, mtimeMs)) {
          // Every racer that agrees it is abandoned steps to the same next generation,
          // where the atomic create again admits exactly one of them.
          generation += 1;
          continue;
        }
        if (existing !== null) {
          // Someone is actively evicting this content. Back off and re-read the path.
          return false;
        }
        continue;
      }

      try {
        // Re-read under the claim. We are the only process permitted to remove this
        // content, so the only way it can have changed is its own owner releasing it —
        // and then there is nothing here for us to remove.
        let current: string | null = null;
        try {
          current = await fsp.readFile(getCollaborationLockPath(), "utf8");
        } catch {
          current = null;
        }
        if (current === raw) {
          try {
            await fsp.unlink(getCollaborationLockPath());
          } catch (e) {
            // ENOENT means it is already gone, which is the outcome we wanted. Anything
            // else (a permission problem, a read-only tree) is a real failure the caller
            // must see rather than silently treat as a released lock.
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
              throw e;
            }
          }
        }
      } finally {
        await fsp.unlink(claimPath).catch(() => undefined);
      }
      return true;
    }
    return false;
  }

  // Safe only from a process that has just created the lock: a live claim would mean a
  // racer is removing content from the lock path, but the path now holds our brand-new
  // lock, which nothing can yet have judged stale. Any claim still lying around is
  // therefore the litter of an eviction that already finished or crashed, and re-winning
  // one can only lead its holder to the same "content changed, nothing to remove" no-op.
  async function sweepEvictionClaims(): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(stateDir);
    } catch {
      // No readable state directory (or a test seam without readdir) — litter, if any,
      // is inert and the next successful acquire will get another chance to clear it.
      return;
    }
    await Promise.all(
      entries.map(async (name) => {
        const full = path.join(stateDir, name);
        if (
          name.startsWith(COLLABORATION_EVICT_PREFIX) &&
          name.endsWith(COLLABORATION_EVICT_SUFFIX)
        ) {
          await fsp.unlink(full).catch(() => undefined);
          return;
        }
        if (!name.startsWith(COLLABORATION_STAGING_PREFIX)) {
          return;
        }
        // A staging file belongs to a link() that is a syscall or two from finishing, so
        // unlinking one on age alone is safe while unlinking one on sight is not: it
        // would make its owner's link() fail spuriously.
        try {
          const stats = await fsp.stat(full);
          if (Date.now() - stats.mtimeMs > COLLABORATION_EVICT_MAX_AGE_MS) {
            await fsp.unlink(full).catch(() => undefined);
          }
        } catch {
          // Already gone, or no stat in this seam — nothing to clean either way.
        }
      }),
    );
  }

  async function acquireCollaborationLock(
    command: string,
    instanceProfile?: string,
  ): Promise<{ acquired: boolean; reason?: string }> {
    const owner = randomUUID();
    const lockPayload: CollaborationLock = {
      command,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      instanceProfile,
      owner,
      hostname: os.hostname(),
    };
    const payload = JSON.stringify(lockPayload, null, 2);

    // Creation is atomic *and* whole: two concurrent runs cannot both win the race, and
    // no racer can ever observe a lock mid-write. The retries exist for the one case the
    // atomic create cannot settle by itself — a stale lock occupying the path — where the
    // loop re-reads and re-evaluates after each eviction attempt rather than assuming
    // what it will find.
    for (
      let attempt = 0;
      attempt < COLLABORATION_LOCK_ACQUIRE_ATTEMPTS;
      attempt += 1
    ) {
      if (
        await createExclusiveWithContent(getCollaborationLockPath(), payload)
      ) {
        heldLockOwner = owner;
        await sweepEvictionClaims();
        return { acquired: true };
      }

      let raw: string | null;
      try {
        raw = await fsp.readFile(getCollaborationLockPath(), "utf8");
      } catch {
        // Usually ENOENT: released between our failed create and this read, and the
        // next iteration races for the freed path with the same atomic create. But
        // the catch is not narrowed to ENOENT, so a read that fails for any other
        // reason (EACCES, EIO) also lands here and is retried as if the path were
        // free, until the attempt budget runs out and the generic "Could not
        // acquire" result hides the real cause. Comment corrected, behaviour kept
        // as upstream (TODO 1199(c), delegated decision 2026-09-23; see VENDORED.md).
        continue;
      }

      const existing = parseCollaborationLock(raw);
      if (existing !== null && !isCollaborationLockStale(existing)) {
        const holder =
          typeof existing.pid === "number"
            ? `pid ${existing.pid}`
            : "unknown pid";
        return {
          acquired: false,
          reason: `Detected active ${existing.command} lock (${holder}) created at ${existing.createdAt}.`,
        };
      }
      if (!isRawLockStale(raw)) {
        // Live, but too malformed to describe — a legacy lock written before the
        // `command` field existed. Never evicted on those grounds alone.
        return {
          acquired: false,
          reason: "Detected an active collaboration lock.",
        };
      }

      warnIfTimeAnomaly(raw);
      if (!(await evictLockFile(raw))) {
        // Another racer is evicting the same content. Wait out its three filesystem
        // calls, with jitter so racers that arrived together do not retry in lockstep.
        await sleep(
          COLLABORATION_LOCK_RETRY_MS +
            Math.floor(Math.random() * COLLABORATION_LOCK_RETRY_MS),
        );
      }
    }

    return { acquired: false, reason: "Could not acquire collaboration lock." };
  }

  // REV-205: release must be as ownership-aware as reclaimStaleLock below. The old
  // code unlinked whatever file sat at the lock path, and a lock can legitimately
  // change hands while its original owner is still running: a push that outlives
  // the 30-minute age window is judged stale by a collaborator, who reclaims the
  // path and takes the lock: when the long push then reached the `finally` in
  // pushCommand it deleted the collaborator's LIVE lock, and the next push walked
  // straight in — two pushes writing the same records with no mutual exclusion.
  // So we remove the lock only while it still carries the token we created.
  //
  // Refusing to delete is the safe direction: a lock we cannot prove is ours is
  // left in place, and once this process exits its pid stops answering
  // process.kill(pid, 0), so isCollaborationLockStale reclaims it immediately —
  // nobody is blocked for the age window by our restraint.
  async function releaseCollaborationLock(): Promise<void> {
    const owner = heldLockOwner;
    if (owner === null) {
      // We hold no lock (never acquired, or already released). Notably this is
      // what makes a repeated release harmless: without it, a second call would
      // delete whichever lock the next push had meanwhile acquired. Checked before
      // the guard so the common no-op release costs nothing.
      return;
    }
    let raw: string | null;
    try {
      raw = await fsp.readFile(getCollaborationLockPath(), "utf8");
    } catch {
      // Gone already — OR unreadable, which is not the same thing: under EACCES or
      // EIO the file may still be there and still carry our token, and clearing
      // heldLockOwner abandons it to the stale-reclaim path (which only frees it
      // once this pid stops answering or the age window passes). The catch is not
      // narrowed to ENOENT upstream either; evictLockFile below does make that
      // distinction. Comment corrected, behaviour kept as upstream (TODO 1199(c),
      // delegated decision 2026-09-23; see VENDORED.md).
      heldLockOwner = null;
      return;
    }
    const current = parseCollaborationLock(raw);
    if (current === null || current.owner !== owner) {
      // Another acquisition owns the path now. Leave it alone, and stop claiming to
      // hold a lock, so no later release retries this.
      heldLockOwner = null;
      return;
    }
    // REV-233: release removes the lock through the same eviction claim the acquire
    // path uses, so the invariant has no exception — the lock file is only ever removed
    // by the winner of a claim on its exact content. Without that, a collaborator who
    // judged our aged-out lock stale could install its own between our read and our
    // unlink, and we would delete a live lock we do not own.
    //
    // A failure here propagates with heldLockOwner still set: the file is still there
    // and still ours, so a retry may yet release it rather than abandoning it to the
    // stale path.
    //
    // Delegated decision 2026-09-26 (W7b L7): evictLockFile returning false (a live
    // claim on our content — another process is evicting it — or the claim
    // generations exhausted) used to be ignored, and release reported success while
    // our lock stayed on disk, blocking every collaborator until this pid died or the
    // age window passed. Now: retry with jitter, and after each refusal re-read the
    // path — if our bytes are gone or replaced, the competing evictor finished the
    // job and we are released. If our lock is still there after
    // COLLABORATION_LOCK_RELEASE_ATTEMPTS, THROW (not warn) with heldLockOwner still
    // set: the caller must learn the lock is still held, and a retried release can
    // still remove it. Throwing is the fail-closed direction; a warning would let the
    // caller carry on believing the path is free.
    for (
      let attempt = 0;
      attempt < COLLABORATION_LOCK_RELEASE_ATTEMPTS;
      attempt += 1
    ) {
      if (await evictLockFile(raw)) {
        heldLockOwner = null;
        return;
      }
      await sleep(
        COLLABORATION_LOCK_RETRY_MS +
          Math.floor(Math.random() * COLLABORATION_LOCK_RETRY_MS),
      );
      let now: string | null;
      try {
        now = await fsp.readFile(getCollaborationLockPath(), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw e;
        }
        now = null;
      }
      if (now !== raw) {
        heldLockOwner = null;
        return;
      }
    }
    throw new Error(
      `Could not release the collaboration lock at ${getCollaborationLockPath()}: its eviction is blocked by a live claim after ${COLLABORATION_LOCK_RELEASE_ATTEMPTS} attempts. The lock is still held by this process; retry the release.`,
    );
  }

  // Drops a lock we've judged stale, without ever removing a lock a concurrent push may
  // have legitimately created. The removal itself goes through evictLockFile, so it is
  // exclusive and content-checked; this wrapper only supplies the staleness verdict.
  // A live lock found at the path is left exactly as it is.
  async function reclaimStaleLock(): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(getCollaborationLockPath(), "utf8");
    } catch {
      // Usually ENOENT: another racer already removed it, or there was never one.
      // The catch is not narrowed, so an unreadable lock (EACCES, EIO) is also
      // skipped silently here — a stale lock nobody can read is left in place and
      // nothing reports why. Comment corrected, behaviour kept as upstream
      // (TODO 1199(c), delegated decision 2026-09-23; see VENDORED.md).
      return;
    }
    if (!isRawLockStale(raw)) {
      return;
    }
    warnIfTimeAnomaly(raw);
    await evictLockFile(raw);
  }

  return {
    acquireCollaborationLock,
    releaseCollaborationLock,
    reclaimStaleLock,
    loadCollaborationLock,
    getCollaborationLockPath,
    evictLockFile,
    getEvictionClaimPath,
    sweepEvictionClaims,
  };
}
