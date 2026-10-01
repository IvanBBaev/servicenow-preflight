#!/usr/bin/env node
// Serialises the two operations in this workspace that cannot safely overlap:
// a build and a test run. Wrap one of them; you get an exclusive lock or a
// fast, loud refusal. Nothing waits unless the caller asks for a bounded wait
// by name — see "Opt-in bounded wait" below; by default nothing ever waits.
//
// WIRED. Every build and test entry point in this workspace goes through this
// file, at every depth — which is only possible because of the re-entrancy
// rule described at the bottom of this header. Read that before changing
// anything here; the interesting failure mode lives there, not in the lock.
//
// ── Why a lock, and why the small fix does not work ─────────────────────────
//
// Root package.json:16 (`build:all`) builds all 20 packages as one serial `&&`
// chain, in dependency order. Every packages/*/package.json carries the same
// compile step (`build:compile`, the unlocked half its wrapped `build` runs):
//
//     "build:compile": "node -e \"require('fs')
//                  .rmSync('build',{recursive:true,force:true})\" && tsc"
//     (wrapped here for width; it is a single line in the real file)
//
// So a root build is twenty destructive deletes marching down the dependency
// order. The hazard window is not a startup race that a quick check at the
// top could cover: it is open continuously for the whole run, and it MOVES
// down the graph as the chain advances. Two concurrent builds — or a build
// concurrent with a test run — guarantee that one side has artifacts deleted
// out from under a live `tsc` or a live module resolution. Three such
// collisions in one day are what prompted this file. WORKLOG.md records them
// on 2026-08-27: a second build, or an `npm test` (which imports from
// `build/`), "fails as a `TS2307` several packages deep or as `suites 0`" —
// the second shape being a test run that reports ERR_MODULE_NOT_FOUND and
// then a `suites 0 / fail N` result, which looks like a real result and is
// not one. The journals record the count and the two shapes, not which module
// each TS2307 named; an earlier revision of this header attributed them to
// three named packages, and that attribution is written down nowhere. It
// cannot be recovered by re-running, either: reproducing the collision means
// two unlocked builds at once, which is the thing this file refuses.
//
// ── The rmSync is load-bearing. Do not delete it. ───────────────────────────
//
// The obvious "fix" for the above is to drop the rmSync from the 20 build
// scripts and let `tsc` overwrite in place. That trades a loud failure for a
// silent one. Without the delete, a removed or renamed source leaves an
// orphaned .js behind in build/, and because every test suite imports from
// build/, a suite can go green against a module whose source no longer
// exists — an artifact asserting something that stopped being true, to a
// consumer that cannot notice. The delete is what makes build/ a function of
// src/ instead of an accumulation of everything src/ has ever been. Keep it,
// and serialise around it. That is what this file is.
//
// ── What to wrap ────────────────────────────────────────────────────────────
//
// Both writers and readers take this lock. `build` writes build/; `test`
// reads it, and a test run concurrent with a build hits the identical hazard —
// that is the failure that produces `suites 0`, which a reader can mistake
// for a real zero. One lock covers both directions.
//
// `lint` and `format:check` read *.ts/*.js sources and touch neither build/
// nor its consumers. They are NOT wrapped as standalone scripts; wrapping them
// would serialise runs that cannot conflict. (They do run inside the hold when
// invoked via `check` — see RE-ENTRANCY for why that trade is taken.)
//
// ── Exit codes ──────────────────────────────────────────────────────────────
//
//   <child>  Whatever the wrapped command exited with, passed through
//            unchanged. A child killed by a signal reports 128 + signum, the
//            way a shell reports it. The release at the end never changes
//            this number: a lock path found changed, unreadable or
//            unremovable underneath a finished child is reported on stderr
//            and left alone, and the child's code still stands — the build's
//            result is the one thing this process reports on behalf of, and
//            a wrapper that swapped it for its own housekeeping trouble would
//            be lying to the caller about the build.
//   75       LOCK HELD — the lock was held by a live process and THE COMMAND
//            NEVER RAN. Distinct on purpose: a caller (and CI) has to be able
//            to tell "the build failed" from "the build never started", the
//            same way a reader has to be able to tell a zero from an absence.
//            75 is sysexits.h EX_TEMPFAIL, "temporary failure, retry later",
//            which is precisely the situation. The number alone does not
//            carry the distinction, though — see "75 and 78 are not
//            reserved" below.
//   78       LOCK PATH UNUSABLE — the configured lock path cannot serve as a
//            lock, and THE COMMAND NEVER RAN. Three shapes, one code. The
//            path holds something whose bytes cannot be READ (a directory:
//            EISDIR; a file this user may not open: EACCES; a symlink loop:
//            ELOOP; …), so nothing about that hold can be established — not
//            its holder, not its liveness, not whether it would still be the
//            same hold at the instant of an unlink — and it is neither
//            honoured as live nor broken as stale. Or no lock can be CREATED
//            there (its directory missing: ENOENT; not writable: EACCES; …).
//            Or a lock proved stale there cannot be REMOVED (a sticky or
//            immutable directory holding another user's file: EPERM; the
//            write bit lost between the create attempt and the unlink:
//            EACCES; …). In every shape the path is left exactly as found
//            and the errno is printed. Not 75, because that code promises a
//            retry will clear it and nothing here says so; not 70, because
//            the fault is at the configured path, not in this script.
//            sysexits.h EX_CONFIG, "something was found in an unconfigured
//            or misconfigured state". Same caveat as 75 — see "75 and 78 are
//            not reserved" below.
//   64       Usage error — no command given, or TESSERA_BUILD_LOCK_WAIT set
//            to something that is not a whole number of seconds from 0 to
//            1800. No lock is taken and the command never runs. sysexits.h
//            EX_USAGE.
//   70       Internal failure of this script: an error that is not an errno
//            the OS returned for a syscall at the lock path — a bug in here,
//            never the environment. EX_SOFTWARE.
//   127      The command could not be spawned at all (e.g. not on PATH).
//
// ── 75 and 78 are not reserved from the wrapped command ─────────────────────
//
// An earlier revision of this header claimed, under 75 and again under 78,
// that "neither `tsc`, `node --test` nor `npm`" exits those codes, "so it
// never collides with a real child code". Measured on 2026-09-22 with the
// versions this repo runs on (tsc 5.9.3, node 22.23.2, npm 10.9.8), two of
// the three hold and the conclusion does not:
//
//   tsc          0 clean; 2 for every type error, missing entry file and
//                unusable tsconfig tried; 1 for an unknown CLI flag.
//   node --test  0 pass; 1 for a failing test, a throw at import and a
//                nonexistent path; 9 for an unusable node flag.
//   npm          returns the script's OWN code, verbatim. `npm run s` where
//                s exits 75 exits 75, and where s exits 78 exits 78.
//
// And `npm run …` is what this wrapper wraps at every wired path (see "Where
// the lock is wired"), while a child's code is propagated unchanged. So a
// child CAN hand back 75 or 78 — measured end to end: a wrapper whose own
// subtree hit a nested refusal exits 75 having RUN its command. That route is
// ordinary rather than exotic: `test:all` exits max(workspace, scripts)
// precisely so that a nested 75 survives to the top.
//
// What IS true: 75 and 78 are the codes this wrapper chooses when the command
// did not run, and no other code it chooses collides with them. What is NOT
// true is that the number alone separates "never started" from "ran, and
// returned that number". THIS process's own transcript does separate them: on
// a refusal it prints a REFUSED line and "The command did NOT run", and when
// it ran the command it prints neither. But the child's stderr is inherited
// (runChild spawns with stdio: "inherit"), so in a nested run an inner
// wrapper that has lost the hold prints its own REFUSED lines through to the
// top — where they sit beside an outer wrapper that did run its command. So
// at the top of a nested build neither the code nor a grep of the whole
// transcript is by itself a reliable discriminator. Closing that would mean
// changing the contract every wired script already reads, and it is decided
// NOT to close it (delegated decision 2026-09-23, TODO "Three owner calls
// surfaced by Lane H" (ii)): no 0-255 code is safe by construction, and a
// sentinel file or a stderr marker is one more contract for every caller to
// learn, to fix an ambiguity that only a nested run can reach. The practical
// rule for a caller is the one every wired script already follows — on 75 or
// 78, re-run — and a re-run is harmless in both readings. The `test:all`
// max-of-exits aggregation stays too ((iii)): it is correct, and the
// ambiguity is not created there. What IS enforceable today — the child's code
// coming back untouched, and this process's own transcript saying which of
// the two happened — is pinned by "a refusal code returned by the wrapped
// command itself" in scripts/build-lock.test.js.
//
// ── Lock path, and the test override ────────────────────────────────────────
//
// Default: <workspace root>/.tessera-build.lock — one directory above this
// script. Override it with the TESSERA_BUILD_LOCK environment variable, set
// to an absolute path to the lock FILE (not a directory); a relative path is
// resolved against the wrapper's cwd once and handed down absolute. A path
// that cannot serve as a lock — a directory or an unreadable file there, or
// a directory it cannot be created in — is refused with 78 rather than
// broken or blamed on this script — see the exit-code table. The suite in
// scripts/build-lock.test.js sets it to a fresh mkdtemp path for every case,
// so tests never touch the real lock. Anything else that sets it is opting
// out of the protection for that run — which is occasionally what you want
// and never what you want by accident.
//
// ── THE PROTOCOL, in five lines ─────────────────────────────────────────────
//
//   IDENTITY  a hold is named by `owner` (<pid>-<uuid>, never re-used) and
//             carries `holderStart`, the OS-reported start time of that pid.
//   ACQUIRE   the payload is written to a sibling temp file and hard-LINKED
//             into place; link() is the atomic step, so the lock name never
//             exists without complete, attributable content. EEXIST = held.
//   LIVENESS  the holder is alive iff kill(pid,0) says so AND its live start
//             time still equals `holderStart`. A recycled pid fails the
//             second half, so it can never wedge the workspace.
//   STEAL     a lock proved stale is unlinked only if a re-read immediately
//             before the unlink still shows the exact same bytes; then ONE
//             re-create attempt, and a second EEXIST is a refusal, not a fight.
//   RELEASE   unlink only while the file still carries OUR token; a caught
//             signal with no child releases and then re-raises itself, so the
//             process can never continue running with the lock dropped.
//
// ── The pid is not an identity. It is half of one. ──────────────────────────
//
// `kill(pid, 0)` answers "is SOME process numbered N alive?", and the earlier
// revision of this file treated that as "is the holder alive?". Those differ
// the moment the OS wraps its pid counter and hands N to something unrelated:
// the lock is then held, forever, by a process that never took it and will
// never release it — every build in the workspace exits 75 until somebody
// deletes the file by hand. That is the failure a staleness check exists to
// prevent, arriving through the check itself.
//
// So the recorded holder carries a second, unforgeable half: the start time
// the kernel stamped on that pid. Linux reads it from /proc/<pid>/stat field
// 22 (clock ticks since boot — an integer, immune to clocks and timezones);
// elsewhere it comes from `ps -o lstart=`, invoked with TZ=UTC and LC_ALL=C
// pinned so that the SAME process always renders the SAME string no matter
// what the ambient environment does. A signature that drifted with the locale
// would read as a recycled pid and break a live builder's lock — the opposite
// and much more expensive failure — which is why it is pinned rather than
// parsed leniently.
//
// The check is deliberately asymmetric. It only ever concludes "gone" from
// POSITIVE evidence: either ESRCH, or a start time that is present on both
// sides, of the same kind, and differs (a /proc tick count is never compared
// with a `ps` rendering — see holderLiveness). Every uncertainty — no
// signature recorded (a lock written by hand or by an older revision of this
// script), `ps` missing, /proc unreadable or malformed — resolves to ALIVE,
// because refusing a run costs one command and stealing a live builder's lock
// costs the build it was running.
//
// ── The atomic create: temp file + link(), not writeFileSync(…, "wx") ───────
//
// An earlier revision of this header claimed `wx` "creates the file and writes
// the owner in one syscall". It does not, and the claim mattered:
// fs.writeFileSync(path, data, { flag: "wx" }) is open(O_CREAT|O_EXCL) THEN
// write(). The exclusion is atomic; the CONTENT is not. Between those two
// syscalls the lock file exists and is empty — and an empty file is exactly
// what this script classifies as malformed, i.e. as a stale lock to be broken.
// So a second builder arriving in that window does not refuse: it breaks the
// live lock it just found and takes one of its own, and both proceed. Measured
// on this machine on 2026-09-22 (node 22.23.2), 40 acquires per arm, with a
// reader spinning on stat() from immediately before each write: through `wx`
// the lock name was caught existing at zero bytes in 40 of 40 acquires at a
// 1 MiB payload AND in 40 of 40 at the 254-byte production payload (the same
// fields acquire() writes below); through write-temp-then-link, in 0 of 40 at
// both sizes. The production payload shortens the window; it does not close
// it. An earlier revision of this header said "21 of 40" with no harness,
// date or second arm recorded — the figures above are the ones that can be
// re-run. The standing in-tree check is `the acquire › never leaves the lock
// name carrying partial or unattributable content` in
// scripts/build-lock.test.js.
//
// write-temp-then-link closes it. The temp file is a sibling (same directory,
// therefore same filesystem, so no EXDEV) and is fully written before the lock
// name exists at all; link() then either publishes it whole or fails EEXIST.
// The temp file is always unlinked afterwards — on success the lock name is
// already a second link to the same inode. A filesystem with no hard links
// falls back to `wx` with a LOUD line on stderr, because degrading silently to
// the race above is worse than the fallback.
//
// mkdirSync + a metadata write remains DECIDED AGAINST for the original
// reason: a lock with no contents has to record its owner in a second step,
// and a crash in that gap leaves a lock whose holder is unknowable.
//
// * NOT DONE (as opposed to decided against): no cross-machine or NFS safety.
//   Neither O_EXCL nor link() is trusted here to be atomic over NFS, and the
//   start-time discriminator is meaningless across hosts — pid 400 on another
//   machine is not this machine's pid 400 at all. This lock is scoped to one
//   checkout on one machine, which is the only way this workspace is used. If
//   that ever stops being true, this file needs a different primitive, not a
//   patch.
//
// * No wait BY DEFAULT, no queue, and never a wait that proceeds unlocked.
//   A lock that blocks and then proceeds anyway reintroduces the interleave
//   at exactly the moment the operator has stopped watching the terminal; and
//   any wait long enough to be useful is long enough that CI reports a job
//   timeout rather than a contention. Failing fast makes the collision
//   visible at the instant it happens, with a code that names it — which is
//   why it stays the default. What IS offered is a bounded, opt-in wait that
//   only ever ends in a real acquire or in the same 75 refusal; see below.
//
// ── Opt-in bounded wait (TESSERA_BUILD_LOCK_WAIT) ───────────────────────────
//
// Parallel agent lanes building different packages of this one checkout
// collide on this lock routinely, and each of them was retrying 75 by hand.
// Setting TESSERA_BUILD_LOCK_WAIT=<seconds> turns that retry into the
// wrapper's job: on contention it prints ONE stderr line saying whom it is
// waiting on and for how long, then re-runs the ordinary acquire — stale
// breaking, unreadable-path refusal and all, unchanged — with a backoff
// (250 ms doubling to a 2 s ceiling, never past the deadline) until the lock
// is taken or the deadline passes. On the deadline it refuses exactly as the
// default does — the same lines, the same 75 — plus a line saying how long it
// waited. It never proceeds without the lock. A 78 (lock path unusable) is
// not waited on: a retry does not fix a path.
//
//   * Strictly validated: unset or empty means 0; otherwise only ASCII digits,
//     0 to 1800 (30 minutes). Anything else — "-1", "1.5", "5s", " 5",
//     "1801" — is a usage error, exit 64, before any lock is touched: a typo
//     must not silently become "no wait" nor an unbounded one.
//   * 0 is the default and is the refusal path above byte for byte.
//   * Only a TOP-LEVEL run waits. A run that inherited a non-empty
//     TESSERA_BUILD_LOCK_OWNER is inside some wrapped tree: if the file still
//     carries its token it passes through (RE-ENTRANCY, below) and never
//     reaches the acquire at all; if the file does not, its tree has LOST the
//     hold, and the right reaction is the immediate 75 the header promises —
//     waiting would let the inner step of a tree whose hold is gone queue up
//     behind the new holder and then run, the rest of its tree unlocked
//     around it, and in the worst case wait out its own parent. So a nested
//     run never waits, whatever the variable says; its refusal says so.
//
// Delegated decision 2026-09-30 (wave 16): opt-in, not default. Every wired
// script, CI and the header's contract read 75 as "the command did not run,
// and it happened NOW"; making waiting the default would turn a visible
// collision into a silent stall in every terminal and CI job that never asked
// for one, and would change the timing of a contract callers already branch
// on. The lanes that want a wait can ask for it in their own environment.
//
// * One exclusive lock, not a reader/writer lock. DECIDED AGAINST the
//   shared/exclusive split. The honest cost, stated rather than implied: two
//   concurrent test runs cannot conflict with each other, and this lock
//   excludes them anyway — `npm test` in two terminals now refuses where it
//   used to work. That is a real loss. It is accepted because a reader/writer
//   protocol in files needs a reader count, a reader count needs its own
//   atomic update, and each registered reader needs its own liveness reaping —
//   a second concurrency problem introduced to hold the first one still.
//   Revisit only if parallel test runs become a workflow someone actually
//   uses, not merely one that is now impossible.
//
// ── RE-ENTRANCY — the reason this is not a one-line wrapper ─────────────────
//
// Every path that builds is wrapped: the root `build`, the root `test`, the
// root `check`, and all 20 per-package `build`/`test` scripts. That is a
// requirement, not thoroughness — a lock that only guards the root leaves
// `npm run build -w @tessera/core` unprotected, and an unprotected path is
// indistinguishable from no lock on the day someone uses it.
//
// But wrapping every path means the paths NEST. `npm run check` calls the
// wrapped `build`, which calls the wrapped per-package `build` twenty times.
// A wrapper that simply acquires would refuse itself with 75 at depth 2 — a
// self-deadlock that reads exactly like real contention.
//
// So an inner run has to answer a question the outer one never asks: am I
// already inside a hold that MY OWN process tree took? Not "is a lock file
// present" — that is true in both the case that must proceed and the case
// that must be refused.
//
//   THE BOOLEAN DOES NOT WORK. The obvious mechanism is an inherited
//   environment variable — TESSERA_BUILD_LOCK_HELD=1, set before spawning the
//   child. It fails in both directions:
//
//     * It is inherited by exactly the processes that must be let through,
//       which looks like the point, but it says nothing about WHOSE lock. Our
//       hold can end while our subtree is still running — our lock is judged
//       stale and broken, or removed by hand, and a second tree acquires. The
//       flag is still 1 in every process we already spawned, so twenty inner
//       builds sail past a lock that now belongs to somebody else, and delete
//       build/ underneath them. That is the original bug, wearing the
//       protection as a costume.
//
//     * It is a claim with no issuer. One stray `export` in a shell profile,
//       one leftover from a killed run re-used in the same terminal, and every
//       build in that shell is permanently unlocked — silently, and with the
//       lock file still dutifully appearing in the repo as evidence of
//       something that is not happening.
//
// WHAT IS ACTUALLY DONE. Acquisition mints a token — `<pid>-<uuid>`, unique
// per hold, never re-used — writes it into the lock file as `owner`, and
// exports it to children as TESSERA_BUILD_LOCK_OWNER. A run is re-entrant if
// and only if ALL THREE hold:
//
//     1. it inherited a non-empty token, AND
//     2. the lock file on disk RIGHT NOW carries `owner` equal to that exact
//        token, AND
//     3. the recorded holder is still alive — the same pid AND the same
//        process behind it, per LIVENESS above.
//
// (2) is the whole difference. The inherited token is not trusted as a
// permission; it is a name, checked against the live file every single time.
// The moment our hold ends — broken as stale, released, replaced by another
// tree — the file stops carrying our token and every remaining inner run
// falls back to a normal acquire, which refuses with 75 against the new
// holder. The pass-through cannot outlive the hold that justified it. (3)
// covers the orphan case: the outer wrapper is SIGKILLed, its subtree keeps
// running, and its lock is now breakable-as-stale by a third party; an
// orphaned inner build must stop rather than race the tree that breaks it.
//
// The token is also what RELEASE compares against, so acquire, re-entrancy
// and release all key on one identity. A pid would be a second, weaker one:
// the OS recycles pid numbers, so "the file records my pid" does not mean
// "the file is my hold" — an invariant that a container sharing this checkout,
// or a lock file restored under a running build, quietly removes.
//
// A token from another tree cannot be inherited — environments do not cross
// process trees — and copying one by hand buys nothing, because a token only
// matches while the process that minted it still holds the file.
//
// THE FAILURE THIS IS SHAPED AGAINST: a re-entrancy check that answers "yes"
// unconditionally is invisible. Every build goes green, the wrapper is on
// every path, and the lock is never taken by anyone — protection that reports
// success while protecting nothing. The suite pins it from the outside:
// `a top-level run` asserts the lock file EXISTS while the wrapped command is
// running, and `a foreign tree` asserts that a run WITHOUT the token is still
// refused 75 while a re-entrant subtree is mid-flight. Both fail the instant
// re-entrancy becomes unconditional.
//
// ── Signals: release AND die, never release and continue ────────────────────
//
// A caught SIGINT/SIGTERM has exactly two correct shapes. With a child
// running, forward the signal and stay alive: the child dies first, the normal
// close → finally → release path executes, and the hold covers the builder for
// as long as the builder exists. With NO child — the signal landed between
// taking the lock and spawning — release and then re-raise the signal on
// ourselves with the default disposition. What must never happen is the third
// shape, releasing and then RETURNING: the wrapper would carry on, spawn the
// wrapped command and run the whole build with the lock dropped, which is the
// two-holders failure the file exists to prevent, reached from inside the
// safety mechanism. Nothing here can help against SIGKILL, which is why
// LIVENESS above is the real backstop and this is only a courtesy.
//
// ── Where the lock is wired (tessera/package.json + packages/*/package.json) ─
//
//   root  build   → build-lock npm run build:all      (the 20-package chain)
//   root  test    → build-lock npm run test:all       (workspaces + this suite)
//   root  check   → build-lock npm run check:all      (build, lint, fmt, test)
//   pkg   build   → build-lock npm run build:compile  (rmSync + tsc)
//   pkg   test    → build-lock npm run test:run       (node --test)
//
// `check` IS wrapped, which the pre-re-entrancy design could not do. It is
// worth the extra hold: unwrapped, `check` releases the lock between its build
// and its test, and another build starting in that window corrupts build/
// underneath the test run — producing the `suites 0` shape this exists to
// prevent. `lint` and `format:check` remain unwrapped as standalone scripts;
// they read sources only and cannot conflict.
//
// The `:all` / `:compile` / `:run` inner scripts hold the original commands
// verbatim. Do not call them directly except to deliberately bypass the lock;
// they are the unlocked halves, and they are named that way on purpose.
//
// ── Importable, but only when it is provably not the entry point ────────────
//
// The bottom of this file runs main() unless it can PROVE it was imported
// (argv[1] resolves to a different file). The proof is required in that
// direction and not the other, because a wrapper that silently declines to run
// would let every build in the workspace report success while taking no lock
// at all — so every ambiguity resolves to "run". The exports exist for
// scripts/build-lock.test.js, which needs to construct one state the entry
// point cannot be steered into from outside: holding the lock with no child,
// the state the signal path is judged on. Three functions are exported —
// acquire, installSignalHandlers and mintToken — because the suite's signal
// helper builds that state out of them, and it is their only consumer.
// Nothing else is exported: every other function is reached through the
// entry point, and the suite reaches it that way.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Held by a live process; the wrapped command never ran. sysexits EX_TEMPFAIL. */
const EXIT_LOCK_HELD = 75;
/**
 * The lock path cannot serve as a lock — its bytes cannot be read, no lock can
 * be created there, or a lock proved stale there cannot be removed; the
 * wrapped command never ran and the path was left as found. sysexits EX_CONFIG.
 */
