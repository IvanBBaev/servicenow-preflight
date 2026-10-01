// @tessera/ledger — record shapes for the run-lifecycle state machine and the
// write-ahead intent ledger (DESIGN §4b). Pure data; every byte of I/O lives in
// durability.ts / ledger.ts.

import type { RunId, RunLifecycle } from "@tessera/types";

export type { RunId };

/**
 * §4a's three modes. §4b's `RunStateRecord` is written for a run in ANY of
 * them — including the `repo-only` run that short-circuits `planned → done`
 * without a single ledger entry — so it is the wide union, not `Lifecycle`.
 * Re-exported because the ledger's own record types are built on it.
 */
export type { RunLifecycle };

/** The §4b run state machine, verbatim — no second enumeration exists (ARCH-38/DEV-30/QA-24). */
export const RUN_STATES = [
  "planned", // reads done (resolve→impact→generate, ARCH-19); no writes yet
  "provisioning", // verify standing infra + apply run-scoped fabricated state (ARCH-33)
  "projecting", // TestStore projection in flight
  "running", // runner triggered; bounded polling (DEV-2)
  "collecting", // results read + persisted BEFORE any deletion (DEV-13)
  "tearing-down", // compensation replay in progress
  "done", // terminal: ledger fully applied/compensated per lifecycle mode
  "failed", // terminal: non-compensated entries remain; cleanup prescribed
  "abandoned", // terminal: instance run never reached terminal state (ARCH-32/DEV-25/QA-23)
] as const;

export type RunState = (typeof RUN_STATES)[number];

/**
 * A run is a persisted record, not an in-memory flag (§4b): a dead process must
 * be diagnosable by reading the run-state store alone.
 */
export interface RunStateRecord {
  runId: RunId;
  state: RunState;
  scope: string;
  /** §2a role the writes bind to (ARCH-8). */
  runner: string;
  lifecycle: RunLifecycle;
  /** ISO 8601. */
  startedAt: string;
  /** ISO 8601 — freshness input to the abandonment TTL. */
  updatedAt: string;
  /** Local diagnosis aid only — not a liveness proof (§4b). */
  pid?: number;
  /**
   * ISO 8601 — when the run FIRST entered `running`, the only state that can
   * trigger an instance-side execution. Write-once: set by `transition` on
   * the edge into `running`, never cleared, carried unchanged across every
   * later transition (`collecting`, `failed`, a cleanup's `tearing-down`…).
   *
   * Delegated decision 2026-09-25: run.json otherwise keeps no history, so a
   * `failed` record could not tell `tess cleanup` whether a trigger may have
   * happened, and the ATF store's DEV-17 zero-result gate refused such runs
   * forever. Its ABSENCE proves "never ran" only together with
   * {@link RunStateRecord.tracksRunning} — see `neverReachedRunning`.
   */
  runningAt?: string;
  /**
   * Stamped `true` by `openRun` on every record written by a ledger that
   * maintains {@link RunStateRecord.runningAt}. A legacy record (written
   * before the field existed) lacks it, and a missing `runningAt` on such a
   * record proves nothing — readers must fail closed.
   */
  tracksRunning?: true;
}

export type LedgerEntryState = "intended" | "applied" | "compensated";

/**
 * How a write is undone. `op: "none"` must carry a justification — an
 * uncompensatable write is a decision, never an omission (§4b).
 *
 * §4b types `delete.sysId` as required; at *intend* time a create has no sys_id
 * yet, which is precisely the gap the W2 probe descriptor closes. It is therefore
 * optional here and filled at confirm (or by recovery's probe).
 */
export type CompensationOp =
  | { op: "delete"; table: string; sysId?: string } // undo a create
  | {
      op: "restore";
      table: string;
      sysId: string;
      fields: Record<string, unknown>;
    } // undo an update
  | { op: "none"; reason: string };

/**
 * QA-25: the concrete query that finds a created record when its `sys_id` was
 * never confirmed (crash window W2). A create whose probe cannot be expressed is
 * refused at intend time rather than written blind.
 */
