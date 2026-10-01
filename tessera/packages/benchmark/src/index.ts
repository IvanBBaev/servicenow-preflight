// @tessera/benchmark — DESIGN §13.1 OutcomeGate and §13.4 substrate harness.
//
// Scores a HAND-AUTHORED mutant catalog on 95% Wilson bounds (kill-rate lower
// bound, false-green upper bound, two disjoint denominators, worst-of-k per
// target) and drives it through injected pipeline + substrate ports. Nothing
// here contacts an instance and nothing here authors mutants: there is no
// default catalog, and a live substrate adapter is a separate follow-up.
//
// Delegated decisions 2026-09-23 (the design leaves these open; each takes the
// fail-closed option):
//  1. void vs miss: SUB-1/2/3/5 failures, the drift smoke-test and any
//     inconclusive or rejected run are VOID (§13.1/§13.4 wording), not a miss
//     — even though §13.2's Spike-5 row lists "substrate controls" among the
//     miss conditions. A void still reads `descope` and carries no rates; its
//     SpikeFinding outcome is `open`, so §13.3's "unmeasured ⇒ STOP" applies.
//     An unpinned generation config, composition, repetitions and
//     determinism are MISS (§13.2).
//  2. Per-category floor above 5 authored: ceil(authored × 3/5), never below 3.
//  3. Caught-set drift: |union − intersection| over all reps, not pairwise.
//  4. A policy weaker than DESIGN on ANY axis is refused (GatePolicyError);
//     M is held to max(35, ceil(z²(1−t)/t)) at the policy's own t and z.
//  5. Run colour: green = every row `pass` (an EMPTY suite is green, i.e.
//     vacuous); red = ≥1 `fail` and nothing else; error / skipped /
//     waiting-timeout / flaky / missing voids the run.
//  6. The suite is generated once per rep from the CORRECT source; that same
//     suite runs against correct and faulty source.
//  7. Catalog: expectedVerdict must be "red"; one mutant per artifact×
//     behaviour target; mutant and baseline targets, ids and diff hashes are
//     disjoint; a recorded diffSha256 that does not match refuses the catalog;
//     sign-offs are provenance and stay out of mutantSetHash.
//  8. `fixture: true` catalogs force the S5 finding to `open`.
//  9. Any other stage-port fault while driving is VOID (infrastructure), and
//     the runner lease is always released; a failed release is a warning.
//
// Delegated decisions 2026-09-23, continued (the instance `BenchmarkSubstrate`
// adapter, `substrate.ts` — see that file for the full reasoning behind each):
//  10. `applySource`/the lease/join-probe writes never call
//      `assertTableWritable`/`assertTableAllowed` themselves — those already
//      run at `@tessera/sn-client`'s transport for every Table API write, the
//      same reliance `@tessera/teststore-atf`'s `createSnTestStoreClient`
//      takes.
//  11. `fieldString`'s `{value, display_value}` reference-field unwrap is
//      vendored from `@tessera/teststore-atf/src/client.ts` rather than
//      imported — four lines duplicated is a lighter coupling than a runtime
//      dependency between sibling adapter packages for them.
//  12. `applySource`'s table→scriptField index is re-derived locally from
//      `@tessera/sn-client`'s `scriptsApi.SCRIPT_TYPES` (the same source
//      `@tessera/parity`'s `SCRIPT_FIELDS_BY_TABLE` builds from), not a new
//      dependency on `@tessera/parity`.
//  13. A table with more than one script field (only `sys_ui_policy`'s
//      `script_true`/`script_false`) is narrowed to the first field only —
//      under-supporting a multi-field artifact rather than guessing across
//      an unrelated second field.
//  14. `CatalogMutant`/`CatalogBaseline`'s `diff` is, by `catalog.ts`'s own
//      doc comment, in whatever form the substrate's applier understands; the
//      instance adapter adopts the SAME `"replace:<full source>"` convention
//      the test fixture (`test/fixtures/fake-substrate.js`) already uses,
//      rather than applying a real unified diff to unknown live-instance text.
//  15. `applySource({kind:"correct"})` carries no diff payload, and
//      `resetScope` only restores artifacts it already knows about — so the
//      FIRST time an artifact is touched, the live adapter captures whatever
//      is currently on the instance as "correct" and writes it back
//      (capture-on-first-touch), rather than trusting `resetScope` alone or
//      guessing a correct source itself. The benchmark scope is expected to
//      already carry the catalog's correct source before a run starts.
//  16. SUB-3's attribution-join check is a write-then-read round trip against
//      the SAME lease table SUB-2 uses, with a throwaway `join-probe:<uuid>`
//      marker — proving a value this adapter writes survives unaltered,
//      rather than adding a second table for one check. It runs before SUB-2
//      takes the lease (harness ordering), so it shares SUB-2's lease-table
//      race window.
//  17. SUB-2's lease is fail-closed with NO stale eviction, exactly as asked:
//      a plain Table API has no compare-and-swap, so check-then-insert has a
//      residual, accepted TOCTOU race, narrowed (not closed) by re-reading
//      after insert and backing off if a second row appears. It is a
//      single-operator convenience lock, not distributed consensus.
//  18. SUB-5's `resetScope` restores exactly the artifacts THIS run has
//      applied a variant to (a captured-source cache), not a whole-instance
//      rewind like the fixture's `instance.reset()` — a real instance has no
//      equivalent of that, so "the benchmark scope" is defined as the
//      touched-artifact set. The lease row is never a captured target.
//  19. The platform stamp tries `glide.buildname` then falls back to
//      `glide.war`; neither readable throws rather than returning an empty or
//      synthesised version string.
//  20. `smokeBaseline` cannot evaluate server-side script the way the
//      fixture's `node:vm` eval does (that needs a runner, not a substrate
//      port), so it is narrowed to a text-identity check: the live artifact's
//      current source equal to its OWN detonator's replacement text is `red`
//      (an artifact left sitting broken between runs); anything else is
//      `green`. A narrower drift check than the fixture's behavioural one —
//      documented, not silently downgraded.
//
// Delegated decisions 2026-09-24 (review fixes; each takes the fail-closed
// option):
//  21. Once any source was applied (a partial apply counts), `runBenchmark`
//      calls `resetScope("<runId>:final")` after the scored runs — on every
//      path, go / miss / void / abort — and BEFORE releasing the lease, so no
//      baseline detonator or mutant is left live for the next run (which
//      would otherwise void forever on drift, or capture the mutant as
//      "correct" and score a real catch as a miss). A run that voided before
//      touching any source (e.g. drift smoke red) does no final reset.
//  22. A failed final restore is always a warning. On a GO it also turns the
//      run VOID (`scope-reset-failed`) — a GO that left its substrate dirty is
//      not a clean result. A miss or a void keeps its status: re-labelling a
//      miss as a void would make it MORE permissive (open instead of
//      descope), so only the warning is added.
//  23. A `store.teardown` rejection while another fault is already
//      propagating is appended to `warnings` and the original fault (e.g. a
//      VoidRun reason) wins; with no fault in flight a teardown rejection
//      still voids the run as an infrastructure fault, as before.
//  24. SUB-2 never leaks its own lease row: a failed insert (including one
//      the server applied but answered without a sys_id, or any transport
//      failure that may have applied it) triggers a best-effort
//      query-and-delete of rows held by exactly this runId; a fault after a
//      successful insert (race-check read) deletes the inserted row. The
//      original fault is rethrown; if the cleanup also fails the rethrown
//      fault says a lease row may be left behind.
//  25. SUB-3 join-probe rows can never lock SUB-2 out, from both sides: the
//      lease reads query `holderNOT LIKEjoin-probe:^ORholderISEMPTY` AND
//      re-filter `join-probe:` holders client-side (so no `sysparm_limit`,
//      which could let a probe row hide a real holder); and a probe row whose
//      cleanup fails makes SUB-3 report `ok: false` instead of being
//      swallowed. A holder-less row stays counted as held (fail-closed).
//  26. The S5 evidence lines print the interval's own confidence (e.g. "99%
//      Wilson" under a stricter policy) instead of a hardcoded "95%";
//      `S5_QUESTION` still quotes SPIKE-FINDINGS.md verbatim.
//
// Delegated decisions 2026-09-26 (review-w7a F4/F5; each fail-closed — see
// `journal.ts`/`substrate.ts` for the full reasoning):
//  27. Durable restore journal: the live substrate REQUIRES a
//      `RestoreJournal` and records each artifact's correct source (table,
//      sys_id, field, sha256, source) durably BEFORE its first PATCH. The
//      file journal's first write is an exclusive create (an existing journal
//      is never overwritten); later writes replace it atomically. It is
//      cleared only after a VERIFIED final restore.
//  28. Capture refusal: the harness binds its catalog to the substrate
//      (`bindCatalog`) before anything is read; a capture with no catalog
//      bound is refused, and a live text equal to ANY catalog mutant or
//      detonator text is refused (never adopted as "correct"). An optional
//      catalog `correctSha256` (per artifact; conflicting pins refuse the
//      catalog; hashed into mutantSetHash only when present) makes any other
//      live text a refusal too. The drift smoke-test also reads any catalog
//      broken text as red.
//  29. `resetScope` attempts every artifact and throws one aggregate error.
//      The final restore (`restoreFinal`) patches, re-reads to verify, and
//      retries only what is still pending (3 attempts, 250 ms / 1 s backoff).
//      Anything still unrestored keeps the journal and is named, with the
//      journal path and `tess benchmark --restore <runId>`, in the error the
//      harness turns into a warning (and a void on a GO).
//  30. `restoreFromJournal` (the `--restore` path) removes the journal and
//      the crashed run's OWN lease rows (holder === its runId) only after
//      every entry is verified restored; otherwise both are kept.