const EXIT_LOCK_PATH_UNUSABLE = 78;
/** No command given. sysexits EX_USAGE. */
const EXIT_USAGE = 64;
/** This script itself failed — a bug here, not a fault at the lock path. sysexits EX_SOFTWARE. */
const EXIT_INTERNAL = 70;
/** The command could not be spawned at all. Shell convention. */
const EXIT_SPAWN_FAILED = 127;

/** Absolute path to the lock file; exported to children so it cannot drift. */
const LOCK_PATH_ENV = "TESSERA_BUILD_LOCK";
/** Names ONE hold. Inherited by our subtree; checked against the live file. */
const OWNER_ENV = "TESSERA_BUILD_LOCK_OWNER";
/** Opt-in: seconds a top-level run may wait for a held lock. Unset = 0. */
const WAIT_ENV = "TESSERA_BUILD_LOCK_WAIT";
/**
 * Ceiling on WAIT_ENV. Delegated decision 2026-09-30 (wave 16): 30 minutes —
 * longer than a full root `check` takes today, short enough that a wedged
 * holder surfaces as a 75 within one sitting rather than as a CI job timeout.
 */
const MAX_WAIT_SECONDS = 1800;
/** First pause between acquire attempts while waiting; doubles each time. */
const WAIT_BACKOFF_START_MS = 250;
/** Largest pause between acquire attempts while waiting. */
const WAIT_BACKOFF_MAX_MS = 2000;