export interface ProbeDescriptor {
  table: string;
  /** Encoded query, e.g. `nameSTARTSWITHtess-<runId>` or `test_suite=<sysId>`. */
  query: string;
  /**
   * Which key shape the query uses — recovery disposition reads differently per
   * shape: run-id prefixes only exist on tagged ephemeral tables, tagless m2m
   * link rows are parent-keyed, and persistent upserts probe the natural key.
   */
  key: "run-id-prefix" | "parent-keyed" | "natural-key";
}

/** The §4b intent record — one per instance write, flushed before the write. */
export interface LedgerEntry {
  /** Monotonic per run — reverse order is teardown order (DEV-13/ARCH-37). */
  seq: number;
  /** §4a namespacing; joins `RunStateRecord` (ARCH-16). */
  runId: RunId;
  /** Runner role only — writes never target source/target (ARCH-8). */
  instance: string;
  /** e.g. "project sys_atf_test", "create temp user". */
  intent: string;
  /** `sysId` is filled at confirm for creates. */
  target: { table: string; sysId?: string };
  compensation: CompensationOp;
  state: LedgerEntryState;
  /** Dedupes MCP host retries (§4b concurrency). */
  idempotencyKey: string;
  /** Required for creates whose `sys_id` is unknown at intend time (QA-25). */
  probe?: ProbeDescriptor;
}

/** The run-scoped write record — the only kind that Phase 0.5 writes. */
export type LedgerWriteRecord = { kind: "write" } & LedgerEntry;

/**
 * §6b `preflight_apply` standing-infra write (ARCH-33): keyed on the plan hash,
 * no `runId`, no `RunStateRecord` join, compensatable on its own namespace.
 *
 * Emitted by `createInfraLedger` (infra.ts) into the per-instance namespace
 * `<root>/infra/<host>/ledger.jsonl` — delegated decision 2026-09-23, which
 * closes the ARCH-8 residual ("multi-instance ledger-store ownership") for
 * standing infra: one namespace per instance host. It is deliberately NOT
 * folded into the run ledger: a record with no `runId` has no run directory to
 * live in, and inventing a pseudo-run id would make it sweepable by run.
 *
 * The fields after `state` were added when the record gained a writer; the
 * original five keep their meaning. It is the infra twin of `LedgerEntry` with
 * `planHash` in the place of `runId` — a separate type on purpose, so
 * `LedgerAuditRecord.runId`/`LedgerEntry.runId` never had to be loosened.
 */
export interface LedgerInfraWriteRecord {
  kind: "infra-write";
  planHash: string;
  target: { table: string; sysId?: string };
  compensation: CompensationOp;
  state: LedgerEntryState;
  /** Monotonic per host namespace — reverse order is teardown order. */
  seq: number;
  /** The namespace key: the instance host the write targets. */
  host: string;
  /** e.g. "create standing test user". */
  intent: string;
  /**
   * Dedupes retries ACROSS the whole host namespace — every plan, every
   * process, every reopen — not per run (delegated decision 2026-09-23).
   */
  idempotencyKey: string;
  /** Required for creates whose `sys_id` is unknown at intend time (QA-25). */
  probe?: ProbeDescriptor;
  /** ISO 8601 — when the intent was made durable. */
  intendedAt: string;
}

