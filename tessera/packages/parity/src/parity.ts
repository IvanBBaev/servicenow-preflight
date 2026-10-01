// ARCH-20 code-version parity — the decision logic.
//
// Tessera resolves WHAT CHANGED on the source instance and executes the suite
// on the runner. If the runner carries a different version of those artifacts,
// every pass and every fail is a statement about code nobody asked about, so
// this stage refuses the run before it starts rather than producing results
// that look fine and mean nothing.
//
// It only ever reads. ARCH-20 is explicit that Tessera never deploys
// source -> runner itself, so there is no remedy here, no `ProvisionAction`,
// and no dependency on `@tessera/provisioner`. What the report says is advice
// for a human with a deployment pipeline.

import type { TargetArtifactRef } from "@tessera/types";

import { ParityContractError } from "./errors.js";
import {
  type FieldRead,
  comparableTables,
  digestFieldReads,
  executableFieldsFor,
  readExecutableFields,
  relatedFor,
  type RelatedSpec,
  uncomparedFor,
} from "./fingerprint.js";
import {
  ABORTED_BEFORE_READ,
  type ArtifactRead,
  type ArtifactReader,
  type InstanceHost,
  type RelatedRowsRead,
  isSysId,
} from "./reader.js";
import type {
  ParityCheck,
  ParityReport,
  ParityRow,
  ParityStatus,
  ParityTopology,
} from "./types.js";

/** Short form for evidence — the full digests stay on the row. */
function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

function label(artifact: TargetArtifactRef): string {
  return `${artifact.table}/${artifact.sysId} (${artifact.name})`;
}

/**
 * Precedence over the rows.
 *
 * A proven mismatch dominates an undecided read — the reverse of the doctor's
 * roll-up, and deliberately so. PLAN Phase 1 gives the two statuses different
 * consequences: a mismatch is a hard preflight failure, an undecidable parity
 * is an `inconclusive` verdict. Reporting "we could not tell" while one
 * artifact is provably at the wrong version would downgrade the more specific
 * and more actionable fact. Between the remaining two, `undecidable` still
 * outranks `match`: an answer nobody could read is never a green one
 * (ARCH-28/DEV-17).
 *
 * An empty list rolls up to `match` vacuously; `check()` never calls it that
 * way, because "nothing was compared" is `not-applicable` and is decided one
 * level up (QA-9).
 */
export function rollUpParity(
  rows: readonly ParityRow[],
): Exclude<ParityStatus, "not-applicable"> {
  if (rows.some((row) => isMismatch(row))) return "mismatch";
  if (rows.some((row) => row.outcome === "undecidable")) return "undecidable";
  return "match";
}

