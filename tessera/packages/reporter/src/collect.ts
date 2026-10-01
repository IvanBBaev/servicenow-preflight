// The one place a `TestEvent` is turned into data the reporters may print
// (PLAN Phase 7). Every reporter in this package collects through here, so the
// console summary, the `--json` document and the JUnit report cannot disagree
// about what happened in a run — they disagree only about how to say it.
//
// Three rules shape the code more than anything else.
//
// First, `onEvent` runs inside core's `try { reporter.onEvent(event) } catch {}`
// (`runPipeline.ts`), whose comment is "a reporter fault is never allowed to
// change the verdict". A reporter that throws is therefore a reporter that
// silently loses evidence, not one that fails loudly. So `record` is
// synchronous, does no I/O, and treats every event as wire data: a malformed
// event is counted in `dropped` and skipped, never thrown on.
//
// Second, TM-1 — this stream carries strings that came off a ServiceNow
// instance (assertion text, ATF failure causes, script output). The projection
// functions below rebuild every object from its DECLARED fields; nothing is
// spread, copied by reference or `JSON.stringify`d wholesale. That is the
// guarantee the reporters rest on: an undeclared extra property on an event
// object has no path to any output surface, because no output surface ever
// sees the event object itself.
//
// Third, counts are DERIVED. `snapshot` recomputes them from the outcome array
// on every call and there is no field a caller could set instead, so the
// numbers in a report can never drift from the rows printed beside them.
//
// A note on coercion: where the union declares `string` and something else
// arrives, the field renders EMPTY rather than being `String()`-coerced.
// Coercion is how an object's `toString` reaches a CI log.
//
// Fourth, and added later: EVERY DEFENSIVE DECISION ABOVE IS ALSO A CAVEAT THE
// READER IS OWED. Dropping a malformed row, resolving an unknown outcome to
// `error`, accepting an `end` that omits a spec we saw `start` — each is the
// right call locally and each makes a number below smaller, larger or simply
// wrong in a way no consumer of that number can detect. So the count is not
// enough: every decision that MOVES ONE OF THE COUNTS exposes a field saying
// it did. There are six, and they are deliberately separate rather than one
// `dropped` tally, because they are not the same question:
//
//   dropped              whole EVENTS that were not a declared TestEvent
//   droppedOutcomeRows   rows inside a valid `end` that were not a SpecOutcome
//   coercedOutcomes      rows kept, but with a `raw` we replaced with `error`
//   startedWithoutOutcome  specs that emitted `start` and never appeared in the
//                          result — DEV-1 by deletion, and one of the two
//                          that can be nonzero while `ended` is true
//   faultedWithoutOutcome  specs that emitted `fail`/`error` and never appeared
//                          in the result — the other one (added 2026-09-25)
//   faultedContradictedByOutcome  specs that emitted `fail`/`error` and whose
//                          result row reads `pass` (added 2026-09-26)
//
// The distinction that matters downstream is that `droppedOutcomeRows` reduces
// `counts.total` and `dropped` does not: a lost row was going to be counted, a
// lost event was not. Rows change the denominator; events do not.
//
// WHAT IS NOT COUNTED. That sentence read "every place this file decides
// something on the stream's behalf exposes a field saying it did" until
// 2026-09-03, and the projections below have never been true of it:
//
//   * `projectArtifacts` drops an artifact ref whose `kind` is not in
//     `ARTIFACT_KINDS`, and `projectEvidence` drops the whole `EvidenceRef`
//     for the same reason. A short artifact list and an absent `evidence`
//     reach every reporter looking exactly like a row that captured nothing.
//   * `asText` renders a non-string as `""` (the coercion note above), so a
//     blank assertion, cause, ref or spec id means either "empty" or "not a
//     string", and `projectSpecRef` can hand back `{id: "", path: ""}`.
//
// None of them has a counter, so the claim is deliberately narrowed to the
// six rather than left standing over code that does not honour it. Giving
// them one widens `CollectedRun` and the `--json` document's fixed key set,
// which is an owner's call; what is in this file's gift is not to advertise a
// field that does not exist.

import { specKey } from "@tessera/core";
import { RAW_OUTCOMES } from "@tessera/types";
import type {
  ArtifactRef,
  EvidenceRef,
  RawOutcome,
  RunId,
  SpecOutcome,
  TestEvent,
  TestSpecRef,
} from "@tessera/types";

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<string>(RAW_OUTCOMES);

/** `ArtifactRef["kind"]` has no runtime companion in @tessera/types; this is it. */
const ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  "screenshot",
  "trace",
  "log",
  "atf-result",
  "file",
]);