/**
 * Audit facts (§11.4, §6b): not instance writes, so they must never masquerade
 * as `LedgerEntry`s with fake compensations (ARCH-36/DEV-34). They are exempt
 * from compensation replay but bound by the same flush-before-effect ordering,
 * and per ARCH-43 they live in a retention-independent log that teardown and the
 * sweep never touch.
 *
 * The vocabulary is deliberately CLOSED. It once carried a third kind,
 * `nogo-override`, which named an event that cannot occur: NO_GO is
 * override-invariant by construction of the verdict ladder — the `allow-skipped`
 * override clears `blocking` only on `raw === "skipped"` rows, those rows resolve
 * to `status: "inconclusive"`, and the NO_GO rung tests
 * `blocking && status === "fail"`. So no override can ever turn a NO_GO into
 * anything else. A test produced the record until 2026-08-30 — `ledger.test.js`
 * appended the kind and asserted it read back — but nothing in any `src/` ever
 * did. Three searches reported no producer at all; all three were the same
 * `grep` wrapper skipping that file over a NUL byte in an unrelated fixture.
 * Recorded rather than smoothed over: a reader who believes the searches were
 * sound will trust the next one.
 *
 * It was DELETED rather than renamed on purpose. A rename relabels a wrong
 * affordance and leaves it on offer; an implementer who finds nothing asks
 * instead of reaching for the nearest plausible kind.
 *
 * `allow-skipped` (delegated decision 2026-09-23, TODO~175): the real §6a
 * override now has its kind, and it arrived TOGETHER with its producer, as this
 * comment used to demand — `allowSkippedAuditInput`/`recordAllowSkipped` in
 * @tessera/core build the record from the verdict the override was accepted
 * into, so the kind is never one nothing writes. The CLI surface that calls
 * them when `--allow-skipped` is used is Lane B's.
 *
 * ── the vocabulary is written ONCE; everything below is derived from it ─────
 * This list is the whole vocabulary. `decodeAuditRecord`'s accept-list
 * (`AUDIT_KINDS`) and both record unions are generated from it, so the writer's
 * vocabulary and the reader's accept-list cannot disagree — there is no second
 * list to forget.
 *
 * That is worth the indirection because of what the second list cost. While the
 * two were independent literals, adding a kind to the unions alone type-checked,
 * `appendAudit` wrote it to disk verbatim, and the very next `readAudit()` threw
 * `corrupt`: a record the writer accepts and the reader refuses, with the whole
 * suite green. The realistic path there was never sabotage — it was an
 * implementer editing the union, where kinds obviously live, and never finding
 * the accept-list in another file.
 *
 * To add a kind: add it here, then add its payload to `AuditPayloads`. The
 * compiler refuses to let you do one without the other.
 */
const AUDIT_KIND_LITERALS = [
  "acknowledge-prod",
  "token-consumed",
  "allow-skipped",
] as const;

/** The closed audit vocabulary. */
export type LedgerAuditKind = (typeof AUDIT_KIND_LITERALS)[number];

/**
 * Identity on payload maps, but only for one that covers EVERY kind in the
 * vocabulary.
 *
 * MEASURED, so read this before leaning on it: a kind added to
 * `AUDIT_KIND_LITERALS` with no payload row does NOT need this constraint to be
 * caught. Weakening it to `Record<string, object>`, or making it the fully
 * vacuous `type PayloadsFor<M> = M`, builds clean and the whole suite stays
 * green; the missing row still fails, via TS2536 at `AuditPayloads[K]` in the
 * mapped types below. So what this buys is diagnostic quality — one error that
 * names the payload map, instead of four that name its consequences — not
 * detection. It is a signpost, not a wall.
 *
 * The wall is `ClosedVocabulary`. Do not read the two as the same kind of
 * thing: weakening THAT one is silent in the build and reopens the original
 * defect in full.
 */
type PayloadsFor<M extends Record<LedgerAuditKind, object>> = M;

/**
 * What makes each kind DIFFERENT. `kind`/`runId`/`at` are common to every audit
 * fact and are added by the unions below, so this map holds only the per-variant
 * fields — which is exactly why deriving the unions does not flatten them into
 * one bag of optional fields. Each variant keeps its own required fields and the
 * union stays properly discriminated on `kind`.
 */
/**
 * The instance the override covered — `host` is what the guard decided on, and
 * `name` is the config alias a reader will recognise. Both, because neither
 * alone identifies the machine to a reader six months later.
 */
export interface AuditInstanceRef {
  name: string;
  host: string;
}

/**
 * One piece of classification evidence, as journalled. Deliberately typed with
 * bare `string`s rather than the guard's `GuardSignalKind`/`GuardSignalEffect`
 * unions: the ledger is not the authority on the guard's vocabularies, and a
 * copy of them here would be exactly the second list this file spends a page
 * warning about — one that drifts into a writer emitting a kind this reader
 * then rejects as `corrupt`.
 *
 * What ties the two together instead is a compile-time conformance check where
 * both types are actually visible — `packages/phase05/src/guardAudit.ts` — which
 * fails the build if the guard's §11.4 record and this payload stop describing
 * the same set of fields.
 */
