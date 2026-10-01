// The pure verdict reducer (DESIGN §6a). PURE: no I/O, no Date.now(), no
// randomness — byte-identical output for the same input. The injected clock
// (`now`) and TTL keep token timestamps deterministic; `sig` is minted OUTSIDE
// this function by the GateEvaluator shell (the reducer only computes
// verdictHash and leaves sig === "").

import type {
  ChecklistRow,
  ConfirmToken,
  CoverageReport,
  ImpactGraph,
  OverrideRecord,
  PipelineTopology,
  PlannedSpec,
  PreflightVerdict,
  RawOutcome,
  RunResult,
  SpecOutcome,
  VerdictStatus,
} from "@tessera/types";
import { RAW_OUTCOMES } from "@tessera/types";
import { canonicalJson, sha256Hex, specKey } from "./canonical.js";

export interface VerdictInput {
  /** What SHOULD have run — drives row creation (no result → raw "missing"). */
  planned: readonly PlannedSpec[];
  /** What DID run. */
  results: readonly RunResult[];
  impact: ImpactGraph;
  coverage: CoverageReport;
  /** 0 disables the floor. */
  coverageFloor: number;
  runId: string;
  topology: PipelineTopology;
  /** Overrides requested by the caller (CLI flags / MCP arguments). */
  overrides: readonly OverrideRecord[];
  /** Injected clock, ISO-8601 — becomes ConfirmToken.issuedAt. */
  now: string;
  /** Injected TTL — becomes ConfirmToken.expiresAt (default ~60 min upstream). */
  tokenTtlMs: number;
}

interface Resolution {
  status: ChecklistRow["status"];
  blocking: boolean;
}

// §6a fail-closed resolution table. Every raw outcome maps here; anything
// outside the closed union resolves like "error" (blocking, never ignored).
const RESOLUTION: Record<RawOutcome, Resolution> = {
  pass: { status: "pass", blocking: false },
  fail: { status: "fail", blocking: true },
  error: { status: "inconclusive", blocking: true },
  skipped: { status: "inconclusive", blocking: true },
  "waiting-timeout": { status: "inconclusive", blocking: true },
  flaky: { status: "inconclusive", blocking: true },
  missing: { status: "fail", blocking: true },
};

const KNOWN_OUTCOMES = new Set<string>(RAW_OUTCOMES);

function compareRows(a: ChecklistRow, b: ChecklistRow): number {
  // §6a sort contract: (target.table, target.sysId, spec) ascending. "spec"
  // concretizes to (spec.id, spec.path). Plain string comparison (UTF-16 code
  // units), never localeCompare — locale-dependent order breaks byte-stability.
  if (a.target.table !== b.target.table)
    return a.target.table < b.target.table ? -1 : 1;
  if (a.target.sysId !== b.target.sysId)
    return a.target.sysId < b.target.sysId ? -1 : 1;
  if (a.spec.id !== b.spec.id) return a.spec.id < b.spec.id ? -1 : 1;
  if (a.spec.path !== b.spec.path) return a.spec.path < b.spec.path ? -1 : 1;
  return 0;
}

function describeSpec(ref: PlannedSpec["spec"]): string {
  return `${ref.id} (${ref.path})`;
}

