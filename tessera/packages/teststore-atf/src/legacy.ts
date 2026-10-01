// Legacy ATF rows — discovery and an opt-in, confirmed deletion path for
// Tessera-shaped rows created BEFORE the F2 ownership marker (2026-09-26).
//
// Teardown deletes a namespaced `sys_atf_test` / `sys_atf_test_suite` only
// when its description starts with `runOwnershipMarker(runId)`, and refuses
// the whole run as `not-run-owned` otherwise. Rows a pre-marker store wrote
// therefore can never be torn down: they look Tessera-created by name alone,
// and a name is a probe key, not proof of ownership (F2).
//
// This module does NOT relax that rule. It splits the problem in two:
//
//  * `discoverLegacyAtfRows()` — READ-ONLY. Lists the rows whose `name` fits
//    Tessera's `<runId>:` convention but whose `description` carries no
//    `Tessera run … — ` marker at all, with the detail a human needs to decide
//    (audit stamps, steps, suite links and the class of each linked suite,
//    suite results, and the reasons a deletion would be refused).
//  * `deleteLegacyAtfRows()` — OPT-IN. Deletes only the exact sys_ids the
//    caller confirms, each of which must be a candidate of the report it
//    passes, and re-reads every confirmed row right before the first DELETE:
//    still present, same table, same name as reported, name still in scope,
//    description still marker-less. Anything else refuses the WHOLE call
//    before any DELETE. A pattern alone never selects a row for deletion.
//
// Delegated decision 2026-09-30 (wave 14): this is a library function pair,
// not a store method — it needs neither the projection lock nor a pipeline
// context, and keeping it off `AtfTestStore` keeps core's `TestStore` port
// unchanged. Reversible: a store method can wrap these later.

import {
  asRecord,
  crossCheckRowCount,
  fieldString,
  requestOrFault,
  TestStoreInfrastructureError,
  TestStoreRefusalError,
  type TestStoreHttpClient,
} from "./client.js";
import {
  ATF_STORE_TABLES,
  DEFAULT_MAX_QUERY_PAGES,
  runOwnershipMarker,
  STEP_INPUT_DOCUMENT,
  TERMINAL_SUITE_RESULT_STATUSES,
} from "./store.js";

/** The report's `kind` — a caller passing anything else is refused. */
export const LEGACY_ATF_REPORT_KIND = "tessera.atf-legacy-report/v1";

/**
 * The run-id shape `tess run` mints (`run-<yyyymmdd>t<hhmmss>-<8 hex>`),
 * mirrored from the cli's `MINTED_RUN_ID_PATTERN` (this package must not
 * depend on the cli).
 *
 * Delegated decision 2026-09-30 (wave 14): the separator `t` is matched in
 * either case. The mint was lowercased on 2026-09-25; a pre-marker row is at
 * least as old as the marker, so it may carry the earlier uppercase `T`.
 * Everything else stays exact and lowercase. Reversible by narrowing to `t`.
 */
export const LEGACY_MINTED_RUN_ID_PATTERN = /^run-\d{8}[tT]\d{6}-[0-9a-f]{8}$/;

/**
 * An explicit, operator-supplied run id (e.g. a benchmark's `--run-id`) — the
 * ledger's `RUN_ID_PATTERN`, re-declared (no runtime dependency on the
 * ledger). It excludes every encoded-query metacharacter and `:`.
 */
export const LEGACY_EXPLICIT_RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * A description that starts with this carries SOME run's ownership marker
 * (`runOwnershipMarker` of any run id). Such a row is not legacy.
 */
export const OWNERSHIP_MARKER_STEM = "Tessera run ";

const SYS_ID_PATTERN = /^[0-9a-f]{32}$/;