export interface AuditEvidenceSignal {
  kind: string;
  effect: string;
  detail: string;
}

/**
 * A spec the `allow-skipped` override flipped — `TestSpecRef`'s identity
 * fields, restated rather than imported for the same reason as
 * `AuditEvidenceSignal`: the ledger journals the fact, it does not own the
 * vocabulary.
 */
export interface AuditSpecRef {
  id: string;
  path: string;
}

type AuditPayloads = PayloadsFor<{
  /**
   * §11.4 — a human accepted a write against a prod-suspect runner.
   *
   * This carries the WHOLE §11.4 record: instance, role, class, evidence,
   * reason, actor, surface (`at` is common to every audit fact and is added by
   * the unions below). Every field is REQUIRED, and that is the point.
   *
   * Until 2026-08-31 this payload was `{ reason, actor }` and the other five
   * fields went to a sibling `guard-audit.jsonl` written by a second, unrelated
   * writer. The record that reached this log looked complete — `kind`, `runId`,
   * `at`, a reason and an actor is a plausible whole audit fact — so a reader
   * had no way to notice that most of the event was somewhere else. An audit
   * record is read when the run, the tree and its author are long gone, which
   * is precisely when "looks complete" cannot be checked against anything.
   *
   * So: one append carries the whole fact, and there is exactly ONE writer of
   * it (the guard's sink, via `appendAuditSync`). Do not make one of these
   * fields optional to make a caller's life easier — an optional field here is
   * the old defect with a smaller blast radius, not a smaller defect.
   */
  "acknowledge-prod": {
    reason: string;
    actor: string;
    instance: AuditInstanceRef;
    /** §2a role the override covered. Only ever `runner` today (§11.4). */
    role: string;
    /** §11.1 class at the moment of the override — only ever `prod-suspect`. */
    cls: string;
    /** Why the instance classified as it did — the operator's actual case. */
    evidence: readonly AuditEvidenceSignal[];
    /** Which surface passed the override: cli / config / mcp (§9.5). */
    surface: string;
  };
  /** §6b — the single-use confirmation token for a verdict was spent. */
  "token-consumed": { verdictHash: string };
  /**
   * §6a — an `allow-skipped` override was ACCEPTED into a verdict (delegated
   * decision 2026-09-23, TODO~175). Every field is required, for the reason
   * `acknowledge-prod` spells out above.
   *
   * What it can and cannot have done is fixed by the ladder: it clears
   * `blocking` on `raw === "skipped"` rows only, so it can lift INCONCLUSIVE to
   * GO and never touches NO_GO. `verdictStatus` records where the verdict
   * landed WITH the override applied, so a reader can tell "this override is
   * why the run went green" from "it was passed and changed nothing that
   * mattered" without re-running the reducer.
   */
  "allow-skipped": {
    /** Who passed the flag (CLI user / MCP client id) — `OverrideRecord.actor`. */
    actor: string;
    /** Which surface passed the override: cli / config / mcp (§9.5). */
    surface: string;
    /**
     * Rows the override flipped, as the reducer RECOMPUTED them — never the
     * caller's count. Always equals `specs.length`; both sides check it.
     */
    affectedRows: number;
    /** The flipped rows' specs, in the verdict's deterministic row order. */
    specs: readonly AuditSpecRef[];
    /** The §6a status the verdict resolved to with the override applied. */
    verdictStatus: string;
  };
}>;

export type LedgerAuditRecord = {
  [K in LedgerAuditKind]: {
    kind: K;
    runId: RunId;
    at: string;
  } & AuditPayloads[K];
}[LedgerAuditKind];

/** `at` is stamped from the injected clock when the caller omits it. */
export type LedgerAuditInput = {
  [K in LedgerAuditKind]: {
    kind: K;
    runId: RunId;
    at?: string;
  } & AuditPayloads[K];
}[LedgerAuditKind];