/** Caught so a Ctrl-C releases the lock instead of leaving it to be broken. */
const CAUGHT_SIGNALS = ["SIGINT", "SIGTERM"];

/**
 * link() failures that mean "this filesystem cannot do that", as opposed to
 * EEXIST, which means "someone already holds the lock". Only these fall back
 * to the non-atomic create, and only loudly.
 */
const LINK_UNSUPPORTED = new Set([
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
  "EMLINK",
  "EXDEV",
]);

const SELF_PATH = fileURLToPath(import.meta.url);
const WORKSPACE_ROOT = path.resolve(path.dirname(SELF_PATH), "..");
const DEFAULT_LOCK_FILE = path.join(WORKSPACE_ROOT, ".tessera-build.lock");

/**
 * The token of the hold THIS process took, or null when it took none.
 *
 * One variable, because there is exactly one question — "is the lock on disk
 * the hold I created?" — and a second way of asking it is a second answer
 * waiting to disagree. It doubles as the "do I hold anything at all?" flag, so
 * a re-entrant run (which never acquires) can never reach an unlink.
 */
let heldToken = null;
/** The running child, so a forwarded signal can reach it. */
let activeChild = null;

function log(message) {
  process.stderr.write(`build-lock: ${message}\n`);
}

function resolveLockFile(env = process.env) {
  const override = env[LOCK_PATH_ENV];
  return typeof override === "string" && override.trim() !== ""
    ? path.resolve(override.trim())
    : DEFAULT_LOCK_FILE;
}