/** Why a legacy-cleanup call refused (always before any DELETE). */
export type LegacyCleanupRefusalReason =
  /** Empty, duplicated or malformed confirmed sys_ids, a bad report, or a bad run id. */
  | "confirmation"
  /** A confirmed sys_id is not a candidate of the report the caller passed. */
  | "not-in-report"
  /** A confirmed row is gone, renamed, out of scope, or gained a marker. */
  | "row-changed"
  /** A confirmed row's description is empty — unreadable cannot be told from marker-less. */
  | "empty-description"
  /** A confirmed test is linked into a suite that is not also confirmed. */
  | "foreign-link"
  /** A confirmed suite has a result row that is not provably terminal (DEV-17). */
  | "non-terminal"
  /** A read did not reach its end within the page cap — never act on a partial read. */
  | "truncated-read";

/**
 * A refusal of the legacy-cleanup path. It IS a {@link TestStoreRefusalError}
 * (code `"legacy-cleanup-refused"`) so an existing `instanceof` / `code`
 * branch keeps treating it as "declined, nothing deleted"; `reason` narrows it.
 */
export class LegacyCleanupRefusalError extends TestStoreRefusalError {
  declare readonly code: "legacy-cleanup-refused";
  readonly reason: LegacyCleanupRefusalReason;

  constructor(reason: LegacyCleanupRefusalReason, message: string) {
    super("legacy-cleanup-refused", message);
    this.name = "LegacyCleanupRefusalError";
    this.reason = reason;
  }
}

/** Which tables hold candidates — the two teardown gates on the marker. */
export type LegacyAtfTable =
  typeof ATF_STORE_TABLES.test | typeof ATF_STORE_TABLES.suite;

/** Class of a suite a candidate test is linked into. */
export type LegacyLinkedSuiteClass =
  /** Another legacy candidate — deletable together, if both are confirmed. */
  | "candidate"
  /** Carries a run's ownership marker — a live or unswept Tessera run. */
  | "marked"
  /** Neither — a customer's (or another tool's) suite. */
  | "foreign"
  /** The link names a suite that cannot be read. */
  | "missing";

export interface LegacyAtfLink {
  readonly sysId: string;
  readonly suiteSysId: string;
  readonly testSysId: string;
  /** For a test candidate's link: the class of the linking suite. */
  readonly suiteClass?: LegacyLinkedSuiteClass;
}

export interface LegacyAtfSuiteResult {
  readonly sysId: string;
  readonly status: string;
  readonly terminal: boolean;
}

/** One candidate row, with enough context for a human to decide. */
export interface LegacyAtfCandidate {
  readonly table: LegacyAtfTable;
  readonly sysId: string;
  readonly name: string;
  /** The run id parsed from the `<runId>:` name prefix. */
  readonly runId: string;
  /** How the name matched: the minted shape, or an explicit run id. */
  readonly matchedBy: "minted-run-id" | "explicit-run-id";
  readonly description: string;
  readonly createdOn: string;
  readonly createdBy: string;
  readonly updatedOn: string;
  /** Test candidates: `sys_atf_step` rows hanging off the test. */
  readonly steps: number;
  /** Test candidates: their steps' `sys_variable_value` input rows. */
  readonly stepInputs: number;
  /** Test: links INTO suites. Suite: links to its tests. */
  readonly links: readonly LegacyAtfLink[];
  /** Suite candidates: `sys_atf_test_suite_result` rows (evidence; never deleted). */
  readonly suiteResults: readonly LegacyAtfSuiteResult[];
  /**
   * Why `deleteLegacyAtfRows` would refuse this row as things stand (empty =
   * none known). Informational: deletion re-checks everything itself.
   */
  readonly blockers: readonly string[];
}

/** A row in scope by name that carries ANOTHER run's marker — not legacy. */
export interface LegacyAtfConflict {
  readonly table: LegacyAtfTable;
  readonly sysId: string;
  readonly name: string;
  readonly runId: string;
  readonly description: string;
}

export interface LegacyAtfScope {
  /** Always true: names under a minted-shape run id are in scope. */
  readonly mintedRunIds: true;
  /** Explicit run ids also in scope (validated, deduplicated, sorted). */
  readonly runIds: readonly string[];
}

export interface LegacyAtfReport {
  readonly kind: typeof LEGACY_ATF_REPORT_KIND;
  readonly scope: LegacyAtfScope;
  readonly candidates: readonly LegacyAtfCandidate[];
  readonly conflicts: readonly LegacyAtfConflict[];
}