/** `EvidenceRef["kind"]`, same reason. */
const EVIDENCE_KINDS: ReadonlySet<string> = new Set([
  "atf-result",
  "artifact",
  "log",
]);

/**
 * A declared-`string` field, read defensively. Anything that is not already a
 * string becomes `""` — see the coercion note in the file header.
 */
export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Invisible formatting characters that change how SURROUNDING text reads
 * without being visible themselves, or that make two different strings print
 * identically:
 *
 *   U+00AD            soft hyphen
 *   U+034F            combining grapheme joiner
 *   U+061C            Arabic letter mark
 *   U+115F-U+1160     Hangul choseong/jungseong fillers
 *   U+17B4-U+17B5     Khmer inherent vowels (invisible)
 *   U+180B-U+180F     Mongolian free variation selectors + vowel separator
 *   U+200B-U+200F     zero-width space/joiners, LRM/RLM
 *   U+202A-U+202E     bidi embeddings/overrides
 *   U+2060-U+206F     word joiner, invisible operators, bidi isolates,
 *                     deprecated format controls
 *   U+3164            Hangul filler
 *   U+FE00-U+FE0F     variation selectors
 *   U+FEFF            BOM / zero-width no-break space
 *   U+FFA0            halfwidth Hangul filler
 *   U+E0000-U+E007F   tag characters (ASCII smuggling)
 *   U+E0100-U+E01EF   variation selectors supplement
 *
 * None of them is a C0/C1 control, so the control-character rules in the
 * console and JUnit reporters let them through.
 *
 * Delegated decision 2026-09-26: widened from the bidi/zero-width core to the
 * whole family above, with the `u` flag so the two astral ranges match as ONE
 * code point rather than as surrogate halves. A lone surrogate is not in the
 * set and never matches here; the JUnit reporter's own rule drops it.
 */
const INVISIBLE_FORMAT_CHARS =
  // eslint-disable-next-line no-misleading-character-class -- each combining mark / variation selector is meant to match ALONE; that is the point of the set
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/**
 * Replace every invisible formatting character with a VISIBLE `<U+XXXX>`
 * token.
 *
 * Delegated decision 2026-09-25: escaped, not deleted, in every human-read
 * surface (console and JUnit). An instance-authored assertion can carry a
 * U+202E that reverses the rest of a CI log line (Trojan Source), or a U+200B
 * that makes `spec-a` and `spec-\u200Ba` print identically. Deleting the
 * character removes the attack but also the evidence that the text was
 * tampered with — two different ids would still render the same. The token
 * keeps both facts visible. The `--json` document is deliberately NOT passed
 * through this: it is the uncapped, byte-faithful record, and a machine reader
 * gets the character itself, which it can inspect.
 *
 * Delegated decision 2026-09-26: the token is built from `codePointAt`, so an
 * astral tag character renders `<U+E0061>` (four to six hex digits) instead of
 * the high surrogate's `<U+DB40>`. The token is pure ASCII, so the XML
 * validity rules applied after this step are unaffected by it.
 */
export function escapeInvisibleFormatChars(value: string): string {
  return value.replace(
    INVISIBLE_FORMAT_CHARS,
    (char) =>
      `<U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>`,
  );
}

/** `{ id, path }` and nothing else, whatever else the object carried. */
export function projectSpecRef(value: unknown): TestSpecRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<TestSpecRef>;
  return { id: asText(candidate.id), path: asText(candidate.path) };
}

/** Captured failure artifacts (QA-11); entries with an unknown `kind` are dropped. */
export function projectArtifacts(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  const refs: ArtifactRef[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Partial<ArtifactRef>;
    const kind = candidate.kind;
    if (typeof kind !== "string" || !ARTIFACT_KINDS.has(kind)) continue;
    refs.push({ kind, ref: asText(candidate.ref) });
  }
  return refs;
}

function projectEvidence(value: unknown): EvidenceRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<EvidenceRef>;
  const kind = candidate.kind;
  if (typeof kind !== "string" || !EVIDENCE_KINDS.has(kind)) return undefined;
  return { kind, ref: asText(candidate.ref) };
}

/**
 * Fail-closed outcome normalisation. An outcome outside the closed union is
 * recorded as `error` — the same resolution @tessera/core's §6a table gives an
 * unknown raw value (inconclusive, blocking). It is never rendered verbatim:
 * `raw` reaches three output surfaces and an unvetted value would be a string
 * the instance chose.
 */
function projectRawOutcome(value: unknown): RawOutcome {
  return typeof value === "string" && KNOWN_OUTCOMES.has(value)
    ? (value as RawOutcome)
    : "error";
}