/**
 * The opt-in wait, in whole seconds, or null when WAIT_ENV is set to anything
 * that is not one. Unset and "" both mean 0 — the default, which never waits.
 *
 * Deliberately strict: no trimming, no sign, no fraction, no unit, nothing
 * above MAX_WAIT_SECONDS. A lenient parse would turn a typo into either "no
 * wait" (a surprise 75) or a much longer wait than meant, and the operator
 * would learn which only by watching; a usage error says so at once.
 */
function resolveWaitSeconds(env = process.env) {
  const raw = env[WAIT_ENV];
  if (raw === undefined || raw === "") return 0;
  if (!/^[0-9]+$/.test(raw)) return null;
  const seconds = Number(raw);
  return seconds <= MAX_WAIT_SECONDS ? seconds : null;
}

/** Resolve after `ms`; a caught signal still runs its handler meanwhile. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Seconds, one decimal, for the waited-for lines. */
function secondsSince(startedAt) {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

/**
 * Inspect an existing lock file.
 *
 * `raw` comes back with the other fields because breaking a lock has to prove,
 * immediately before the unlink, that the file is still the one it judged —
 * and the cheapest proof of "still the same hold" is "still the same bytes".
 * "unreadable" carries no `raw` for exactly that reason: there are no bytes,
 * so there is nothing a break could prove against, and acquire() must not
 * try — see its unreadable branch.
 *
 * @returns {{ state: "gone" }
 *   | { state: "unreadable", code: string }
 *   | { state: "malformed", reason: string, raw: string }
 *   | { state: "held", pid: number, owner: string, holderStart: string,
 *       acquiredAt: string, command: string, raw: string }}
 */
function readHolder(lockFile) {
  let raw;
  try {
    raw = fs.readFileSync(lockFile, "utf8");
  } catch (error) {
    // Released between our failed create and this read. Not stale, just gone;
    // the caller simply retries the create.
    if (error.code === "ENOENT") return { state: "gone" };
    // Anything else (EISDIR, EACCES, ELOOP, …): the bytes could not be read at
    // all. That is a different fact from "read, and malformed", and it gets
    // different treatment — a malformed lock can be broken because its bytes
    // are in hand to prove it unchanged at the unlink; an unreadable one has
    // no bytes and cannot be. Reported as its own state, with the errno.
    return {
      state: "unreadable",
      code: typeof error.code === "string" ? error.code : String(error),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "malformed", reason: "payload is not valid JSON", raw };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "malformed", reason: "payload is not an object", raw };
  }
  const { pid } = parsed;
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      state: "malformed",
      reason: `no usable pid (${String(pid)})`,
      raw,
    };
  }

  return {
    state: "held",
    pid,
    // "" when absent, and a re-entrancy claim is only ever compared against a
    // NON-EMPTY inherited token — so a lock file with no owner (hand-written,
    // or from an older revision of this script) can never match one.
    owner: typeof parsed.owner === "string" ? parsed.owner : "",
    // "" when absent, which disables the recycled-pid discriminator for this
    // lock and falls back to the bare pid probe. Absent is not evidence of
    // anything, and this check only ever concludes "gone" from evidence.
    holderStart:
      typeof parsed.holderStart === "string" ? parsed.holderStart : "",
    acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
    command:
      typeof parsed.command === "string" && parsed.command !== ""
        ? parsed.command
        : "(command unrecorded)",
    raw,
  };
}

/**
 * The kernel's start time for a pid, or null when it cannot be established.
 *
 * This is the half of the holder's identity that a recycled pid cannot carry.
 * It is only ever compared against another value produced by this same
 * function, so the exact spelling does not matter — stability does, which is
 * why the `ps` path pins TZ and LC_ALL. A drifting spelling would read as a
 * recycled pid and break a live builder's lock.
 *
 * null means "unknown", never "gone": callers must resolve unknown to alive.
 *
 * @param {{ platform?: string, procRoot?: string }} [probe] test seam only.
 *   Every production caller omits it, and the defaults are exactly what this
 *   function read before the seam existed: `process.platform`, and "/proc".
 *
 * Delegated decision 2026-10-01 (wave 17): the Linux /proc branch below had
 * never run on the darwin box that develops this script, so the suite was a
 * false green for the platform CI runs on. The seam that closes that is an
 * optional parameter, not an environment variable: an env override would be
 * reachable by every caller of every wrapped build (and inherited by every
 * child), whereas a parameter is reachable only by code that imports this
 * module — which, per the export note at the bottom of the file, is the test
 * suite and nothing else. Omitted, it is byte-for-byte the old behaviour.
 */
function processStartSignature(pid, probe = {}) {
  const platform = probe.platform ?? process.platform;
  const procRoot = probe.procRoot ?? "/proc";
  if (platform === "linux") {
    try {
      const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, "utf8");
      // Field 2 (comm) can contain spaces and parentheses, so fields are
      // counted from after the LAST ')'. Field 22 (starttime) is then the
      // 20th entry of the remainder.
      //
      // Delegated decision 2026-10-01 (wave 17): the ')' must exist and be
      // followed by a space. Without that check, content with no comm
      // terminator was sliced from index 1 and its 20th token — some other
      // number — was returned as the start time, i.e. malformed content was
      // read as a DIFFERENT process. Malformed now falls through like a
      // missing file does, and yields no proc: signature at all.
      const close = stat.lastIndexOf(")");
      const rest =
        close >= 0 && stat[close + 1] === " "
          ? stat.slice(close + 2).split(" ")
          : [];
      const startTicks = rest[19];
      if (typeof startTicks === "string" && /^\d+$/.test(startTicks)) {
        return `proc:${startTicks}`;
      }
    } catch {
      // No /proc entry (the process is gone, or /proc is not mounted): fall
      // through to ps rather than guessing.
    }
  }

  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const started = out.trim().replace(/\s+/g, " ");
    return started === "" ? null : `ps:${started}`;
  } catch {
    // ps absent, or it exited non-zero because the pid is gone. Either way we
    // have learnt nothing new: the caller already has kill(pid, 0) for "gone".
    return null;
  }
}

/**
 * Is SOME process numbered `pid` alive?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. ESRCH is the ONLY code that means "no such process". EPERM means
 * the opposite of dead: the process EXISTS and belongs to another user, so
 * breaking its lock would strip a running build. Any other code is
 * unexpected, and we resolve unexpected toward "alive" deliberately —
 * refusing a run is recoverable in one command, breaking a live lock is not.
 *
 * This answers strictly less than "is the holder alive?" — see holderLiveness.
 */