export interface LegacyAtfReadOptions {
  readonly client: TestStoreHttpClient;
  /** Rows per page. Default 200. */
  readonly pageSize?: number;
  /** Page cap per query; reaching it refuses (`truncated-read`). Default {@link DEFAULT_MAX_QUERY_PAGES}. */
  readonly maxQueryPages?: number;
}

export interface DiscoverLegacyAtfOptions extends LegacyAtfReadOptions {
  /**
   * Operator-chosen run ids whose `<runId>:` namespace is also in scope, on
   * top of the minted shape. Each must match
   * {@link LEGACY_EXPLICIT_RUN_ID_PATTERN}; anything else refuses.
   */
  readonly runIds?: readonly string[];
}

export interface DeleteLegacyAtfOptions extends LegacyAtfReadOptions {
  /** The report the human reviewed — from {@link discoverLegacyAtfRows}. */
  readonly report: LegacyAtfReport;
  /** The exact sys_ids the human confirmed; every one must be a report candidate. */
  readonly confirmedSysIds: readonly string[];
}

export interface LegacyAtfDeletion {
  readonly table: string;
  readonly sysId: string;
}

export interface LegacyAtfDeleteResult {
  /** Every DELETE issued, in order (DEV-13: links, inputs, steps, tests, suites). */
  readonly deleted: readonly LegacyAtfDeletion[];
}

type Row = Record<string, unknown>;

const ROW_FIELDS = [
  "sys_id",
  "name",
  "description",
  "sys_created_on",
  "sys_created_by",
  "sys_updated_on",
] as const;

const refuse = (
  reason: LegacyCleanupRefusalReason,
  message: string,
): LegacyCleanupRefusalError =>
  new LegacyCleanupRefusalError(reason, `${message} (nothing was deleted)`);

function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(
      `legacy ATF cleanup: ${name} must be a positive integer (got ${String(value)})`,
    );
  }
  return value;
}

/** Paged, ACL-trim-tolerant, never-truncating read — the store's `queryAll` rules. */
function createReader(options: LegacyAtfReadOptions) {
  const { client } = options;
  const pageSize = positiveInt("pageSize", options.pageSize ?? 200);
  const maxPages = positiveInt(
    "maxQueryPages",
    options.maxQueryPages ?? DEFAULT_MAX_QUERY_PAGES,
  );
  return async (
    table: string,
    query: string,
    fields: readonly string[],
  ): Promise<Row[]> => {
    const rows: Row[] = [];
    for (let page = 0, offset = 0; ; page += 1, offset += pageSize) {
      if (page >= maxPages) {
        throw refuse(
          "truncated-read",
          `refusing: GET ${table} (${query}) was still not exhausted after ${maxPages} page(s) of ${pageSize} — a partial read cannot show which rows are legacy`,
        );
      }
      const params = new URLSearchParams({
        sysparm_query: `${query}^ORDERBYsys_id`,
        sysparm_fields: fields.join(","),
        sysparm_limit: String(pageSize),
        sysparm_offset: String(offset),
        sysparm_exclude_reference_link: "true",
      });
      const response = await requestOrFault<unknown>(
        client,
        { method: "GET", path: `/api/now/table/${table}`, params },
        `GET ${table} (${query})`,
      );
      const result = asRecord(response.data)?.["result"];
      if (!Array.isArray(result)) {
        throw new TestStoreInfrastructureError(
          `GET ${table}: response carried no { result } list`,
        );
      }
      for (const entry of result) {
        const row = asRecord(entry);
        if (row !== undefined) rows.push(row);
      }
      const total = response.total;
      if (typeof total === "number" && Number.isFinite(total)) {
        if (offset + pageSize >= total) return rows;
      } else if (result.length === 0) {
        // Wave 16: the store's rule — one Stats count must confirm the end
        // of a read without a total; otherwise refuse as a truncated read.
        const checked = await crossCheckRowCount(
          client,
          table,
          query,
          rows.length,
        );
        if (checked.kind === "complete") return rows;
        if (checked.kind === "count-mismatch") {
          throw refuse(
            "truncated-read",
            `refusing: GET ${table} (${query}): the Stats API counted ${checked.count} row(s) but the Table API returned ${rows.length} with no X-Total-Count (count-mismatch) — a partial read cannot show which rows are legacy`,
          );
        }
        // Delegated decision 2026-09-30 (wave 16): an unavailable count is
        // the same `truncated-read` refusal (not a transport fault) — the
        // read itself succeeded, only its completeness is unproven.
        throw refuse(
          "truncated-read",
          `refusing: GET ${table} (${query}) came back with no X-Total-Count and the Stats API count that would confirm the end of the read is unavailable (count-unavailable: ${checked.error.message}) — a partial read cannot show which rows are legacy`,
        );
      }
    }
  };
}