/** A projected row, with the record of whether projecting it changed anything. */
interface ProjectedOutcome {
  readonly outcome: SpecOutcome;
  /**
   * True when `projectRawOutcome` replaced the row's `raw` — an out-of-union
   * string, or no `raw` at all. Detected by comparing against the value that
   * arrived, so a row that legitimately said `"error"` is not flagged; the
   * point is that the row now reads `error` for a reason the stream did not
   * give, and `counts.error` cannot tell the two apart.
   */
  readonly coerced: boolean;
}

function projectOutcome(value: unknown): ProjectedOutcome | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<SpecOutcome>;
  const spec = projectSpecRef(candidate.spec);
  if (spec === undefined) return undefined;
  const evidence = projectEvidence(candidate.evidence);
  const raw = projectRawOutcome(candidate.raw);
  return {
    outcome: evidence === undefined ? { spec, raw } : { spec, raw, evidence },
    coerced: candidate.raw !== raw,
  };
}

/** A `fail` event, reduced to its declared fields. */
export interface CollectedFailure {
  readonly spec: TestSpecRef;
  readonly assertion: string;
  readonly artifacts: readonly ArtifactRef[];
}

/** An `error` event (DEV-1 infra fault) — `spec` is absent for a run-level fault. */
export interface CollectedError {
  readonly spec?: TestSpecRef;
  readonly cause: string;
  readonly artifacts: readonly ArtifactRef[];
}

/** One count per member of the closed `RawOutcome` union, plus the total. */
export type OutcomeCounts = Readonly<Record<RawOutcome, number>> & {
  readonly total: number;
};

/** Everything the reporters are allowed to know about a run. */
export interface CollectedRun {
  readonly runId: RunId;
  /** False when no terminal `end` event arrived — an aborted or crashed run. */
  readonly ended: boolean;
  /** From the `end` event's `RunResult` only; empty until it arrives. */
  readonly outcomes: readonly SpecOutcome[];
  readonly failures: readonly CollectedFailure[];
  readonly errors: readonly CollectedError[];
  readonly logs: readonly string[];
  readonly started: readonly TestSpecRef[];
  /** Derived from `outcomes` on every call — never stored, never settable. */
  readonly counts: OutcomeCounts;
  /**
   * Whole events that could not be read as their declared shape. These were
   * never going to be counted, so this number does NOT reduce `counts.total`.
   */
  readonly dropped: number;
  /**
   * Rows inside an otherwise valid `end` that were not readable as a
   * `SpecOutcome`. Unlike `dropped`, each one IS missing from `outcomes` and so
   * from `counts.total`: the run reported a result for a spec and the report
   * shows no row for it. A reader who sees only `counts` cannot recover this.
   */
  readonly droppedOutcomeRows: number;
  /**
   * Rows kept, but whose `raw` this file replaced with `error` (fail-closed,
   * see `projectRawOutcome`). They are inside `counts.error`, indistinguishable
   * from genuine DEV-1 faults unless this number is printed beside it.
   */
  readonly coercedOutcomes: number;
  /**
   * Specs that emitted `start` and appear nowhere in the final outcome list.
   * The worst shape in this group, because it can be nonzero while `ended` is
   * true: the one field whose job is to say "this document is whole" asserts it
   * while the evidence of incompleteness has already been deleted. §6a has a
   * `missing` outcome for exactly this, so a nonzero value here means the
   * result skipped a unit it should have marked missing.
   */
  readonly startedWithoutOutcome: number;
  /**
   * Specs named by a `fail` or spec-attributed `error` event that appear
   * nowhere in the final outcome list. Counted once per spec, derived like
   * `startedWithoutOutcome` (which it may overlap: a spec that started AND
   * failed and then vanished is in both — they answer different questions).
   *
   * Delegated decision 2026-09-25: this exists because the result is the only
   * thing the counts are derived from, so a failure the stream DID report and
   * the result then omitted used to leave every count at zero. A nonzero
   * value here is a harness error in every reporter, never a footnote.
   */
  readonly faultedWithoutOutcome: number;
  /**
   * Specs named by a `fail` or spec-attributed `error` event whose row in the
   * final outcome list reads `pass`. Counted once per spec by `specKey`.
   *
   * Delegated decision 2026-09-26: a SEPARATE field rather than folded into
   * `faultedWithoutOutcome`, because the two are different questions — "the
   * result omitted the spec" vs "the result contradicts the stream" — and the
   * header's rule is one field per question. Only `pass` counts: it is the one
   * outcome under which the stream's failure reaches no reporter as a failure
   * (a `pass` row renders as a bare green `<testcase/>`). Every other row
   * already renders as failure/error/skipped. Any `pass` row for the key
   * counts, even beside a `fail` row for the same key — fail-closed. A nonzero
   * value is a harness error in every reporter.
   */
  readonly faultedContradictedByOutcome: number;
}