function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true; // exists, owned by someone else
    return error.code !== "ESRCH";
  }
}

/**
 * Is the recorded holder — that pid, and that same process behind it — still
 * running?
 *
 * Two clauses, and the second one is the whole point. A pid alone is a number
 * the OS re-issues; once it has been re-issued, `kill(pid, 0)` reports the
 * holder of a lock as alive forever, and every build in the workspace exits 75
 * until the file is deleted by hand. The recorded start time is what tells
 * "still the holder" from "somebody else wearing its number".
 *
 * "Gone" is only ever concluded from positive evidence — ESRCH, or two start
 * times that are both present and differ. Unknown resolves to alive.
 *
 * @returns {{ alive: boolean, reason: string }} `reason` is non-empty only
 *   when the holder is gone, and says which of the two clauses failed, because
 *   a lock broken without a stated reason is a lock nobody can audit.
 */
function holderLiveness(pid, holderStart, probe = {}) {
  if (!pidExists(pid)) {
    return {
      alive: false,
      reason: `holder PID ${pid} is gone (ESRCH); it died without releasing`,
    };
  }
  if (holderStart === "") return { alive: true, reason: "" };

  const live = processStartSignature(pid, probe);
  if (live === null || live === holderStart) {
    return { alive: true, reason: "" };
  }
  // Delegated decision 2026-10-01 (wave 17): a /proc tick count and a `ps`
  // rendering are two different spellings of a start time, never equal even
  // for the same process. They meet when one side's /proc read failed and it
  // fell back to `ps` — a Linux hold recorded as proc:N, re-checked while
  // /proc is unreadable or malformed. That mismatch is a difference of SOURCE,
  // not of process, so it is "unknown" and resolves to alive. Only a known
  // kind on both sides is guarded; a recorded value of neither kind (a lock
  // written by hand) keeps the old plain comparison.
  const kindOf = (signature) => /^(proc|ps):/.exec(signature)?.[1] ?? "";
  const recordedKind = kindOf(holderStart);
  const liveKind = kindOf(live);
  if (recordedKind !== "" && liveKind !== "" && recordedKind !== liveKind) {
    return { alive: true, reason: "" };
  }

  return {
    alive: false,
    reason:
      `PID ${pid} is alive but is NOT the holder — it started at ${live}, ` +
      `the hold recorded ${holderStart}; the pid was recycled`,
  };
}

/**
 * One name for one hold. The pid makes it readable in the lock file; the uuid
 * makes it unguessable and, more importantly, unrepeatable — a token is never
 * valid for a second hold, so a token left over in some environment cannot
 * authorise anything once the hold that minted it is over.
 */
function mintToken() {
  return `${process.pid}-${randomUUID()}`;
}

/**
 * Are we already inside a hold taken by our own process tree?
 *
 * This is the re-entrancy gate, and it is the one function in this file whose
 * failure is silent: answer "yes" too readily and every build sails through
 * an unlocked workspace while the wrapper still reports success. So it is
 * deliberately three conjoined conditions, not one:
 *
 *   1. we inherited a non-empty token (only our own subtree can have it —
 *      environments do not cross process trees);
 *   2. the lock file ON DISK, RIGHT NOW, names that exact token as its owner;
 *   3. the recorded holder is still alive, pid AND process both.
 *
 * (1) alone is the boolean flag, and it is wrong: it survives our hold ending.
 * If our lock is broken as stale and another tree acquires, the token we
 * exported is still in every child's environment, but the FILE no longer
 * carries it — (2) is what notices, on every single inner run, and sends the
 * child back to a normal acquire that will be refused 75 by the new holder.
 * (3) handles the orphan: our wrapper SIGKILLed, its subtree still running,
 * its lock now breakable-as-stale by anyone; those inner builds must stop
 * rather than race whoever breaks it.
 *
 * @returns {{ pid: number, owner: string, acquiredAt: string,
 *   command: string } | null} the hold we are inside, or null for "acquire
 *   normally" — never a bare boolean, so a caller cannot use it without also
 *   holding the identity that justified it.
 */
function inheritedHold(lockFile, env = process.env) {
  const claimed =
    typeof env[OWNER_ENV] === "string" ? env[OWNER_ENV].trim() : "";
  if (claimed === "") return null;

  const holder = readHolder(lockFile);
  if (holder.state !== "held") return null;
  if (holder.owner !== claimed) return null;
  if (!holderLiveness(holder.pid, holder.holderStart).alive) return null;
  return holder;
}

/**
 * Remove a lock we have proved stale — but only if it is still, byte for byte,
 * the lock we proved stale.
 *
 * Between reading a holder and deciding it is dead there is real elapsed time
 * (a kill probe, and possibly a `ps`), and in that time the dead holder's lock
 * can be broken by someone else and replaced by a live one. Unlinking blindly
 * at that point deletes a running builder's lock — the exact failure this file
 * exists to prevent, committed by the mechanism that prevents it. Re-reading
 * immediately before the unlink narrows the window to the two syscalls between
 * the read and the unlink; closing it entirely needs a primitive this
 * filesystem does not offer.
 *
 * @returns {{ state: "broken" }
 *   | { state: "changed" }
 *   | { state: "fault", op: "read" | "unlink", code: string }} `broken` when
 *   the lock is gone (we removed it, or it already was); `changed` when the
 *   file changed under us and must not be touched; `fault` when the path
 *   itself stopped cooperating — the re-read or the unlink came back with an
 *   errno — and the break was abandoned with the file left exactly as found.
 */
function breakLock(lockFile, expectedRaw) {
  let current;
  try {
    current = fs.readFileSync(lockFile, "utf8");
  } catch (error) {
    // Already gone: another process judged the same lock stale and broke it
    // first. That is the outcome we wanted, so it is not an error.
    if (error.code === "ENOENT") return { state: "broken" };
    if (!isPathFault(error)) throw error;
    // A read that succeeded moments ago in readHolder() — every caller arrives
    // here with bytes it just read — and fails now: the path changed underneath
    // the proof (a directory swapped in, a mode flipped). There are no bytes to
    // prove the file unchanged against, and a break never proceeds without
    // that proof. Reported, not thrown: the caller refuses the acquire the way
    // it refuses any lock path it cannot read, and the transcript says which
    // step failed and why — a stack trace would leave the "breaking STALE"
    // line above it standing as a claim.
    return { state: "fault", op: "read", code: error.code };
  }
  if (current !== expectedRaw) return { state: "changed" };

  try {
    fs.unlinkSync(lockFile);
  } catch (error) {
    if (error.code === "ENOENT") return { state: "broken" };
    if (!isPathFault(error)) throw error;
    // Proved stale, and still there: the path will not let this user unlink it
    // (a sticky directory and a file owned by somebody else, an immutable
    // flag, a write bit lost since the create attempt — a directory that was
    // never writable fails the create first and never reaches this line).
    // Nothing to retry, nothing to fight; the caller refuses.
    return { state: "fault", op: "unlink", code: error.code };
  }
  return { state: "broken" };
}

/**
 * Said only when breakLock() declined. The "breaking STALE lock" line is
 * printed BEFORE the attempt, so without this one the transcript would claim
 * an unlink that did not happen — to a reader with no way to notice.
 */
function reportAbandonedBreak(lockFile, result) {
  if (result.state === "changed") {
    log(
      `NOT broken — ${lockFile} changed between the proof and the unlink; ` +
        `the hold now on disk is not the one proved stale and was left in place.`,
    );
    return;
  }
  const step =
    result.op === "read"
      ? `could not be re-read at the unlink (${result.code}), so there is no proof the file is still the one proved stale`
      : `could not be unlinked (${result.code})`;
  log(`NOT broken — ${lockFile} ${step}; it was left exactly as found.`);
}

/**
 * Break a lock proved stale, and say so if it could not be. Returns the
 * refusal acquire() must hand back when the path itself stopped cooperating,
 * or null when the acquire may go on to its one re-create attempt — whether
 * the break went ahead or was abandoned because the file changed; either way
 * the file is somebody's business again and the re-create decides.
 */
function breakOrRefuse(lockFile, expectedRaw) {
  const result = breakLock(lockFile, expectedRaw);
  if (result.state === "broken") return null;
  reportAbandonedBreak(lockFile, result);
  if (result.state === "changed") return null;
  return { ok: false, unusable: { op: result.op, code: result.code } };
}