/**
 * `readonly K[]`, but only for a `K` that stays inside the vocabulary.
 *
 * This is the backstop for the one drift the derivation above cannot prevent:
 * nothing physically stops someone appending a hand-written `| { kind: "…" }`
 * variant next to the generated union. Do that and `RecordKind` grows past
 * `LedgerAuditKind`, which is TS2344 — so the appended variant fails the build
 * instead of becoming a kind the writer emits and the reader rejects.
 *
 * `InputKind extends RecordKind` extends the same guarantee to the input union,
 * and the element type is the kinds present in BOTH — so a listed kind that lost
 * one of its two variants is a build error too. All three checks are load
 * bearing; none of the parameters is decoration.
 *
 * That last sentence is measured, not asserted. Relax `RecordKind extends
 * LedgerAuditKind` to `RecordKind extends string` and append a hand-written
 * variant, and the workspace BUILDS CLEAN with all 2085 tests green — while
 * `appendAudit` accepts the new kind and writes it verbatim, and `readAudit()`
 * either throws `corrupt` or, when the stray record is the only one in the log,
 * returns `[]` and reports nothing at all. A silent empty read of an audit log
 * is the worst failure mode this package has. Nothing in the test suite would
 * tell you; this constraint is the only thing that does.
 */
type ClosedVocabulary<
  RecordKind extends LedgerAuditKind,
  InputKind extends RecordKind,
> = readonly Extract<RecordKind, InputKind>[];

/**
 * The reader's accept-list — `decodeAuditRecord` (records.ts) reads exactly
 * this, so the decoder can no longer hold a second copy of the vocabulary.
 */
export const AUDIT_KINDS: ClosedVocabulary<
  LedgerAuditRecord["kind"],
  LedgerAuditInput["kind"]
> = AUDIT_KIND_LITERALS;

/** The §4b discriminated union the store holds. */
export type LedgerRecord =
  LedgerWriteRecord | LedgerInfraWriteRecord | LedgerAuditRecord;

export interface OpenRunInput {
  runId: RunId;
  scope: string;
  /** §2a role the writes bind to (ARCH-8). */
  runner: string;
  lifecycle: RunLifecycle;
  /** Local diagnosis aid only — not a liveness proof (§4b). */
  pid?: number;
}

export interface IntendInput {
  runId: RunId;
  instance: string;
  intent: string;
  target: { table: string; sysId?: string };
  compensation: CompensationOp;
  idempotencyKey: string;
  probe?: ProbeDescriptor;
}

/** What recovery reconciles: "what we meant to do" vs "what actually landed" (§4b). */
export interface RecoveryPlan {
  run: RunStateRecord;
  /**
   * Entries still `intended` — the W1/W2 orphans. Recovery treats every one as
   * *possibly applied*: probe first (creates), then either
   * `compensate(runId, seq, { sysId })` for an ephemeral find, or
   * `confirm(runId, seq, { sysId })` to ADOPT a persistent-mode find (QA-25 —
   * adopting is what stops the next manifest upsert creating a duplicate).
   * For updates there is nothing to probe: replay the `restore` unconditionally.
   */
  orphans: readonly LedgerWriteRecord[];
  /** Entries known to have landed — compensate directly. */
  applied: readonly LedgerWriteRecord[];
  /**
   * `orphans` ∪ `applied` in reverse `seq` — DEV-13's pinned delete order by
   * construction, because the projector's write order is constrained to make
   * reverse-`seq` *be* that order (ARCH-37/DEV-31/QA-30).
   */
  teardownOrder: readonly LedgerWriteRecord[];
  /**
   * Disposition of a create the probe FINDS, per the run's lifecycle (QA-25):
   * an ephemeral find is compensate-deleted, a persistent find is adopted.
   *
   * SEAM (Phase 4): §4a resolves an *effective* lifecycle per `TestSpec`
   * (DEV-23), so a persistent-annotated spec inside an ephemeral run would
   * differ. Phase 0.5 has no per-spec annotations, so the run-level mode is the
   * whole answer; a per-entry override belongs on `LedgerEntry` when it lands.
   */
  orphanDisposition: "compensate" | "adopt";
}