export interface EventCollector {
  /** Synchronous and total: it never throws, whatever it is handed. */
  record(event: TestEvent): void;
  /**
   * @param fallbackRunId the id core passes to `close()`, used when no event
   * carried one (a run that produced no events still owes a report).
   */
  snapshot(fallbackRunId: RunId): CollectedRun;
}

function countOutcomes(outcomes: readonly SpecOutcome[]): OutcomeCounts {
  const tally: Record<string, number> = {};
  for (const outcome of RAW_OUTCOMES) tally[outcome] = 0;
  for (const outcome of outcomes) {
    tally[outcome.raw] = (tally[outcome.raw] ?? 0) + 1;
  }
  return {
    ...(tally as Record<RawOutcome, number>),
    total: outcomes.length,
  };
}

/**
 * Specs seen in a `start` event with no row in the final outcome list, counted
 * once each — the unit is "a spec that vanished", not "an event". The join is
 * `specKey`, the same canonical key @tessera/core's reducer uses, so this
 * agrees with the join everything else in the pipeline does (QA-16).
 *
 * Derived here rather than latched during `record` because the outcome list is
 * replaced by the last `end`: a spec answered by an earlier, overwritten `end`
 * is missing from the report that will actually be printed, and this number is
 * about that report.
 */
function countStartedWithoutOutcome(
  started: readonly TestSpecRef[],
  outcomes: readonly SpecOutcome[],
): number {
  const answered = new Set(outcomes.map((outcome) => specKey(outcome.spec)));
  const unanswered = new Set<string>();
  for (const spec of started) {
    const key = specKey(spec);
    if (!answered.has(key)) unanswered.add(key);
  }
  return unanswered.size;
}

/**
 * Specs named by a `fail` event or a spec-attributed `error` event with no row
 * in the final outcome list, counted once each by `specKey` — see
 * `CollectedRun.faultedWithoutOutcome`.
 */
function countFaultedWithoutOutcome(
  failures: readonly CollectedFailure[],
  errors: readonly CollectedError[],
  outcomes: readonly SpecOutcome[],
): number {
  const faulted: TestSpecRef[] = failures.map((failure) => failure.spec);
  for (const error of errors) {
    if (error.spec !== undefined) faulted.push(error.spec);
  }
  return countStartedWithoutOutcome(faulted, outcomes);
}

/**
 * Specs named by a `fail` event or a spec-attributed `error` event whose final
 * outcome row reads `pass`, counted once each by `specKey` — see
 * `CollectedRun.faultedContradictedByOutcome`.
 */
function countFaultedContradictedByOutcome(
  failures: readonly CollectedFailure[],
  errors: readonly CollectedError[],
  outcomes: readonly SpecOutcome[],
): number {
  const passed = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.raw === "pass") passed.add(specKey(outcome.spec));
  }
  const contradicted = new Set<string>();
  for (const failure of failures) {
    const key = specKey(failure.spec);
    if (passed.has(key)) contradicted.add(key);
  }
  for (const error of errors) {
    if (error.spec === undefined) continue;
    const key = specKey(error.spec);
    if (passed.has(key)) contradicted.add(key);
  }
  return contradicted.size;
}