type Reader = ReturnType<typeof createReader>;

function validateRunIds(runIds: readonly unknown[] | undefined): string[] {
  const out = new Set<string>();
  for (const runId of runIds ?? []) {
    if (
      typeof runId !== "string" ||
      !LEGACY_EXPLICIT_RUN_ID_PATTERN.test(runId)
    ) {
      throw refuse(
        "confirmation",
        `refusing: explicit run id ${JSON.stringify(runId)} does not match ${LEGACY_EXPLICIT_RUN_ID_PATTERN.source}`,
      );
    }
    out.add(runId);
  }
  return [...out].sort();
}

/**
 * The run id a name falls under in `scope`, or undefined. Case-SENSITIVE:
 * ServiceNow's `STARTSWITH` is not, so the server query is only a pre-filter.
 */
function scopeMatch(
  name: string,
  runIds: readonly string[],
): { runId: string; matchedBy: LegacyAtfCandidate["matchedBy"] } | undefined {
  const colon = name.indexOf(":");
  if (colon <= 0) return undefined;
  const runId = name.slice(0, colon);
  if (LEGACY_MINTED_RUN_ID_PATTERN.test(runId)) {
    return { runId, matchedBy: "minted-run-id" };
  }
  if (runIds.includes(runId)) return { runId, matchedBy: "explicit-run-id" };
  return undefined;
}

const carriesMarker = (description: string): boolean =>
  description.startsWith(OWNERSHIP_MARKER_STEM);

const inList = (ids: readonly string[]): string => ids.join(",");

const ids = (rows: readonly Row[]): string[] =>
  rows.map((row) => fieldString(row, "sys_id")).filter((id) => id !== "");

/** Rows of `table` in scope by name (server pre-filter + exact client filter). */
async function scopedRows(
  read: Reader,
  table: LegacyAtfTable,
  runIds: readonly string[],
): Promise<
  Array<{ row: Row; match: NonNullable<ReturnType<typeof scopeMatch>> }>
> {
  const byId = new Map<string, Row>();
  // `run-` covers every minted-shape id; explicit ids get their own probe.
  const prefixes = ["run-", ...runIds.map((runId) => `${runId}:`)];
  for (const prefix of prefixes) {
    for (const row of await read(
      table,
      `nameSTARTSWITH${prefix}`,
      ROW_FIELDS,
    )) {
      const id = fieldString(row, "sys_id");
      if (id !== "") byId.set(id, row);
    }
  }
  const out: Array<{
    row: Row;
    match: NonNullable<ReturnType<typeof scopeMatch>>;
  }> = [];
  for (const row of byId.values()) {
    const match = scopeMatch(fieldString(row, "name"), runIds);
    if (match !== undefined) out.push({ row, match });
  }
  return out.sort((a, b) =>
    fieldString(a.row, "sys_id").localeCompare(fieldString(b.row, "sys_id")),
  );
}

const isTerminal = (status: string): boolean =>
  TERMINAL_SUITE_RESULT_STATUSES.has(status.toLowerCase());

/**
 * READ-ONLY discovery of legacy ATF rows: `sys_atf_test` / `sys_atf_test_suite`
 * rows whose name is `<runId>:…` for a minted-shape run id (or one of
 * `options.runIds`) and whose description carries no ownership marker of any
 * run. Issues GETs only. A read that does not reach its end refuses
 * (`truncated-read`) rather than returning a partial report.
 */