export {
  CATALOG_SCHEMA,
  CatalogError,
  computeMutantSetHash,
  loadCatalog,
  readCatalogFile,
} from "./catalog.js";
export type {
  BaselineEntry,
  BenchmarkCatalog,
  CatalogBaseline,
  CatalogMutant,
  DetonatorEntry,
  MutantEntry,
  SignOff,
} from "./catalog.js";
export {
  S5_QUESTION,
  formatS5Record,
  toS5Record,
  toSpikeFinding,
} from "./finding.js";
export type { S5Record, SpikeFinding, SpikeOutcome } from "./finding.js";
export {
  DESIGN_GATE_POLICY,
  GatePolicyError,
  MUTANT_CATEGORIES,
  assertPolicyAtLeastDesign,
  caughtSetDrift,
  collapseCaught,
  collapseVacuous,
  isMutantCategory,
  perCategoryCatchFloor,
  scoreOutcomeGate,
} from "./gate.js";
export type {
  BaselineObservation,
  CategoryScore,
  DeterminismScore,
  GateReason,
  MissReasonCode,
  MutantCategory,
  MutantObservation,
  OutcomeGateInput,
  OutcomeGateMeasurement,
  OutcomeGatePolicy,
  OutcomeGateResult,
  VoidReasonCode,
} from "./gate.js";
export { colourOf, runBenchmark } from "./harness.js";
export {
  RESTORE_JOURNAL_FILENAME,
  RESTORE_JOURNAL_SCHEMA,
  RestoreJournalError,
  clearRestoreJournalFile,
  createFileRestoreJournal,
  createMemoryRestoreJournal,
  findRestoreJournals,
  journalWriterLiveness,
  readRestoreJournal,
  restoreJournalPath,
} from "./journal.js";
export type {
  FileRestoreJournalOptions,
  FoundRestoreJournal,
  JournalWriterLiveness,
  RestoreJournal,
  RestoreJournalDocument,
  RestoreJournalEntry,
} from "./journal.js";
export type {
  BenchmarkPipeline,
  BenchmarkRunOptions,
  BenchmarkRunRecord,
  BenchmarkSubstrate,
  RunnerLease,
  SourceVariant,
  SubstrateCheck,
} from "./harness.js";
export {
  StaleResultError,
  assertResultKeyMatches,
  compareResultKey,
  pinnedGenConfigProblems,
  resultKeyHash,
} from "./key.js";
export type {
  PinnedGenConfig,
  ResultKey,
  ResultKeyComparison,
  ResultKeyField,
} from "./key.js";
export {
  DEFAULT_LEASE_TABLE,
  assertBenchmarkTableApiPath,
  createInstanceBenchmarkSubstrate,
  createSnBenchmarkClient,
  restoreFromJournal,
  toSubstrateFault,
} from "./substrate.js";
export { BenchmarkSubstrateError } from "./substrate.js";
export type {
  BenchmarkHttpClient,
  BenchmarkHttpRequest,
  BenchmarkHttpResponse,
  BenchmarkSubstrateFaultOptions,
  InstanceBenchmarkSubstrateOptions,
  RestoreFromJournalOptions,
  RestoreFromJournalResult,
  RestoreLeaseOutcome,
  UnrestoredArtifact,
} from "./substrate.js";
export {
  minTrialsForZeroEventUpperBound,
  wilsonInterval,
  zForConfidence,
} from "./wilson.js";
export type { WilsonInterval } from "./wilson.js";