export function createEventCollector(): EventCollector {
  let runId: RunId | undefined;
  let ended = false;
  let dropped = 0;
  let outcomes: SpecOutcome[] = [];
  // Row-level counters describe ONE `end` event, so they are replaced with it
  // rather than accumulated. Accumulating would let them describe a stream the
  // `outcomes` array is no longer from — a caveat about a report that was
  // overwritten is worse than no caveat, because it is attached to numbers it
  // does not explain. (`dropped` still accumulates: it counts events, and every
  // event in the stream really did arrive.)
  let droppedOutcomeRows = 0;
  let coercedOutcomes = 0;
  const failures: CollectedFailure[] = [];
  const errors: CollectedError[] = [];
  const logs: string[] = [];
  const started: TestSpecRef[] = [];

  function noteRunId(value: unknown): void {
    // ARCH-16: every event carries a runId. The FIRST one wins — these adapters
    // are constructed per run (core's `ports.reporters` belong to one
    // `runPipeline` call), so a second id means a caller shared an instance
    // across runs, and the first id is the one this report is about.
    if (runId === undefined && typeof value === "string" && value.length > 0) {
      runId = value;
    }
  }

  return {
    record(event: TestEvent): void {
      try {
        if (typeof event !== "object" || event === null) {
          dropped += 1;
          return;
        }
        noteRunId((event as { runId?: unknown }).runId);
        switch (event.kind) {
          case "start": {
            const spec = projectSpecRef(event.spec);
            if (spec === undefined) {
              dropped += 1;
              return;
            }
            started.push(spec);
            return;
          }
          case "pass":
            // A pass carries no evidence beyond its outcome row; the `end`
            // event's RunResult is the record of it, so nothing is stored here.
            return;
          case "fail": {
            const spec = projectSpecRef(event.spec);
            if (spec === undefined) {
              dropped += 1;
              return;
            }
            failures.push({
              spec,
              assertion: asText(event.assertion),
              artifacts: projectArtifacts(event.artifacts),
            });
            return;
          }
          case "error": {
            const spec = projectSpecRef(event.spec);
            const cause = asText(event.cause);
            const artifacts = projectArtifacts(event.artifacts);
            errors.push(
              spec === undefined
                ? { cause, artifacts }
                : { spec, cause, artifacts },
            );
            return;
          }
          case "log":
            logs.push(asText(event.message));
            return;
          case "end": {
            const result = event.result as { outcomes?: unknown } | undefined;
            const rows: unknown = result?.outcomes;
            if (!Array.isArray(rows)) {
              // Delegated decision 2026-09-25: an `end` whose `result.outcomes`
              // is not an array is NOT a terminal event — it is a malformed
              // one, counted in `dropped` and otherwise ignored, so `ended`
              // stays false and every reporter says the run was cut short.
              // Until then it read as `[]` with `ended: true`: a complete run
              // with no results, so `fail`/`error` events recorded before it
              // produced a JUnit `tests="0" failures="0" errors="0"` — green.
              // "The result could not be read" must never render as "the
              // result was empty". A previously accepted `end` is left intact.
              dropped += 1;
              return;
            }
            const list: unknown[] = rows;
            const projected: SpecOutcome[] = [];
            let unreadable = 0;
            let coerced = 0;
            for (const row of list) {
              const result = projectOutcome(row);
              if (result === undefined) {
                // NOT `dropped`: this row was going to be one of the numbers
                // the report prints, and now it is not. See the header.
                unreadable += 1;
                continue;
              }
              if (result.coerced) coerced += 1;
              projected.push(result.outcome);
            }
            // Last `end` wins: core emits exactly one (ARCH-24, guarded by its
            // own `ended` latch), so a second can only be a duplicate stream.
            outcomes = projected;
            droppedOutcomeRows = unreadable;
            coercedOutcomes = coerced;
            ended = true;
            return;
          }
          default:
            // An event kind this build does not know. Counting it is the whole
            // response: guessing at its fields is how an unvetted string
            // reaches a report.
            dropped += 1;
            return;
        }
      } catch {
        // Reading a hostile object (a throwing getter, a revoked proxy) must
        // not propagate: core would swallow it and we would not even know.
        dropped += 1;
      }
    },

    snapshot(fallbackRunId: RunId): CollectedRun {
      return {
        runId: runId ?? asText(fallbackRunId),
        ended,
        outcomes: [...outcomes],
        failures: [...failures],
        errors: [...errors],
        logs: [...logs],
        started: [...started],
        counts: countOutcomes(outcomes),
        dropped,
        droppedOutcomeRows,
        coercedOutcomes,
        startedWithoutOutcome: countStartedWithoutOutcome(started, outcomes),
        faultedWithoutOutcome: countFaultedWithoutOutcome(
          failures,
          errors,
          outcomes,
        ),
        faultedContradictedByOutcome: countFaultedContradictedByOutcome(
          failures,
          errors,
          outcomes,
        ),
      };
    },
  };
}

/**
 * Index the assertion strings captured from `fail` events by canonical spec
 * key. Re-exported from @tessera/core's `specKey` rather than re-implemented,
 * so the join the reporters do is the join the reducer does.
 */
export function assertionsBySpec(
  run: CollectedRun,
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const failure of run.failures) {
    const key = specKey(failure.spec);
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [failure.assertion]);
    else bucket.push(failure.assertion);
  }
  return index;
}

/** The same index for the `cause` strings of spec-attributed `error` events. */
export function causesBySpec(
  run: CollectedRun,
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const error of run.errors) {
    if (error.spec === undefined) continue;
    const key = specKey(error.spec);
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [error.cause]);
    else bucket.push(error.cause);
  }
  return index;
}