export function aggregateVerdict(input: VerdictInput): PreflightVerdict {
  const issuedAtMs = Date.parse(input.now);
  if (!Number.isFinite(issuedAtMs)) {
    throw new TypeError(
      `VerdictInput.now must be an ISO-8601 timestamp, got ${JSON.stringify(input.now)}`,
    );
  }

  const warnings: string[] = [];

  // Planned specs, de-duplicated by canonical key (first occurrence wins —
  // deterministic; duplicates are surfaced, never silently collapsed).
  const planned = new Map<string, PlannedSpec>();
  for (const entry of input.planned) {
    const key = specKey(entry.spec);
    if (planned.has(key)) {
      warnings.push(
        `duplicate planned spec ignored: ${describeSpec(entry.spec)}`,
      );
    } else {
      planned.set(key, entry);
    }
  }

  // Fold every runner outcome onto its planned spec. Results for specs never
  // planned cannot become rows (`planned` drives row creation) but are
  // surfaced as warnings — never silently dropped.
  const outcomesBySpec = new Map<string, SpecOutcome[]>();
  for (const result of input.results) {
    for (const outcome of result.outcomes) {
      const key = specKey(outcome.spec);
      if (!planned.has(key)) {
        warnings.push(
          `unplanned result ignored: ${describeSpec(outcome.spec)}`,
        );
        continue;
      }
      const bucket = outcomesBySpec.get(key);
      if (bucket) bucket.push(outcome);
      else outcomesBySpec.set(key, [outcome]);
    }
  }

  const rows: ChecklistRow[] = [];
  for (const [key, plan] of planned) {
    const outcomes = outcomesBySpec.get(key) ?? [];

    let raw: RawOutcome;
    let evidence: ChecklistRow["evidence"];
    if (outcomes.length === 0) {
      // Synthesized by the reducer, never emitted by a runner (§6a).
      raw = "missing";
    } else {
      const first = outcomes[0] as SpecOutcome;
      const disagree = outcomes.some((o) => o.raw !== first.raw);
      // Multiple outcomes for one spec that disagree are re-run disagreement
      // by definition → "flaky" (QA-7); agreement collapses to the shared raw.
      raw = disagree ? "flaky" : first.raw;
      evidence = first.evidence;
    }

    let resolution = RESOLUTION[raw] as Resolution | undefined;
    if (!KNOWN_OUTCOMES.has(raw) || resolution === undefined) {
      // Fail-closed default: an outcome outside the closed union (adapter
      // drift) resolves like "error" — blocking, never ignored. `raw` keeps
      // the received value so the wire shows the truth.
      warnings.push(
        `unknown outcome ${JSON.stringify(raw)} for ${describeSpec(plan.spec)} resolved as error (fail-closed default)`,
      );
      resolution = RESOLUTION.error;
    }

    const row: ChecklistRow = {
      spec: plan.spec,
      kind: plan.kind,
      target: plan.target,
      raw,
      status: resolution.status,
      blocking: resolution.blocking,
      overridden: false,
    };
    if (evidence !== undefined) row.evidence = evidence;
    rows.push(row);
  }

  // Overrides. Only "allow-skipped" exists: flips `blocking` on raw==="skipped"
  // rows, raw/status untouched, recorded per-row and verdict-level. It NEVER
  // applies to error/waiting-timeout/flaky/missing (§6a). `affectedRows` is
  // recomputed from the rows actually flipped — the caller's count is not
  // trusted. Duplicate records for the same flag collapse to the first.
  // A record that flipped nothing (`affectedRows: 0`) is still recorded: the
  // audit trail and the digest keep what the actor asked for, while the
  // token's `overridden` flag is derived from `affectedRows` instead.
  // `affectedRows` counts skipped rows without re-testing `blocking`; that
  // equals "rows actually flipped" only because such a row is always blocking
  // at this point (see the resolution table) and the dedupe below lets this
  // body run at most once per flag. Reach: this can lift the INCONCLUSIVE
  // rung of the ladder but never the NO_GO rung, which tests
  // `status === "fail"` — no representable override turns a NO_GO into a GO.
  const appliedFlags = new Set<OverrideRecord["flag"]>();
  const overrides: OverrideRecord[] = [];
  for (const record of input.overrides) {
    if (record.flag !== "allow-skipped") {
      warnings.push(
        `unknown override flag ignored: ${JSON.stringify(record.flag)}`,
      );
      continue;
    }
    if (appliedFlags.has(record.flag)) {
      warnings.push(`duplicate override record ignored: ${record.flag}`);
      continue;
    }
    appliedFlags.add(record.flag);
    let affectedRows = 0;
    for (const row of rows) {
      if (row.raw === "skipped") {
        row.blocking = false;
        row.overridden = true;
        affectedRows += 1;
      }
    }
    overrides.push({ flag: record.flag, affectedRows, actor: record.actor });
  }

  rows.sort(compareRows);

  // ARCH-30 parity: the planned checklist and the impact-demanded coverage
  // must agree in both directions; a breach means the analysis and the plan
  // drifted apart — INCONCLUSIVE, never a quiet green.
  const demandedKeys = new Set<string>();
  for (const entry of input.impact.demanded) {
    demandedKeys.add(specKey(entry.spec));
  }
  let parityBreach = false;
  for (const [key, plan] of planned) {
    if (!demandedKeys.has(key)) {
      parityBreach = true;
      warnings.push(
        `parity breach: planned spec not demanded by impact analysis: ${describeSpec(plan.spec)}`,
      );
    }
  }
  for (const entry of input.impact.demanded) {
    if (!planned.has(specKey(entry.spec))) {
      parityBreach = true;
      warnings.push(
        `parity breach: impact-demanded spec not planned: ${describeSpec(entry.spec)}`,
      );
    }
  }

  // QA-9: unanalyzable impact edges become warnings only — they never change
  // the status. Sorted for determinism.
  const unanalyzable = [...input.impact.unanalyzable].sort((a, b) => {
    if (a.artifact.table !== b.artifact.table)
      return a.artifact.table < b.artifact.table ? -1 : 1;
    if (a.artifact.sysId !== b.artifact.sysId)
      return a.artifact.sysId < b.artifact.sysId ? -1 : 1;
    return 0;
  });
  for (const entry of unanalyzable) {
    warnings.push(
      `unanalyzable impact: ${entry.artifact.table}/${entry.artifact.sysId} (${entry.artifact.name}): ${entry.reason}`,
    );
  }

  const counts = {
    pass: rows.filter((r) => r.status === "pass").length,
    fail: rows.filter((r) => r.status === "fail").length,
    inconclusive: rows.filter((r) => r.status === "inconclusive").length,
    blocking: rows.filter((r) => r.blocking).length,
    missing: rows.filter((r) => r.raw === "missing").length,
  };

  // QA-15: confirmed ÷ all impacted artifacts; nothing impacted → floor
  // trivially satisfied (and an empty plan is already INCONCLUSIVE above).
  const coverageRatio =
    input.coverage.impactedArtifacts <= 0
      ? 1
      : input.coverage.confirmedArtifacts / input.coverage.impactedArtifacts;

  // §6a overall status, evaluated strictly in order.
  let status: VerdictStatus;
  if (planned.size === 0) {
    // Empty checklist ≠ nothing to verify (ARCH-14 posture).
    status = "INCONCLUSIVE";
    warnings.push(
      "empty checklist: nothing was planned — not evidence of safety",
    );
  } else if (parityBreach) {
    status = "INCONCLUSIVE";
  } else if (rows.some((r) => r.blocking && r.status === "fail")) {
    status = "NO_GO";
  } else if (rows.some((r) => r.blocking && r.status === "inconclusive")) {
    status = "INCONCLUSIVE";
  } else if (input.coverageFloor > 0 && coverageRatio < input.coverageFloor) {
    status = "INCONCLUSIVE";
    warnings.push(
      `coverage ${coverageRatio.toFixed(4)} below floor ${input.coverageFloor.toFixed(4)}`,
    );
  } else {
    status = "GO";
  }

  // Delegated decision 2026-09-26: PreflightVerdict is a discriminated union
  // (GO carries a ConfirmToken, NO_GO/INCONCLUSIVE never do), so the status
  // is attached per branch below. Key order is unchanged — status first,
  // confirmToken last — so serialised verdicts stay byte-identical.
  const body = {
    runId: input.runId,
    topology: input.topology,
    rows,
    counts,
    overrides,
    warnings,
  };

  // Token iff GO (A-1) — this branch is the only minting site. A GO reached
  // under an override stays distinguishable twice over: `overridden` is set,
  // and the digest differs because `overrides` is part of the hash. The
  // digest difference holds even for a record that flipped nothing; the flag
  // deliberately does not (see below).
  if (status === "GO") {
    const verdictHash = sha256Hex(
      canonicalJson({
        rows,
        runId: input.runId,
        topology: input.topology,
        overrides,
      }),
    );
    const token: ConfirmToken = {
      runId: input.runId,
      verdictHash,
      // Derived from what an override DID, not from what was asked for:
      // true iff an accepted record affected at least one row. A record
      // that flipped nothing survives in `overrides` (and in the hash
      // above) but leaves this false — the two are deliberately separate.
      // Because this branch is GO-only, and no other ladder rung is
      // override-sensitive, "affected a row" here is also exactly "lifted
      // this run from INCONCLUSIVE to GO". That equivalence is a property
      // of the ladder, not of this expression: off a GO verdict the same
      // predicate holds with nothing promoted, so never lift this flag out
      // of the token onto the verdict.
      overridden: overrides.some((o) => o.affectedRows > 0),
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + input.tokenTtlMs).toISOString(),
      // Minted by the GateEvaluator shell with the injected HMAC key; the
      // empty string keeps reducer output (and golden fixtures) byte-stable.
      sig: "",
    };
    return { status: "GO", ...body, confirmToken: token };
  }

  const verdict: PreflightVerdict = { status, ...body };
  return verdict;
}