export async function discoverLegacyAtfRows(
  options: DiscoverLegacyAtfOptions,
): Promise<LegacyAtfReport> {
  const runIds = validateRunIds(options.runIds);
  const read = createReader(options);

  const candidates: LegacyAtfCandidate[] = [];
  const conflicts: LegacyAtfConflict[] = [];
  const found: Record<
    LegacyAtfTable,
    Array<{
      row: Row;
      runId: string;
      matchedBy: LegacyAtfCandidate["matchedBy"];
    }>
  > = {
    [ATF_STORE_TABLES.test]: [],
    [ATF_STORE_TABLES.suite]: [],
  };

  for (const table of [
    ATF_STORE_TABLES.test,
    ATF_STORE_TABLES.suite,
  ] as const) {
    for (const { row, match } of await scopedRows(read, table, runIds)) {
      const description = fieldString(row, "description");
      if (carriesMarker(description)) {
        if (!description.startsWith(runOwnershipMarker(match.runId))) {
          conflicts.push({
            table,
            sysId: fieldString(row, "sys_id"),
            name: fieldString(row, "name"),
            runId: match.runId,
            description,
          });
        }
        continue;
      }
      found[table].push({ row, ...match });
    }
  }

  const testIds = ids(found[ATF_STORE_TABLES.test].map((entry) => entry.row));
  const suiteIds = ids(found[ATF_STORE_TABLES.suite].map((entry) => entry.row));
  const candidateSuites = new Set(suiteIds);

  const linkFields = ["sys_id", "test_suite", "test"];
  const testLinks =
    testIds.length === 0
      ? []
      : await read(
          ATF_STORE_TABLES.suiteTest,
          `testIN${inList(testIds)}`,
          linkFields,
        );
  const suiteLinks =
    suiteIds.length === 0
      ? []
      : await read(
          ATF_STORE_TABLES.suiteTest,
          `test_suiteIN${inList(suiteIds)}`,
          linkFields,
        );

  // Classify every suite a candidate test is linked into.
  const linkedSuiteIds = [
    ...new Set(
      testLinks
        .map((row) => fieldString(row, "test_suite"))
        .filter((id) => id !== "" && !candidateSuites.has(id)),
    ),
  ];
  const suiteClass = new Map<string, LegacyLinkedSuiteClass>();
  for (const id of suiteIds) suiteClass.set(id, "candidate");
  if (linkedSuiteIds.length > 0) {
    for (const row of await read(
      ATF_STORE_TABLES.suite,
      `sys_idIN${inList(linkedSuiteIds)}`,
      ["sys_id", "description"],
    )) {
      suiteClass.set(
        fieldString(row, "sys_id"),
        carriesMarker(fieldString(row, "description")) ? "marked" : "foreign",
      );
    }
  }

  const steps =
    testIds.length === 0
      ? []
      : await read(ATF_STORE_TABLES.step, `testIN${inList(testIds)}`, [
          "sys_id",
          "test",
        ]);
  const stepIds = ids(steps);
  const inputs =
    stepIds.length === 0
      ? []
      : await read(
          ATF_STORE_TABLES.stepInput,
          `document=${STEP_INPUT_DOCUMENT}^document_keyIN${inList(stepIds)}`,
          ["sys_id", "document_key"],
        );
  const results =
    suiteIds.length === 0
      ? []
      : await read(
          ATF_STORE_TABLES.suiteResult,
          `test_suiteIN${inList(suiteIds)}`,
          ["sys_id", "test_suite", "status"],
        );

  const base = (
    table: LegacyAtfTable,
    entry: {
      row: Row;
      runId: string;
      matchedBy: LegacyAtfCandidate["matchedBy"];
    },
  ) => ({
    table,
    sysId: fieldString(entry.row, "sys_id"),
    name: fieldString(entry.row, "name"),
    runId: entry.runId,
    matchedBy: entry.matchedBy,
    description: fieldString(entry.row, "description"),
    createdOn: fieldString(entry.row, "sys_created_on"),
    createdBy: fieldString(entry.row, "sys_created_by"),
    updatedOn: fieldString(entry.row, "sys_updated_on"),
  });

  const emptyBlocker =
    "description is empty — an unreadable field cannot be told from a marker-less one; deletion refuses it (clean up by hand)";

  for (const entry of found[ATF_STORE_TABLES.test]) {
    const head = base(ATF_STORE_TABLES.test, entry);
    const own = steps.filter((row) => fieldString(row, "test") === head.sysId);
    const ownIds = new Set(ids(own));
    const links = testLinks
      .filter((row) => fieldString(row, "test") === head.sysId)
      .map((row): LegacyAtfLink => {
        const suite = fieldString(row, "test_suite");
        return {
          sysId: fieldString(row, "sys_id"),
          suiteSysId: suite,
          testSysId: head.sysId,
          suiteClass: suiteClass.get(suite) ?? "missing",
        };
      });
    const blockers: string[] = [];
    if (head.description === "") blockers.push(emptyBlocker);
    for (const link of links) {
      if (link.suiteClass === "candidate") {
        blockers.push(
          `linked into legacy suite ${link.suiteSysId} (link ${link.sysId}) — confirm that suite too, or deletion refuses`,
        );
      } else {
        blockers.push(
          `linked into ${link.suiteClass} suite ${link.suiteSysId} (link ${link.sysId}) — deletion refuses; unlink it by hand first`,
        );
      }
    }
    candidates.push({
      ...head,
      steps: own.length,
      stepInputs: inputs.filter((row) =>
        ownIds.has(fieldString(row, "document_key")),
      ).length,
      links,
      suiteResults: [],
      blockers,
    });
  }

  for (const entry of found[ATF_STORE_TABLES.suite]) {
    const head = base(ATF_STORE_TABLES.suite, entry);
    const suiteResults = results
      .filter((row) => fieldString(row, "test_suite") === head.sysId)
      .map((row) => {
        const status = fieldString(row, "status");
        return {
          sysId: fieldString(row, "sys_id"),
          status,
          terminal: isTerminal(status),
        };
      });
    const blockers: string[] = [];
    if (head.description === "") blockers.push(emptyBlocker);
    for (const result of suiteResults) {
      if (!result.terminal) {
        blockers.push(
          `suite result ${result.sysId} reads status "${result.status}", not provably terminal (DEV-17) — deletion refuses`,
        );
      }
    }
    candidates.push({
      ...head,
      steps: 0,
      stepInputs: 0,
      links: suiteLinks
        .filter((row) => fieldString(row, "test_suite") === head.sysId)
        .map((row) => ({
          sysId: fieldString(row, "sys_id"),
          suiteSysId: head.sysId,
          testSysId: fieldString(row, "test"),
        })),
      suiteResults,
      blockers,
    });
  }

  return {
    kind: LEGACY_ATF_REPORT_KIND,
    scope: { mintedRunIds: true, runIds },
    candidates,
    conflicts,
  };
}