function isMismatch(row: ParityRow): boolean {
  return (
    row.outcome === "differs" ||
    row.outcome === "missing-on-runner" ||
    row.outcome === "missing-on-source"
  );
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * The check. `reader` is the only way it touches an instance, so a caller that
 * hands it a stub gets the whole decision table without a network.
 */
export function createParityCheck(reader: ArtifactReader): ParityCheck {
  return {
    async check(request) {
      const { source, runner } = assertUsableTopology(request.topology);

      // Delegated decision 2026-09-26 (review W6a M5): the two SIDES are the
      // instance hosts behind the profiles, not the profile names. Two names
      // pointing at one instance used to be compared as two instances and
      // report `match` — one instance agreeing with itself. Each role is
      // resolved separately, even when the names are equal, so one name that
      // resolves to two hosts is caught rather than assumed to be one side.
      const sourceHost = hostOf(reader, source);
      const runnerHost = hostOf(reader, runner);
      const hosts = {
        ...(sourceHost.ok ? { sourceHost: sourceHost.host } : {}),
        ...(runnerHost.ok ? { runnerHost: runnerHost.host } : {}),
      };

      if (
        sourceHost.ok &&
        runnerHost.ok &&
        sourceHost.host === runnerHost.host
      ) {
        // Collapsed topology: one instance is both sides, and code cannot be
        // out of parity with itself. Said out loud rather than left as an
        // empty green report — a check that silently does nothing is
        // indistinguishable from a check that passed (QA-9).
        return build(source, runner, "not-applicable", [], {
          ...hosts,
          summary:
            source === runner
              ? `source and runner are the same instance (${source}, ${sourceHost.host}) — there is nothing to compare, and nothing was verified`
              : `source (${source}) and runner (${runner}) resolve to the same instance host (${sourceHost.host}) — there is nothing to compare, and nothing was verified`,
        });
      }

      if (request.artifacts.length === 0) {
        return build(source, runner, "not-applicable", [], {
          ...hosts,
          summary:
            "no artifacts were resolved — parity compared nothing, which is not the same as parity holding",
        });
      }

      // Delegated decision 2026-09-26: a side whose host is unknown, or one
      // name resolving to two hosts, leaves every row `undecidable` and sends
      // no read. Reads are addressed by PROFILE, so with the sides unproven
      // the two reads could not be shown to be about two instances. Residual
      // risk, named: the host is resolved here, not re-proven at read time;
      // credentials rewritten between the two moments are not caught.
      const hostProblem = !sourceHost.ok
        ? `source (${source}): the instance host cannot be resolved — ${sourceHost.reason}`
        : !runnerHost.ok
          ? `runner (${runner}): the instance host cannot be resolved — ${runnerHost.reason}`
          : source === runner
            ? `source and runner are both profile ${source}, but it resolved to ${sourceHost.host} and then to ${runnerHost.host} — one name is not proven to be one instance, nor two`
            : undefined;
      if (hostProblem !== undefined) {
        const rows = request.artifacts.map((artifact): ParityRow => ({
          artifact,
          outcome: "undecidable",
          evidence: hostProblem,
          fields: [],
        }));
        return build(source, runner, rollUpParity(rows), rows, hosts);
      }

      const rows: ParityRow[] = [];
      for (const artifact of request.artifacts) {
        rows.push(
          await compareArtifact(
            reader,
            artifact,
            source,
            runner,
            request.signal,
          ),
        );
      }

      return build(source, runner, rollUpParity(rows), rows, hosts);
    },
  };
}

/**
 * One profile's normalized instance host, never a throw. A reader that cannot
 * name hosts (a JavaScript stub written before M5) is unresolved, not trusted:
 * fail closed.
 */
function hostOf(reader: ArtifactReader, profile: string): InstanceHost {
  const resolve = (reader as Partial<ArtifactReader>).instanceHost;
  if (typeof resolve !== "function") {
    return {
      ok: false,
      reason: "this reader cannot name the instance host behind a profile",
    };
  }
  try {
    const answer = resolve.call(reader, profile);
    if (!answer.ok) return answer;
    // Host names are case-insensitive (RFC 4343); the scheme, path and port
    // are already gone (`resolveHost` in the live reader).
    const host = answer.host.trim().toLowerCase();
    return host === ""
      ? { ok: false, reason: `profile ${profile} resolved to an empty host` }
      : { ok: true, host };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The one condition that throws. A blank profile name is a wiring bug: both
 * sides would fall back to the same ambient credentials and the check would
 * manufacture a `match` out of a single instance. Everything an instance can
 * actually do to us comes back as a row.
 */
function assertUsableTopology(topology: ParityTopology): {
  source: string;
  runner: string;
} {
  const source = topology.source.trim();
  const runner = topology.runner.trim();
  if (source === "" || runner === "") {
    throw new ParityContractError(
      `parity needs both roles named: source=${JSON.stringify(topology.source)} runner=${JSON.stringify(topology.runner)}`,
    );
  }
  return { source, runner };
}

async function compareArtifact(
  reader: ArtifactReader,
  artifact: TargetArtifactRef,
  source: string,
  runner: string,
  signal: AbortSignal | undefined,
): Promise<ParityRow> {
  const undecidable = (evidence: string, fields: readonly string[] = []) =>
    ({ artifact, outcome: "undecidable", evidence, fields }) as const;

  // Cancellation resolves rows; it never throws. A caller that gave up still
  // gets a report saying which artifacts went unverified.
  if (aborted(signal)) return undecidable(ABORTED_BEFORE_READ);

  if (artifact.table.trim() === "" || artifact.sysId.trim() === "") {
    return undecidable(
      `the resolved artifact carries no table/sys_id (table=${JSON.stringify(artifact.table)}, sys_id=${JSON.stringify(artifact.sysId)}) — there is no row to read`,
    );
  }

  if (!isSysId(artifact.sysId)) {
    // Delegated decision 2026-09-25: a sys_id that is not 32 lowercase hex
    // characters is not read at all. As a path segment, `..` or `.` would be
    // normalised by the URL parser onto the table's LIST endpoint, and
    // whatever came back would be a statement about some other rows.
    return undecidable(
      `the resolved artifact's sys_id ${JSON.stringify(artifact.sysId)} is not a sys_id (32 lowercase hex characters) — no single-record read can name that row`,
    );
  }

  const fields = executableFieldsFor(artifact.table);
  if (fields === undefined) {
    // QA-9: an artifact this stage cannot fingerprint is named and left
    // undecided. Reporting it as `match` would mean "we checked" when the
    // truthful statement is "we have no idea what this table's version is".
    return undecidable(
      `${artifact.table} is not in the executable-field index, so its version cannot be fingerprinted; comparable tables are ${comparableTables().join(", ")}`,
    );
  }

  // Sequential on purpose: a preflight gate runs over a handful of resolved
  // artifacts, and two profiles reading in lockstep is one more thing to get
  // wrong for a saving nobody will notice.
  const sourceRead = await reader.readArtifact(
    source,
    artifact.table,
    artifact.sysId,
    fields,
    signal,
  );
  const runnerRead = await reader.readArtifact(
    runner,
    artifact.table,
    artifact.sysId,
    fields,
    signal,
  );

  // A fingerprint published on a row claims "this side was read, and this is
  // the digest of what came back". Only a read that ANSWERED WITH the row
  // earns that claim, so field values come from `found` plus a record and
  // from nothing else.
  //
  // Delegated decision 2026-09-25: the record must also BE the requested row.
  // The live adapter already refuses a record carrying another sys_id (or
  // none); this re-check holds the same line for any other `ArtifactReader`,
  // because a digest of the wrong row is a green nobody earned.
  type Side =
    | { readonly kind: "blind" }
    | { readonly kind: "wrong-row"; readonly reason: string }
    | { readonly kind: "read"; readonly reads: ReadonlyMap<string, FieldRead> };
  const sideOf = (read: ArtifactRead): Side => {
    if (read.outcome !== "found" || read.record === undefined) {
      return { kind: "blind" };
    }
    if (read.record.sys_id !== artifact.sysId) {
      return {
        kind: "wrong-row",
        reason: `the record returned carries sys_id ${JSON.stringify(read.record.sys_id)}, not the requested ${artifact.sysId}`,
      };
    }
    return {
      kind: "read",
      reads: readExecutableFields(artifact.table, read.record) ?? new Map(),
    };
  };

  const sourceSide = sideOf(sourceRead);
  const runnerSide = sideOf(runnerRead);
  const digestOf = (side: Side) =>
    side.kind === "read" ? digestFieldReads(fields, side.reads) : undefined;
  const sourceDigest = digestOf(sourceSide);
  const runnerDigest = digestOf(runnerSide);
  const sourceFingerprint =
    sourceDigest?.ok === true ? sourceDigest.digest : undefined;
  const runnerFingerprint =
    runnerDigest?.ok === true ? runnerDigest.digest : undefined;

  const digests = {
    ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
    ...(runnerFingerprint === undefined ? {} : { runnerFingerprint }),
  };
  const row = (outcome: ParityRow["outcome"], evidence: string): ParityRow => ({
    artifact,
    outcome,
    evidence,
    fields,
    ...digests,
  });

  // Undecided beats decided WITHIN a row: with half the comparison missing,
  // neither "same" nor "different" is a claim anyone can stand behind.
  if (sourceRead.outcome === "undecidable") {
    return row("undecidable", `source (${source}): ${sourceRead.detail}`);
  }
  if (runnerRead.outcome === "undecidable") {
    return row("undecidable", `runner (${runner}): ${runnerRead.detail}`);
  }

  // Absent on the source outranks absent on the runner: the artifact set came
  // FROM the source, so a row that is not there invalidates the input itself,
  // and telling the operator to deploy it to the runner would be wrong advice.
  if (sourceRead.outcome === "absent") {
    const both =
      runnerRead.outcome === "absent" ? " (and not on the runner either)" : "";
    return row(
      "missing-on-source",
      `${label(artifact)} was resolved from ${source} but ${sourceRead.detail}${both} — the resolved artifact set no longer describes the source, or this profile cannot see what it describes`,
    );
  }
  if (runnerRead.outcome === "absent") {
    return row(
      "missing-on-runner",
      `${label(artifact)}: ${runnerRead.detail} — the runner cannot execute a version it does not carry, and this read cannot separate a row that is not there from one this profile is not shown`,
    );
  }

  const wrongRow = [
    ...(sourceSide.kind === "wrong-row"
      ? [`source (${source}): ${sourceSide.reason}`]
      : []),
    ...(runnerSide.kind === "wrong-row"
      ? [`runner (${runner}): ${runnerSide.reason}`]
      : []),
  ];
  if (wrongRow.length > 0) {
    return row(
      "undecidable",
      `${label(artifact)}: ${wrongRow.join("; ")} — there is no version to compare on that side`,
    );
  }

  if (sourceSide.kind !== "read" || runnerSide.kind !== "read") {
    // `found` with no record is a shape the port allows. Nothing was digested
    // on that side, so neither "same" nor "different" is a claim this row can
    // make.
    const blind = [
      ...(sourceSide.kind !== "read" ? [`source (${source})`] : []),
      ...(runnerSide.kind !== "read" ? [`runner (${runner})`] : []),
    ].join(" and ");
    return row(
      "undecidable",
      `${label(artifact)}: ${blind} reported the row as read but returned nothing to fingerprint, so there is no version to compare on that side`,
    );
  }

  // Delegated decision 2026-09-26 (review W6a H2): compared FIELD BY FIELD.
  // A field read on both sides with different values is a proven difference
  // on its own, and a blind neighbour does not cancel it — `differs` is the
  // more specific, more actionable fact (the same reasoning as
  // `rollUpParity`). Short of that, any unreadable field leaves the row
  // `undecidable`.
  const differing = fields.filter((field) => {
    const a = sourceSide.reads.get(field);
    const b = runnerSide.reads.get(field);
    return a?.ok === true && b?.ok === true && a.text !== b.text;
  });
  const shortOr = (digest: string | undefined) =>
    digest === undefined ? "(not fully readable)" : shortDigest(digest);
  if (differing.length > 0) {
    return row(
      "differs",
      `${label(artifact)}: ${source} ${shortOr(sourceFingerprint)} != ${runner} ${shortOr(runnerFingerprint)} over ${fields.join(", ")}; differing field(s): ${differing.join(", ")}`,
    );
  }

  const unhashable = [
    ...(sourceDigest?.ok === false
      ? [`source (${source}): ${sourceDigest.reason}`]
      : []),
    ...(runnerDigest?.ok === false
      ? [`runner (${runner}): ${runnerDigest.reason}`]
      : []),
  ];
  if (
    unhashable.length > 0 ||
    sourceFingerprint === undefined ||
    runnerFingerprint === undefined
  ) {
    return row(
      "undecidable",
      `${label(artifact)}: ${unhashable.join("; ")} — there is no version to compare on that side`,
    );
  }

  const identical = `identical on ${source} and ${runner} over ${fields.join(", ")} (sha256 ${shortDigest(sourceFingerprint)})`;
  const related = relatedFor(artifact.table);
  if (related !== undefined && typeof reader.readRelated === "function") {
    // Delegated decision 2026-09-30 (wave 14): the related rows are read only
    // once the record's own fields are identical — a row already `differs` or
    // `undecidable` on its fields is not changed by them, and a gate spends
    // no reads it cannot use.
    const verdict = await compareRelated(
      reader,
      related,
      artifact,
      source,
      runner,
      signal,
    );
    if (verdict.kind === "same") {
      return row(
        "match",
        `${label(artifact)}: ${identical}; ${related.label} (${related.table}) identical: ${verdict.summary}`,
      );
    }
    if (verdict.kind === "differs") {
      return row(
        "differs",
        `${label(artifact)}: ${identical}, but its ${related.label} (${related.table}) differ — ${verdict.summary}`,
      );
    }
    return row(
      "undecidable",
      `${label(artifact)}: ${identical}, but its ${related.label} (${related.table}) could not be compared — ${verdict.reason}; not a clean match`,
    );
  }
  const uncompared = uncomparedFor(artifact.table);
  if (uncompared !== undefined) {
    // Delegated decision 2026-09-26 (H2, fail closed): part of this table's
    // behaviour lives in rows this stage does not read, so equal fields are
    // not a clean match.
    return row(
      "undecidable",
      `${label(artifact)}: ${identical}, but ${uncompared} — not a clean match`,
    );
  }
  return row("match", `${label(artifact)}: ${identical}`);
}

type RelatedVerdict =
  | { readonly kind: "same"; readonly summary: string }
  | { readonly kind: "differs"; readonly summary: string }
  | { readonly kind: "undecidable"; readonly reason: string };

/**
 * One side's related rows as a sorted list of `valueField` values, or why
 * there is none. The reader's `complete` is re-checked rather than trusted:
 * every row must name the parent and carry a distinct sys_id, and every value
 * must be a non-blank string — a blank dot-walked name is a role this user
 * cannot read, or a dangling reference, and neither is a value (M4).
 */
function relatedValues(
  read: RelatedRowsRead,
  spec: RelatedSpec,
  parentSysId: string,
): { ok: true; values: string[] } | { ok: false; reason: string } {
  const rows: unknown = read.rows;
  if (read.outcome !== "complete" || !Array.isArray(rows)) {
    return { ok: false, reason: read.detail };
  }
  const values: string[] = [];
  const ids = new Set<string>();
  for (const entry of rows as unknown[]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        ok: false,
        reason: `a row returned is ${describeValue(entry)}, not a record`,
      };
    }
    const row = entry as Readonly<Record<string, unknown>>;
    const parent = unwrap(row[spec.parentField]);
    const id = unwrap(row.sys_id);
    if (parent !== parentSysId || typeof id !== "string" || !isSysId(id)) {
      return {
        ok: false,
        reason: `a row returned does not carry a sys_id and the requested parent ${parentSysId}`,
      };
    }
    if (ids.has(id)) {
      return { ok: false, reason: `row ${id} was returned twice` };
    }
    ids.add(id);
    const value = unwrap(row[spec.valueField]);
    if (typeof value !== "string" || value === "") {
      return {
        ok: false,
        reason: `row ${id} carries no readable ${spec.valueField} (${value === "" ? "blank" : describeValue(value)})`,
      };
    }
    values.push(value);
  }
  // Compared as a SET: an ACL requires any one of its roles, so a role bound
  // twice means what it means once, and must not read as a difference.
  // Code-unit order, not locale order: the comparison must not depend on the
  // machine it runs on.
  const set = [...new Set(values)];
  set.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { ok: true, values: set };
}

function unwrap(value: unknown): unknown {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "value")
    ? (value as { value: unknown }).value
    : value;
}