/**
 * An errno the OS returned for a syscall — the shape of every fs error that
 * names a path fault (EISDIR, EACCES, ENOENT, ELOOP, …) — as opposed to an
 * error this script raised on itself (a TypeError, an ERR_* misuse), which
 * carries no syscall. The first is the environment's and is reported with its
 * code; the second is a bug and is allowed to reach the top-level catch and
 * exit 70, whose header entry promises exactly that.
 */
function isPathFault(error) {
  return typeof error?.code === "string" && typeof error?.syscall === "string";
}

/**
 * Publish `payload` under `lockFile` if and only if no lock file exists.
 *
 * The lock name is created by link(), never by a write, so it cannot be
 * observed half-written. See the atomic-create section of the header for why
 * `writeFileSync(…, { flag: "wx" })` is not equivalent: it creates the name
 * first and fills it afterwards, and an empty lock file is classified as
 * stale — which turns the gap into a lock steal rather than a refusal.
 *
 * Any errno other than EEXIST (held) and the LINK_UNSUPPORTED set (degrade)
 * propagates: a missing or unwritable directory, a link() this user may not
 * make. acquire() turns those into the 78 refusal, naming the path and the
 * code — the command never ran, and no retry will change what the OS said.
 *
 * @returns {"created" | "exists"}
 */