/** One row of the §4b startup scan / `cleanup --sweep` candidate list. */
export interface RunScanEntry {
  run: RunStateRecord;
  /**
   * `updatedAt` age in ms at scan time, clamped at 0.
   *
   * `0` does not only mean "just touched". `scan` also reports 0 when
   * `Date.parse` cannot read `updatedAt` at all, and when `updatedAt` is
   * ahead of the clock. Nothing in this record separates the three.
   */
  ageMs: number;
  /**
   * Older than the caller's TTL — a sweep candidate. `false` when no TTL was
   * given, and `false` for every `ageMs` of 0 above, including the one where
   * the timestamp was unreadable: an unreadable `updatedAt` reads here as
   * "certainly fresh". That is the safe direction for something that deletes,
   * and it is still not an observation.
   */
  stale: boolean;
  /** Entries still `intended` (W1/W2 orphans). */
  orphanCount: number;
  /** Entries not yet `compensated` — what the startup scan warns about. */
  pendingCount: number;
}

export interface IntentLedgerOptions {
  /**
   * Injected ledger root. There is no default and no `process.env` read: two
   * ledgers must be able to coexist in one process, and tests drive real temp
   * directories.
   */
  rootDir: string;
  /** Injectable clock — defaults to the system clock. */
  now?: () => Date;
}

/**
 * The §4b contract. Phase 0.5's minimal form: the durable intend→confirm
 * protocol, the run-state record it joins, reconciliation reads that surface the
 * W1/W2 orphans, and the retention-independent audit log.
 */
export interface IntentLedger {
  // ── run lifecycle (§4b state machine) ──────────────────────────────────────

  /**
   * Create (or resolve) the run's persisted `RunStateRecord` in state `planned`.
   * Idempotent: re-issuing the same open — an MCP host retry — resolves to the
   * existing record rather than starting a duplicate run (§4b concurrency).
   * Re-opening the same id with different parameters is a conflict, not a retry.
   */
  openRun(input: OpenRunInput): Promise<RunStateRecord>;
  readRun(runId: RunId): Promise<RunStateRecord | undefined>;
  /** Every run in the store, ascending by run id. */
  listRuns(): Promise<RunStateRecord[]>;
  /**
   * Persist a state transition, refusing any edge the §4b table does not list.
   * Re-asserting the current state is a no-op so a replayed cleanup converges.
   * The ledger enforces the *shape* of the machine; the triggers (e.g. "runner
   * terminal only" for `running → collecting`, ARCH-32/QA-23) are the run
   * orchestrator's to prove.
   */
  transition(runId: RunId, to: RunState): Promise<RunStateRecord>;
  /**
   * Refresh `updatedAt` without changing state, so a long-running run is not
   * inferred stale by the sweep.
   *
   * SEAM (§8.6/ARCH-11): this is a *local* freshness marker only. The
   * instance-side liveness marker that makes cross-machine sweeps safe is an
   * open decision; §4b already requires the sweep to query instance-side run
   * state before deleting rather than trusting this timestamp.
   */
  touch(runId: RunId): Promise<RunStateRecord>;

  // ── write-ahead protocol (§4b, in order) ───────────────────────────────────

  /**
   * Step 1 — append `{state: "intended"}` and flush to durable storage BEFORE
   * the HTTP call leaves the process. For updates the caller supplies the
   * `restore` snapshot here, so compensation never depends on post-crash state.
   * Returns the existing entry unchanged when `idempotencyKey` was already used.
   */
  intend(input: IntendInput): Promise<LedgerWriteRecord>;
  /**
   * Step 3 — fill `target.sysId` (creates) and flip to `applied`. Also the
   * ADOPT path of W2 recovery for persistent mode (QA-25). Absorbing a repeat of
   * the identical confirm is a no-op; confirming a different `sys_id` is an
   * error, because that means two records were created.
   */
  confirm(
    runId: RunId,
    seq: number,
    result?: { sysId?: string },
  ): Promise<LedgerWriteRecord>;
  /**
   * Flip to `compensated` after the compensating write succeeded (or after the
   * probe proved there is nothing to compensate — W1). Compensating an already
   * `compensated` entry is a success, so `cleanup --run` twice is a no-op.
   */
  compensate(
    runId: RunId,
    seq: number,
    result?: { sysId?: string },
  ): Promise<LedgerWriteRecord>;