function describeValue(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : typeof value;
}

function listOf(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : `[${values.join(", ")}]`;
}

async function compareRelated(
  reader: ArtifactReader,
  spec: RelatedSpec,
  artifact: TargetArtifactRef,
  source: string,
  runner: string,
  signal: AbortSignal | undefined,
): Promise<RelatedVerdict> {
  const readRelated = reader.readRelated?.bind(reader);
  if (readRelated === undefined) {
    return { kind: "undecidable", reason: "this reader cannot read them" };
  }
  const request = {
    table: spec.table,
    parentField: spec.parentField,
    parentSysId: artifact.sysId,
    fields: [spec.valueField],
  };
  // A reader that breaks the port's "never throws" promise is a blind read,
  // not a crash of the whole gate.
  const readSide = async (profile: string): Promise<RelatedRowsRead> => {
    if (aborted(signal)) {
      return { outcome: "undecidable", detail: ABORTED_BEFORE_READ };
    }
    try {
      return await readRelated(profile, request, signal);
    } catch (error) {
      return {
        outcome: "undecidable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const sourceSide = relatedValues(
    await readSide(source),
    spec,
    artifact.sysId,
  );
  const runnerSide = relatedValues(
    await readSide(runner),
    spec,
    artifact.sysId,
  );
  if (!sourceSide.ok || !runnerSide.ok) {
    return {
      kind: "undecidable",
      reason: [
        ...(sourceSide.ok ? [] : [`source (${source}): ${sourceSide.reason}`]),
        ...(runnerSide.ok ? [] : [`runner (${runner}): ${runnerSide.reason}`]),
      ].join("; "),
    };
  }
  const a = sourceSide.values;
  const b = runnerSide.values;
  const same = a.length === b.length && a.every((value, i) => value === b[i]);
  return same
    ? { kind: "same", summary: listOf(a) }
    : {
        kind: "differs",
        summary: `${source} ${listOf(a)} != ${runner} ${listOf(b)}`,
      };
}

function build(
  source: string,
  runner: string,
  status: ParityStatus,
  rows: readonly ParityRow[],
  overrides: { summary?: string; sourceHost?: string; runnerHost?: string },
): ParityReport {
  const mismatched = rows.filter((row) => isMismatch(row));
  // The two halves of `isMismatch` fail the preflight for opposite reasons,
  // and the failure line is what an operator acts on. `missing-on-source` says
  // the SOURCE could not show the row — the runner was never the subject — so
  // folding it into "the runner does not carry the tested version" would send
  // someone deploying an artifact whose tested version nobody has read.
  const behindOnRunner = rows.filter(
    (row) => row.outcome === "differs" || row.outcome === "missing-on-runner",
  );
  const goneOnSource = rows.filter(
    (row) => row.outcome === "missing-on-source",
  );
  const undecided = rows.filter((row) => row.outcome === "undecidable");
  const names = (subset: readonly ParityRow[]) =>
    subset.map((row) => label(row.artifact)).join(", ");

  const summary =
    overrides.summary ??
    `${rows.length} artifact(s) compared between ${source} and ${runner}: ` +
      `${rows.length - mismatched.length - undecided.length} match, ` +
      `${mismatched.length} out of parity, ${undecided.length} undecided`;

  return {
    status,
    source,
    runner,
    ...(overrides.sourceHost === undefined
      ? {}
      : { sourceHost: overrides.sourceHost }),
    ...(overrides.runnerHost === undefined
      ? {}
      : { runnerHost: overrides.runnerHost }),
    rows,
    summary,
    // Handed over pre-derived because PLAN routes the two statuses to two
    // different outcomes, and a caller should not have to re-implement this
    // roll-up to find out which one it is holding.
    ...(status === "mismatch"
      ? {
          preflightFailure: [
            ...(behindOnRunner.length > 0
              ? [
                  `the runner (${runner}) does not carry the tested version of ${behindOnRunner.length} artifact(s): ${names(behindOnRunner)}`,
                ]
              : []),
            ...(goneOnSource.length > 0
              ? [
                  `the source (${source}) did not show ${goneOnSource.length} resolved artifact(s), so there is no tested version to compare the runner against: ${names(goneOnSource)}`,
                ]
              : []),
          ].join("; "),
        }
      : {}),
    ...(status === "undecidable"
      ? {
          inconclusive: `parity could not be decided for ${undecided.length} artifact(s) between ${source} and ${runner}: ${names(undecided)}`,
        }
      : {}),
  };
}

/** The report as a human reads it — same shape as `formatDoctorReport`. */
export function formatParityReport(report: ParityReport): string {
  const at = (host: string | undefined) =>
    host === undefined ? "" : ` [${host}]`;
  const lines = [
    `parity: ${report.status} (source=${report.source}${at(report.sourceHost)}, runner=${report.runner}${at(report.runnerHost)})`,
    `  ${report.summary}`,
  ];
  for (const row of report.rows) {
    lines.push(`  [${row.outcome}] ${label(row.artifact)}`);
    lines.push(`      ${row.evidence}`);
  }
  if (report.preflightFailure !== undefined) {
    lines.push(`  PREFLIGHT FAILURE: ${report.preflightFailure}`);
  }
  if (report.inconclusive !== undefined) {
    lines.push(`  INCONCLUSIVE: ${report.inconclusive}`);
  }
  // Said on every report, including the failing ones: ARCH-20 forbids this
  // stage from fixing what it found.
  lines.push("  (parity never deploys source -> runner; that is yours to do)");
  return lines.join("\n");
}