function publishLockFile(lockFile, payload) {
  const tmp = path.join(
    path.dirname(lockFile),
    `.${path.basename(lockFile)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, payload, { flag: "wx" });
    try {
      fs.linkSync(tmp, lockFile);
      return "created";
    } catch (error) {
      if (error.code === "EEXIST") return "exists";
      if (!LINK_UNSUPPORTED.has(error.code)) throw error;
      // Loud, because this is the protection degrading, not failing: the
      // fallback re-opens a window the header describes in detail.
      log(
        `WARNING: ${path.dirname(lockFile)} cannot hard-link (${error.code}); ` +
          `falling back to a non-atomic create. Two builders starting within ` +
          `microseconds of each other may now BOTH proceed.`,
      );
      try {
        fs.writeFileSync(lockFile, payload, { flag: "wx" });
        return "created";
      } catch (fallbackError) {
        if (fallbackError.code === "EEXIST") return "exists";
        throw fallbackError;
      }
    }
  } finally {
    // On success the lock name is a second link to this inode, so dropping the
    // temp name leaves the lock itself untouched.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best effort. A temp file orphaned by a SIGKILL mid-acquire is litter,
      // not a lock: nothing reads it and the next acquire uses a fresh name.
    }
  }
}

/**
 * Take the lock, breaking it first if the recorded holder is provably gone.
 *
 * @returns {{ ok: true }
 *   | { ok: false, holder: { pid: number, acquiredAt: string,
 *       command: string } | null }
 *   | { ok: false, unusable: { op: "read" | "create" | "unlink",
 *       code: string } }} `unusable` is a refusal of a different kind from
 *   `holder`: not "someone is there", but "the path itself will not serve" —
 *   its bytes cannot be read, a lock cannot be created there, or a lock
 *   proved stale there cannot be removed — with the step and the errno.
 *   main() exits it differently, because a retry is what fixes the first and
 *   not the second.
 */
function acquire(lockFile, command, args, token) {
  const payload = `${JSON.stringify(
    {
      pid: process.pid,
      // The other half of the holder's identity: without it a recycled pid
      // makes this hold immortal. "" when the OS will not tell us, which
      // degrades to the bare pid probe rather than to a guess.
      holderStart: processStartSignature(process.pid) ?? "",
      // The token our subtree will present back to us. It lives in the file,
      // not only in the environment, so the pass-through can be revoked by the
      // file changing — which is exactly how a broken-as-stale lock revokes it.
      owner: token,
      acquiredAt: new Date().toISOString(),
      command: [command, ...args].join(" "),
      cwd: process.cwd(),
    },
    null,
    2,
  )}\n`;

  // Two attempts at most: the first, and one more after breaking a lock we
  // proved stale. Deliberately not open-ended — if a third party wins the
  // re-create, that is live contention and we refuse rather than fight for it.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // Claimed before the file can exist, so that a signal landing between the
    // create and the assignment still finds an owner to check the file
    // against. release() compares the token to what is on disk, so a claim
    // that never became a lock cannot remove anybody else's.
    heldToken = token;
    let published;
    try {
      published = publishLockFile(lockFile, payload);
    } catch (error) {
      heldToken = null;
      if (!isPathFault(error)) throw error;
      // The OS would not let a lock be created at the configured path — its
      // directory is missing, or not writable by this user, or link() itself
      // is forbidden there. Nothing was left behind (the temp name is cleaned
      // up on the way out) and nothing is retried: the answer is a property
      // of the path, not of the moment. Refused under 78 with the errno, so
      // the caller reads "the path is misconfigured" and not "this script
      // crashed" — the fault is the environment's and 70 would blame us.
      return { ok: false, unusable: { op: "create", code: error.code } };
    }
    if (published === "created") return { ok: true };
    heldToken = null;

    // Second EEXIST: someone real is there. Stop breaking things and refuse.
    if (attempt === 2) break;

    const holder = readHolder(lockFile);
    if (holder.state === "gone") continue; // released under us; retry
    if (holder.state === "unreadable") {
      // The bytes could not be read, so nothing about the hold is known: not
      // who took it, not whether it is live, and not whether it would still
      // be the same hold at the instant of an unlink — breakLock()'s re-read
      // proof compares bytes, and there are none. Breaking blind here would
      // unlink a hold that may well be live: on a shared checkout with umask
      // 077 one user's live lock is mode 0600 and the next user reads it as
      // EACCES, and a blind break there lets two builds interleave — the one
      // thing this file exists to prevent. So an unreadable lock is neither
      // honoured as live nor broken as stale. It is refused, with the errno,
      // and left exactly as found; main() reports it under its own code.
      return { ok: false, unusable: { op: "read", code: holder.code } };
    }
    if (holder.state === "malformed") {
      // Readable but malformed counts as stale: the bytes were read and do
      // not name a pid, so no holder can ever be proved alive or dead, and
      // honouring it would wedge every future build. Breaking it is safe
      // because those bytes ARE in hand — breakLock() re-reads and unlinks
      // only if they are still identical, so a live hold that replaced them
      // in the meantime is left alone. Contrast the unreadable branch above,
      // which has no bytes to make that proof with.
      log(
        `breaking STALE lock ${lockFile} — ${holder.reason}; ` +
          `an unattributable lock cannot be honoured.`,
      );
      const refusal = breakOrRefuse(lockFile, holder.raw);
      if (refusal) return refusal;
      continue;
    }

    const liveness = holderLiveness(holder.pid, holder.holderStart);
    if (liveness.alive) return { ok: false, holder };

    // Without this branch the first crashed or killed build would wedge the
    // repo forever, and a lock that occasionally costs a build would instead
    // cost every build. The reason is printed because a lock broken silently
    // is a lock nobody can audit afterwards.
    log(`breaking STALE lock ${lockFile} — ${liveness.reason}.`);
    const refusal = breakOrRefuse(lockFile, holder.raw);
    if (refusal) return refusal;
  }

  const holder = readHolder(lockFile);
  // What the second EEXIST was: the same fact gets the same report whichever
  // attempt found it. Unreadable now is still "nothing here can be read", not
  // "someone re-took it" — the latter is a guess this process cannot check.
  if (holder.state === "unreadable") {
    return { ok: false, unusable: { op: "read", code: holder.code } };
  }
  return { ok: false, holder: holder.state === "held" ? holder : null };
}

/**
 * Drop the lock, but only if the file on disk is still the hold WE took.
 *
 * Re-reading before unlinking is the whole point: if our lock was judged
 * stale and broken while we ran, the file now on disk belongs to a live
 * process, and deleting it would cause exactly the failure this script
 * exists to prevent.
 *
 * "Ours" is the token, not the pid — the same identity acquire() writes and
 * inheritedHold() checks. A pid answers a weaker question ("was this file
 * written by a process numbered like me?") and the OS recycles the number, so
 * a hold that is not ours can carry it: a lock file authored in another pid
 * namespace (a container sharing this checkout over a bind mount), or one
 * restored underneath a running build by a sync/backup tool. The token is
 * minted once per hold and never re-used, so it cannot be worn by a hold we
 * did not take.
 *
 * Never throws for a fault at the lock path. The file already gone is a
 * correct outcome (broken as stale, or removed by hand) and passes in
 * silence; anything else found there — a directory swapped in, a mode
 * flipped, bytes that are no lock payload, somebody else's hold, an unlink
 * the directory refuses — is reported to stderr and left alone. The token is
 * dropped either way so the `exit` listener does not say it all again. The
 * number this process exits with stays the wrapped command's: this function
 * runs after the child has finished, and its trouble is housekeeping
 * trouble, which the `<child>` row of the header promises never to pass off
 * as the build's result. Reading through readHolder() keeps this the same
 * classification acquire() uses, so "what the next run will do about it" is
 * stated from the branch the next run will actually take.
 */
function release(lockFile) {
  if (heldToken === null) return;
  const ours = heldToken;
  heldToken = null;

  const holder = readHolder(lockFile);
  // Gone on release is a correct outcome, not an error: the lock we held is
  // already removed (broken as stale, or by hand). There is nothing left to
  // remove and nothing worth reporting.
  if (holder.state === "gone") return;

  if (holder.state === "unreadable") {
    // Whether the path still carries our token cannot be established, and an
    // unlink without that proof is the blind delete this function exists to
    // avoid. So nothing is removed; the next acquire will find the same
    // EEXIST-then-unreadable and refuse it, which is said here so the operator
    // learns it from this run and not from the next one failing.
    log(
      `not releasing ${lockFile}: the lock path cannot be read (${holder.code}), ` +
        `so whether it still carries our hold cannot be established; it was ` +
        `left exactly as found. The next run will refuse it ` +
        `(exit ${EXIT_LOCK_PATH_UNUSABLE}) until that path holds a regular ` +
        `file or nothing.`,
    );
    return;
  }

  if (holder.state === "malformed") {
    // Not a hold at all any more — the wrapped command, or something else,
    // overwrote it. Not ours, so not unlinked; and not described as somebody's
    // hold, because bytes with no pid in them are nobody's.
    log(
      `not releasing ${lockFile}: its bytes are no longer a lock payload ` +
        `(${holder.reason}), so it is not our hold and was left in place. ` +
        `The next run will judge it STALE — an unattributable lock cannot be ` +
        `honoured — and break it.`,
    );
    return;
  }

  if (holder.owner !== ours) {
    log(
      `not releasing ${lockFile}: it now carries the hold of PID ` +
        `${holder.pid} (owner ${holder.owner || "unrecorded"}), not ours. ` +
        `Ours must have been broken as stale.`,
    );
    return;
  }

  try {
    // A hair of TOCTOU survives between the read above and this unlink, and
    // it cannot be closed without a file handle held open across the whole
    // run. It is only reachable if our lock was already broken as stale, and
    // it is orders of magnitude narrower than the window it replaces.
    fs.unlinkSync(lockFile);
  } catch (error) {
    // ENOENT again: already gone is the desired end state, so swallow it.
    if (error.code === "ENOENT") return;
    if (!isPathFault(error)) throw error;
    // Still ours, and the directory will not let this user remove it. The
    // hold names this pid, which is about to exit, so the next run finds its
    // holder gone and breaks it as stale — provided the path lets it unlink
    // by then; until then it refuses with the same errno.
    log(
      `could not release ${lockFile} (${error.code} on unlink): our hold is ` +
        `still on disk, naming PID ${process.pid}, which is about to exit. ` +
        `The next run will find that holder gone and break it as stale once ` +
        `the path lets it be unlinked; until then it will refuse it ` +
        `(exit ${EXIT_LOCK_PATH_UNUSABLE}).`,
    );
  }
}

/** Run the wrapped command, resolving to the code this process should exit with. */
function runChild(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    activeChild = child;
    child.once("error", (error) => {
      activeChild = null;
      reject(error);
    });
    child.once("close", (code, signal) => {
      activeChild = null;
      // A child killed by a signal has no exit code. Report it the way a
      // shell does so the number still carries the cause.
      if (signal) {
        resolve(128 + (osConstants.signals[signal] ?? 0));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

/**
 * Release the lock and then die of the signal, in that order.
 *
 * The order is the contract: after this returns to nobody, the lock is not
 * held and this process is not running. The alternative — releasing and then
 * returning to the caller — leaves the wrapper alive with the lock dropped,
 * free to spawn the build it was about to spawn, which is two holders by
 * another route.
 *
 * Re-raising rather than exiting is what preserves the disposition: a parent
 * shell, and this file's own runChild(), both read "killed by SIGINT" from the
 * wait status, not from an exit code that resembles one. Removing our handlers
 * first is what restores the default behaviour so the re-raise actually
 * terminates instead of re-entering this function.
 */
function releaseAndDie(lockFile, signal) {
  release(lockFile);
  for (const caught of CAUGHT_SIGNALS) process.removeAllListeners(caught);
  try {
    process.kill(process.pid, signal);
  } catch {
    // Ignore: the explicit exit below is the backstop.
  }
  // Reached only if the signal was blocked or ignored for us by whoever
  // started us. Terminating with the shell's number for it is still
  // terminating; carrying on is the one outcome that is not allowed.
  process.exit(128 + (osConstants.signals[signal] ?? 0));
}

/**
 * Keep Ctrl-C from arming the trap.
 *
 * With a child running, forward the signal: the child dies first, so the
 * normal close → finally → release path still executes and the hold covers
 * the builder for exactly as long as the builder exists. With no child to
 * forward to, release and die — see releaseAndDie, and the signals section of
 * the header. This cannot help against SIGKILL, which nothing can catch —
 * which is why the liveness check in acquire() is the real backstop and this
 * is only a courtesy.
 */
function installSignalHandlers(lockFile) {
  for (const signal of CAUGHT_SIGNALS) {
    process.on(signal, () => {
      if (activeChild) {
        activeChild.kill(signal);
        return;
      }
      releaseAndDie(lockFile, signal);
    });
  }
}

/** Local HH:MM, so the refusal reads at a glance. */
function heldSince(acquiredAt) {
  const when = new Date(acquiredAt);
  if (Number.isNaN(when.getTime())) return acquiredAt || "an unrecorded time";
  const hh = String(when.getHours()).padStart(2, "0");
  const mm = String(when.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * The one line said when a top-level run starts waiting. Printed once per
 * run, not once per poll, so a long wait does not bury the transcript.
 */
function reportWaiting(lockFile, holder, waitSeconds) {
  const who = holder
    ? `held by PID ${holder.pid} since ${heldSince(holder.acquiredAt)} ` +
      `(running: ${holder.command})`
    : "re-taken while we were breaking a stale one";
  log(
    `lock ${lockFile} is ${who}; waiting up to ${waitSeconds}s for it to ` +
      `free (${WAIT_ENV}=${waitSeconds}).`,
  );
}

/**
 * Acquire, waiting up to `waitSeconds` for a live holder to let go.
 *
 * Every attempt is the ordinary acquire(), so stale breaking and the
 * unusable-path refusal behave exactly as without a wait; only the "held"
 * outcome is retried, and only until the deadline. With `waitSeconds` 0 this
 * is one acquire() and nothing else — the default path, unchanged.
 *
 * @returns {{ outcome: ReturnType<typeof acquire>, waitedFrom: number | null }}
 *   `waitedFrom` is the Date.now() at which waiting began, or null when the
 *   first attempt settled it.
 */
async function acquireWithin(lockFile, command, args, token, waitSeconds) {
  let outcome = acquire(lockFile, command, args, token);
  if (outcome.ok || outcome.unusable || waitSeconds === 0) {
    return { outcome, waitedFrom: null };
  }

  const waitedFrom = Date.now();
  const deadline = waitedFrom + waitSeconds * 1000;
  reportWaiting(lockFile, outcome.holder, waitSeconds);
  let pause = WAIT_BACKOFF_START_MS;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pause, remaining));
    pause = Math.min(pause * 2, WAIT_BACKOFF_MAX_MS);
    outcome = acquire(lockFile, command, args, token);
    if (outcome.ok || outcome.unusable) break;
  }
  return { outcome, waitedFrom };
}

/**
 * @param {string | null} [waited] null on the default path, whose lines are
 *   the contract and stay byte for byte; otherwise the wait that ran out,
 *   said INSTEAD of "Nothing waits by design", which would then be untrue.
 */
function reportRefusal(lockFile, holder, waited = null) {
  if (holder) {
    log(
      `REFUSED — lock held by PID ${holder.pid} since ` +
        `${heldSince(holder.acquiredAt)}.`,
    );
    log(`  it is running: ${holder.command}`);
  } else {
    log("REFUSED — the lock was re-taken while we were breaking a stale one.");
  }
  log(`  lock file: ${lockFile}`);
  // The second clause claims only what is true: 75 is distinct from the codes
  // this wrapper's OWN failures use, not from anything a wrapped `npm run …`
  // could return — see "75 and 78 are not reserved" in the header (delegated
  // decision 2026-09-23, TODO "Three owner calls surfaced by Lane H" (i)(a)).
  log(
    `The command did NOT run. Exiting ${EXIT_LOCK_HELD} (lock held, nothing ` +
      `started) — distinct from the codes this wrapper's own failures use.`,
  );
  if (waited === null) {
    log("Nothing waits by design; re-run once the other job finishes.");
  } else {
    log(`${waited} Re-run once the other job finishes.`);
  }
}