  // ── reconciliation ─────────────────────────────────────────────────────────

  /** The run's folded entries, ascending by `seq`. */
  entries(runId: RunId): Promise<LedgerWriteRecord[]>;
  /** Everything a teardown/cleanup pass needs to converge — see `RecoveryPlan`. */
  recover(runId: RunId): Promise<RecoveryPlan>;
  /**
   * The §4b startup scan: non-terminal runs and their non-`compensated` entries.
   * `ttlMs` marks sweep candidates; with no TTL nothing is reported stale,
   * because the TTL policy is the caller's (ARCH-11/§8.6 stays open).
   */
  scan(options?: { ttlMs?: number }): Promise<RunScanEntry[]>;

  // ── audit log (ARCH-43) ────────────────────────────────────────────────────

  /**
   * Append an audit fact. Stored outside the run directories precisely so run
   * teardown and `cleanup --sweep` cannot drop it — a `token-consumed` record
   * that dies with the run would make "single-use" a lie at the exact boundary
   * it protects (§6b).
   */
  appendAudit(record: LedgerAuditInput): Promise<LedgerAuditRecord>;
  /**
   * The same append, durable by the time it RETURNS rather than by the time a
   * promise settles — the sync-capable audit seam.
   *
   * It exists because the §11.4 `acknowledge-prod` producer cannot yield: the
   * guard journals an override from inside `assertWrite`/`assertRunnerWritable`,
   * which are synchronous by contract (guard §11.6) and refuse a write by
   * throwing. Handing that caller a promise would let the write proceed while
   * the record was still unwritten, so before this existed the producer wrote
   * the full record to a file of its own instead — and the ledger's own audit
   * log carried a two-field stub of the same event.
   *
   * `appendAudit` is a thin async wrapper over this, so the audit log has ONE
   * write path. Being synchronous is what makes that safe: a sync append cannot
   * interleave with a concurrent one, so there is no in-process lock to get
   * right and no window in which a repair could truncate a record another
   * caller was already told was durable.
   *
   * Throws exactly what `appendAudit` throws, synchronously rather than as a
   * rejection. That is a `LedgerError` for a refused input (`protocol`), and
   * the raw Node system error for a filesystem failure — this path wraps
   * nothing, so "not a `LedgerError`" must never be read as "the record was
   * written". A caller that cannot journal must be able to refuse.
   */
  appendAuditSync(record: LedgerAuditInput): LedgerAuditRecord;
  readAudit(): Promise<LedgerAuditRecord[]>;
}

// ── standing-infra namespace (delegated decision 2026-09-23) ─────────────────

export interface InfraLedgerOptions {
  /** The same injected root `createIntentLedger` takes — no default, no env read. */
  rootDir: string;
  /**
   * The instance host whose namespace this is, e.g.
   * `devNNNNNN.service-now.com`. It becomes a directory name, so it is
   * validated as one (`invalid-host`); a caller holding a URL passes its
   * hostname. No lower-casing happens here: two spellings of one host are two
   * namespaces, so normalize before calling.
   */
  host: string;
  /** Injectable clock — defaults to the system clock. */
  now?: () => Date;
  /**
   * How long an append waits for another process's lock on the namespace
   * before giving up with `lock-timeout`. Default 10 000 ms.
   */
  lockTimeoutMs?: number;
}

export interface InfraIntendInput {
  /** `computePlanHash` of the plan this write belongs to (@tessera/core). */
  planHash: string;
  intent: string;
  target: { table: string; sysId?: string };
  compensation: CompensationOp;
  /** Host-scoped: a key already used by ANY plan on this host is a duplicate. */
  idempotencyKey: string;
  probe?: ProbeDescriptor;
}

/**
 * The §4b write-ahead protocol over one instance's standing-infra namespace.
 * Same intend → write → confirm/compensate shape as `IntentLedger`, keyed on
 * `planHash` instead of a run.
 */