/**
 * OPT-IN deletion of legacy ATF rows the caller confirmed by exact sys_id.
 *
 * Refuses the WHOLE call, before any DELETE, when: the confirmation list is
 * empty, duplicated or malformed; a confirmed sys_id is not a candidate of
 * `report`; a fresh read of a confirmed row finds it gone, renamed, out of
 * the report's scope, carrying a marker, or with an empty description; a
 * confirmed test is linked into a suite that is not also confirmed; a
 * confirmed suite has a non-terminal result; or any read is truncated.
 *
 * Deletes, in DEV-13 order: suite→test links hanging off the confirmed rows,
 * the confirmed tests' step inputs and steps (owned by derivation, as in
 * teardown), the confirmed tests, then the confirmed suites. Suite results
 * stay (evidence). A 404 on DELETE counts as already gone.
 */
export async function deleteLegacyAtfRows(
  options: DeleteLegacyAtfOptions,
): Promise<LegacyAtfDeleteResult> {
  const { report, client } = options;
  const read = createReader(options);

  // --- 1. The confirmation itself (no I/O) --------------------------------
  const reportRecord = asRecord(report);
  if (
    reportRecord === undefined ||
    reportRecord["kind"] !== LEGACY_ATF_REPORT_KIND ||
    !Array.isArray(reportRecord["candidates"])
  ) {
    throw refuse(
      "confirmation",
      `refusing: the report is not a ${LEGACY_ATF_REPORT_KIND} from discoverLegacyAtfRows()`,
    );
  }
  const runIds = validateRunIds(report.scope?.runIds);
  const confirmed: unknown = options.confirmedSysIds;
  if (!Array.isArray(confirmed) || confirmed.length === 0) {
    throw refuse(
      "confirmation",
      "refusing: no sys_ids were confirmed — deletion never selects rows by pattern",
    );
  }
  const seen = new Set<string>();
  for (const id of confirmed as unknown[]) {
    if (typeof id !== "string" || !SYS_ID_PATTERN.test(id)) {
      throw refuse(
        "confirmation",
        `refusing: confirmed sys_id ${JSON.stringify(id)} is not 32 lowercase hex characters`,
      );
    }
    if (seen.has(id)) {
      throw refuse("confirmation", `refusing: sys_id ${id} is confirmed twice`);
    }
    seen.add(id);
  }
  const reported = new Map<string, LegacyAtfCandidate>();
  for (const candidate of report.candidates) {
    reported.set(candidate.sysId, candidate);
  }
  const chosen: LegacyAtfCandidate[] = [];
  const notInReport: string[] = [];
  for (const id of seen) {
    const candidate = reported.get(id);
    if (candidate === undefined) notInReport.push(id);
    else chosen.push(candidate);
  }
  if (notInReport.length > 0) {
    throw refuse(
      "not-in-report",
      `refusing: ${notInReport.length} confirmed sys_id(s) are not candidates of the report: ${inList(notInReport)}`,
    );
  }
  for (const candidate of chosen) {
    if (
      candidate.table !== ATF_STORE_TABLES.test &&
      candidate.table !== ATF_STORE_TABLES.suite
    ) {
      throw refuse(
        "confirmation",
        `refusing: report candidate ${candidate.sysId} names table ${JSON.stringify(candidate.table)}`,
      );
    }
  }
  const tests = chosen
    .filter((c) => c.table === ATF_STORE_TABLES.test)
    .map((c) => c.sysId);
  const suites = chosen
    .filter((c) => c.table === ATF_STORE_TABLES.suite)
    .map((c) => c.sysId);
  const confirmedSuites = new Set(suites);

  // --- 2. Re-verify every confirmed row, fresh ---------------------------
  const changed: string[] = [];
  for (const [table, wanted] of [
    [ATF_STORE_TABLES.test, tests],
    [ATF_STORE_TABLES.suite, suites],
  ] as const) {
    if (wanted.length === 0) continue;
    const live = new Map<string, Row>();
    for (const row of await read(table, `sys_idIN${inList(wanted)}`, [
      "sys_id",
      "name",
      "description",
    ])) {
      live.set(fieldString(row, "sys_id"), row);
    }
    for (const id of wanted) {
      const candidate = reported.get(id) as LegacyAtfCandidate;
      const row = live.get(id);
      if (row === undefined) {
        changed.push(`${table} ${id} is no longer readable`);
        continue;
      }
      const name = fieldString(row, "name");
      const description = fieldString(row, "description");
      if (name !== candidate.name) {
        changed.push(
          `${table} ${id} is now named ${JSON.stringify(name)}, not ${JSON.stringify(candidate.name)} as reported`,
        );
      } else if (scopeMatch(name, runIds) === undefined) {
        changed.push(
          `${table} ${id} (${JSON.stringify(name)}) does not fit the report's naming scope`,
        );
      } else if (carriesMarker(description)) {
        changed.push(
          `${table} ${id} (${JSON.stringify(name)}) now carries an ownership marker — it is not legacy; tear its run down instead`,
        );
      } else if (description === "") {
        throw refuse(
          "empty-description",
          `refusing: ${table} ${id} (${JSON.stringify(name)}) has an empty description — an unreadable field cannot be told from a marker-less one; clean it up by hand`,
        );
      }
    }
  }
  if (changed.length > 0) {
    throw refuse(
      "row-changed",
      `refusing: ${changed.length} confirmed row(s) changed since the report — ${changed.join("; ")}; re-run discovery and confirm again`,
    );
  }

  // --- 3. Fresh dependencies; every link must hang off a confirmed suite --
  const linkFields = ["sys_id", "test_suite", "test"];
  const links = new Map<string, Row>();
  if (tests.length > 0) {
    for (const row of await read(
      ATF_STORE_TABLES.suiteTest,
      `testIN${inList(tests)}`,
      linkFields,
    )) {
      links.set(fieldString(row, "sys_id"), row);
    }
  }
  if (suites.length > 0) {
    for (const row of await read(
      ATF_STORE_TABLES.suiteTest,
      `test_suiteIN${inList(suites)}`,
      linkFields,
    )) {
      links.set(fieldString(row, "sys_id"), row);
    }
  }
  links.delete("");
  const foreign: string[] = [];
  for (const [id, row] of links) {
    const suite = fieldString(row, "test_suite");
    if (!confirmedSuites.has(suite)) {
      foreign.push(
        `${ATF_STORE_TABLES.suiteTest} ${id} links confirmed test ${fieldString(row, "test")} into suite ${suite === "" ? "(none)" : suite}, which is not confirmed`,
      );
    }
  }
  if (foreign.length > 0) {
    throw refuse(
      "foreign-link",
      `refusing: ${foreign.join("; ")} — deleting would edit a suite nobody confirmed`,
    );
  }

  // DEV-17: never delete a suite with a result that is not provably terminal.
  //
  // Delegated decision 2026-09-30 (wave 14): a confirmed legacy suite with NO
  // result row is deletable. Teardown refuses that state because a trigger
  // seconds old looks identical; a legacy row predates the marker (2026-09-26)
  // and the human confirmed it by sys_id after seeing its audit stamps and
  // result list in the report. Reversible: require `neverTriggered`-style
  // assertion here if that proves too loose.
  if (suites.length > 0) {
    for (const row of await read(
      ATF_STORE_TABLES.suiteResult,
      `test_suiteIN${inList(suites)}`,
      ["sys_id", "status"],
    )) {
      const status = fieldString(row, "status");
      if (!isTerminal(status)) {
        throw refuse(
          "non-terminal",
          `refusing: ${ATF_STORE_TABLES.suiteResult} ${fieldString(row, "sys_id")} reads status "${status}", which is not provably terminal (DEV-17)`,
        );
      }
    }
  }

  const stepIds =
    tests.length === 0
      ? []
      : ids(
          await read(ATF_STORE_TABLES.step, `testIN${inList(tests)}`, [
            "sys_id",
          ]),
        );
  const inputIds =
    stepIds.length === 0
      ? []
      : ids(
          await read(
            ATF_STORE_TABLES.stepInput,
            `document=${STEP_INPUT_DOCUMENT}^document_keyIN${inList(stepIds)}`,
            ["sys_id"],
          ),
        );

  // --- 4. Delete, DEV-13 order -------------------------------------------
  const deleted: LegacyAtfDeletion[] = [];
  const remove = async (table: string, sysId: string): Promise<void> => {
    try {
      await requestOrFault<unknown>(
        client,
        {
          method: "DELETE",
          path: `/api/now/table/${table}/${encodeURIComponent(sysId)}`,
        },
        `DELETE ${table}/${sysId}`,
      );
    } catch (error) {
      if (!(
        error instanceof TestStoreInfrastructureError && error.status === 404
      )) {
        throw error;
      }
    }
    deleted.push({ table, sysId });
  };
  for (const id of links.keys()) await remove(ATF_STORE_TABLES.suiteTest, id);
  for (const id of inputIds) await remove(ATF_STORE_TABLES.stepInput, id);
  for (const id of stepIds) await remove(ATF_STORE_TABLES.step, id);
  for (const id of tests) await remove(ATF_STORE_TABLES.test, id);
  for (const id of suites) await remove(ATF_STORE_TABLES.suite, id);
  return { deleted };
}