/**
 * Said INSTEAD of a hold when the lock path itself will not serve as a lock,
 * naming the step that failed and the errno the OS gave for it.
 *
 * "read": the path's bytes cannot be read, so nothing about the hold is known
 * — not its holder, not its liveness, not whether an unlink would remove the
 * hold that was judged. Said instead of a break, and never with "breaking
 * STALE": no break is attempted, and a transcript must not claim one to a
 * reader who cannot check. "create": no lock could be created there (its
 * directory missing or unwritable, link() forbidden). "unlink": a lock proved
 * stale there could not be removed — the "NOT broken" line above this one has
 * already withdrawn the announced break. In every case the path was left
 * exactly as found and the operator is told what to fix.
 */
function reportUnusable(lockFile, { op, code }) {
  if (op === "read") {
    log(
      `REFUSED — the lock path cannot be read (${code}), so nothing about the ` +
        `hold there can be established: not its holder, not its liveness, not ` +
        `whether it would still be the same hold at the instant of an unlink.`,
    );
  } else if (op === "create") {
    log(
      `REFUSED — no lock can be created at the lock path (${code}), so no ` +
        `hold was taken.`,
    );
  } else {
    log(
      `REFUSED — the lock at the lock path was proved stale but cannot be ` +
        `removed (${code}), so no hold could be taken over it.`,
    );
  }
  log(`  lock file: ${lockFile}`);
  log(
    `  it was left exactly as found. The lock path must be a regular file ` +
      `or absent, in a directory this user can write to — fix ` +
      `${LOCK_PATH_ENV}, or the permissions at that path.`,
  );
  log(
    `The command did NOT run. Exiting ${EXIT_LOCK_PATH_UNUSABLE} (lock path ` +
      `unusable, nothing started) — not ${EXIT_LOCK_HELD}: that code means ` +
      `"retry later", and nothing about this path says a retry would help.`,
  );
}

async function main(argv) {
  const [command, ...args] = argv;
  if (!command) {
    log("usage: node scripts/build-lock.mjs <command> [args...]");
    log("  wraps <command> in the workspace build/test lock; see the header.");
    process.exitCode = EXIT_USAGE;
    return;
  }

  const waitSeconds = resolveWaitSeconds();
  if (waitSeconds === null) {
    log(
      `usage: ${WAIT_ENV} must be a whole number of seconds from 0 to ` +
        `${MAX_WAIT_SECONDS}; got ${JSON.stringify(process.env[WAIT_ENV])}.`,
    );
    log("  no lock was taken and the command did NOT run; see the header.");
    process.exitCode = EXIT_USAGE;
    return;
  }

  const lockFile = resolveLockFile();

  // Installed BEFORE the acquire, so that from the first instant the lock file
  // can exist there is already a handler able to take it away again. A signal
  // arriving before this point kills us with the default disposition and
  // leaves nothing behind but, at worst, a temp file.
  installSignalHandlers(lockFile);

  // Re-entrancy is decided BEFORE acquiring, and it is the only branch that
  // may skip the acquire. See inheritedHold() for why it is three checks.
  const inside = inheritedHold(lockFile, process.env);
  let token;

  if (inside) {
    // Announced, not silent. A pass-through is the one event here that can be
    // wrong without anything failing, so it is never allowed to be invisible:
    // if the workspace is unlocked because this line printed twenty times
    // without a matching acquire, the operator can see that in the transcript.
    log(
      `re-entrant — already inside the hold of PID ${inside.pid}; ` +
        `running without acquiring.`,
    );
    token = inside.owner;
  } else {
    token = mintToken();
    // Only a top-level run may wait. An inherited token here means this run
    // is inside a wrapped tree whose hold the file no longer carries (or it
    // would have passed through above) — that tree lost its hold, and the
    // inner step must stop now rather than queue behind the new holder; see
    // "Opt-in bounded wait" in the header.
    const nested =
      typeof process.env[OWNER_ENV] === "string" &&
      process.env[OWNER_ENV].trim() !== "";
    const { outcome, waitedFrom } = await acquireWithin(
      lockFile,
      command,
      args,
      token,
      nested ? 0 : waitSeconds,
    );
    if (outcome.ok && waitedFrom !== null) {
      log(`acquired after waiting ${secondsSince(waitedFrom)}s.`);
    }
    if (!outcome.ok) {
      // Two refusals, two codes. "Held" is temporary and a retry is the
      // remedy; "unusable" is the path itself — unreadable, uncreatable or
      // unremovable — and nothing about it says a retry would help: the path
      // or its permissions are what to fix.
      if (outcome.unusable) {
        reportUnusable(lockFile, outcome.unusable);
        process.exitCode = EXIT_LOCK_PATH_UNUSABLE;
        return;
      }
      reportRefusal(
        lockFile,
        outcome.holder,
        waitedFrom === null
          ? null
          : `Waited ${secondsSince(waitedFrom)}s (${WAIT_ENV}=${waitSeconds}) ` +
              `and the lock was not freed in time.`,
      );
      if (waitedFrom === null && nested && waitSeconds > 0) {
        log(
          `  ${WAIT_ENV}=${waitSeconds} was NOT honoured: this run inherited ` +
            `${OWNER_ENV}, so it is nested inside a tree whose hold is gone, ` +
            `and a nested run never waits.`,
        );
      }
      process.exitCode = EXIT_LOCK_HELD;
      return;
    }
    // Belt and braces: `finally` covers the normal and thrown paths, the exit
    // handler covers every path that leaves without unwinding. Both funnel
    // into the same ownership-checked release, which is idempotent. Only the
    // process that acquired registers it — a re-entrant run must never remove
    // a lock it did not take, and the null `heldToken` already guarantees
    // that on its own.
    process.on("exit", () => release(lockFile));
  }

  // The resolved ABSOLUTE path goes down with the token. TESSERA_BUILD_LOCK
  // may be set to a relative path, and a child running in packages/<x> would
  // resolve that against a different cwd — pointing the re-entrancy check at a
  // file that is not the one we hold, which would refuse the whole subtree.
  const childEnv = {
    ...process.env,
    [LOCK_PATH_ENV]: lockFile,
    [OWNER_ENV]: token,
  };

  try {
    process.exitCode = await runChild(command, args, childEnv);
  } catch (error) {
    log(`could not run \`${command}\`: ${error.message}`);
    process.exitCode = EXIT_SPAWN_FAILED;
  } finally {
    release(lockFile);
  }
}

/**
 * True unless this module was PROVABLY imported rather than executed.
 *
 * Asymmetric on purpose. A false "imported" is catastrophic and silent: every
 * wrapped build in the workspace would exit 0 without running or locking
 * anything. A false "entry point" is loud and harmless — main() with no
 * arguments prints usage and sets 64. So every ambiguity (no argv[1], an
 * unresolvable path) resolves to running.
 */
function invokedAsEntryPoint() {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry === "") return true;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(SELF_PATH);
  } catch {
    return path.resolve(entry) === SELF_PATH;
  }
}

if (invokedAsEntryPoint()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    log(`unexpected failure — ${error?.stack ?? String(error)}`);
    process.exitCode = EXIT_INTERNAL;
  }
}

// Exported for scripts/build-lock.test.js only. The suite drives the entry
// point as a child process wherever it can; these exist for the one state the
// entry point cannot be steered into from outside — holding the lock with no
// child running, which is where the signal contract is decided. These three
// are what the suite's signal helper builds that state from, and it is their
// only consumer. holderLiveness and processStartSignature are exported for the
// one branch no entry-point run on a non-Linux box can reach — the /proc read —
// which the suite drives through their optional `probe` parameter against a
// fake proc tree. Nothing else in this file is exported.
export {
  acquire,
  holderLiveness,
  installSignalHandlers,
  mintToken,
  processStartSignature,
};