export interface InfraLedger {
  readonly host: string;
  /**
   * Step 1 — append `{state: "intended"}` durably, BEFORE the write leaves the
   * process. A reused `idempotencyKey` returns the existing entry unchanged —
   * across processes and reopen, because the dedupe reads the log under a
   * cross-process lock rather than an in-memory index. The same key under a
   * DIFFERENT `planHash` is refused (`protocol`): one key naming two writes
   * is a caller bug, and returning the other plan's entry would hide it.
   */
  intend(input: InfraIntendInput): Promise<LedgerInfraWriteRecord>;
  /** Step 3 — as `IntentLedger.confirm`, addressed by host-namespace `seq`. */
  confirm(
    seq: number,
    result?: { sysId?: string },
  ): Promise<LedgerInfraWriteRecord>;
  /** As `IntentLedger.compensate`; idempotent. */
  compensate(
    seq: number,
    result?: { sysId?: string },
  ): Promise<LedgerInfraWriteRecord>;
  /** Folded entries, ascending by `seq`; `planHash` narrows to one plan. */
  entries(filter?: { planHash?: string }): Promise<LedgerInfraWriteRecord[]>;
  /** The entry holding `idempotencyKey`, if any — a read-only dedupe probe. */
  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<LedgerInfraWriteRecord | undefined>;
}

// ── run-state persistence for `run_status` (DESIGN §6b / QA-29) ──────────────

/** One persisted run event, as a reader in ANY process sees it. */
export interface RunEvent {
  /**
   * Monotonic per run, starting at 1, gap-free, never reused — across
   * processes and reopen. A reader resumes with `readEvents(runId, cursor)`.
   */
  cursor: number;
  runId: RunId;
  /** Free-form event name, e.g. `state`, `stage`, `verdict`, `end`. */
  type: string;
  /** ISO 8601. */
  at: string;
  /** JSON payload; absent when the event carries none. */
  data?: unknown;
}

export interface RunEventInput {
  type: string;
  /** Must survive `JSON.stringify` → `JSON.parse` — refused (`protocol`) if not. */
  data?: unknown;
  /** Stamped from the injected clock when omitted. */
  at?: string;
}

export interface RunEventPage {
  /** Events with `cursor > since`, ascending. */
  events: RunEvent[];
  /**
   * The cursor to pass next time: the last returned event's, or `since`
   * unchanged when nothing new was committed.
   */
  cursor: number;
}

/** The run's final result, persisted by atomic replace (`result.json`). */
export interface PersistedRunResult {
  runId: RunId;
  /** ISO 8601. */
  at: string;
  /** JSON payload — for a pipeline run, its `PipelineRunReport`. */
  result: unknown;
}

/** What `run_status` answers from disk alone (§6b / QA-29). */
export interface RunStatusSnapshot {
  run: RunStateRecord;
  /** The last committed event's cursor; 0 when none was appended. */
  lastCursor: number;
  result?: PersistedRunResult;
}

export interface RunEventLogOptions {
  rootDir: string;
  now?: () => Date;
  /** As `InfraLedgerOptions.lockTimeoutMs`. Default 10 000 ms. */
  lockTimeoutMs?: number;
}

/**
 * The append-only per-run event log that makes a run observable from a new
 * process — `<root>/runs/<runId>/events.jsonl`, next to the §4b `run.json` and
 * `ledger.jsonl`. Every call requires the run's `RunStateRecord` to exist
 * (`run-not-found` otherwise): an event for a run the store does not know
 * would be status nobody can join to a state.
 */
export interface RunEventLog {
  appendEvent(runId: RunId, input: RunEventInput): Promise<RunEvent>;
  /** Events committed after `since` (default 0 = from the start). */
  readEvents(runId: RunId, since?: number): Promise<RunEventPage>;
  writeResult(runId: RunId, result: unknown): Promise<PersistedRunResult>;
  readResult(runId: RunId): Promise<PersistedRunResult | undefined>;
  /** State + cursor + result; `undefined` for a run the store does not know. */
  readStatus(runId: RunId): Promise<RunStatusSnapshot | undefined>;
}
