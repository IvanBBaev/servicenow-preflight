// What `tess run --live` enumerates, and what a table that will not answer
// does to the run.
//
// Delegated decision 2026-09-28 (wave 13): the live run used to enumerate the
// scope adapter's default — `sys_script_include` alone — so a Business Rule or
// a UI Action shipped in the scope under test was invisible to the gate, and a
// 403 on that one table was the whole resolution failing (exit 3). The live
// enumeration now covers every script-bearing table `@tessera/sn-client`
// knows (`scriptsApi.SCRIPT_TYPES`), the same canonical list the impact
// stage's where-used sweep derives `CONSUMER_TABLES` from. Nothing here types
// a table name: a script type added upstream widens the run without an edit.
//
// A wider set is only honest if every table in it either answered or said so.
// The per-table policy, fail-closed:
//
//   * answered in full            → its rows are artifacts, as before.
//   * REFUSED (403, a namespace 404 for this caller, rows ACL-trimmed of their
//     sys_id, a truncated read) → the scope adapter already drops the table
//     out loud as a `warning` note, which `runPipeline` turns into an
//     INCONCLUSIVE verdict (exit 5, never GO). This module additionally
//     records the table and the reason, so the CLI can name them in one line
//     and in the persisted record.
//   * anything else undecidable (no HTTP answer at all, 401, 429, 5xx, a 400
//     on the query, an abort) → a transport/infrastructure fault. Thrown as a
//     `ResolutionFaultError` from the read itself, so the resolve stage fails
//     and the run exits 3 — the pre-widening meaning of "the read broke".
//
// When every table is refused the scope adapter itself raises "nothing could
// be read about the contents of scope" — a fault, exit 3, unchanged: with no
// table answering there is no partial list to be inconclusive about.

import { STANDALONE_SCRIPT_LOOKUP_TABLES } from "@tessera/impact";
import { ResolutionFaultError } from "@tessera/resolvers";
import type {
  RecordReader,
  TableQueryRequest,
  TableRead,
} from "@tessera/resolvers";
import { scriptsApi } from "@tessera/sn-client";

/**
 * Every table `scriptsApi.SCRIPT_TYPES` names, de-duplicated and sorted — the
 * same order the impact sweep reads them in, so the resolver's notes come out
 * in a reproducible order a CI log can be diffed on.
 */
export const LIVE_ARTIFACT_TABLES: readonly string[] = [
  ...new Set(
    Object.values(scriptsApi.SCRIPT_TYPES).map(
      (descriptor) => descriptor.table,
    ),
  ),
].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * The tables the live run's classifying reader watches: every artifact table
 * it enumerates, plus every table the impact lookups read that is not one —
 * today `sys_transform_map`, which the standalone-script lookup reads for a
 * transform script's target table (wave 17). Sorted, de-duplicated.
 *
 * Delegated decision 2026-10-01 (wave 17): the lookup-only tables are WATCHED
 * (a refusal recorded as a `read: "lookup"` refusal, a transport fault thrown
 * as a `ResolutionFaultError`, exit 3) rather than passed through, where a
 * fault would be softened into an unanalyzable transform script (exit 5). They
 * are not ENUMERATED: the scope enumeration reads `LIVE_ARTIFACT_TABLES` only,
 * so watching a table it never reads changes nothing there. Derived from
 * `@tessera/impact`'s own list, so a table the lookup learns to read next is
 * watched without an edit here.
 */
export const LIVE_LOOKUP_TABLES: readonly string[] = Object.freeze(
  [
    ...new Set([...LIVE_ARTIFACT_TABLES, ...STANDALONE_SCRIPT_LOOKUP_TABLES]),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
);

/**
 * One artifact table the live run could not read in full.
 *
 * Delegated decision 2026-09-30 (wave 15): `read` is present — and only ever
 * `"lookup"` — when the refusal came from the impact analysis's own lookup
 * read (the Business Rule lookup of `sys_script`, the UI Action lookup of
 * `sys_ui_action` and `sys_script`, and — wave 16 — the standalone-script
 * lookup of `sysauto_script` / `sys_ws_operation` / `sys_transform_script`
 * and `sys_script_include` — and, wave 17, a transform script's
 * `sys_transform_map` and the `sys_script` rules on its target table) rather
 * than from the scope enumeration. Absent means the enumeration, exactly as every record written
 * before wave 15 reads, so existing consumers of `artifactTablesRefused` keep
 * their meaning. One entry per table: an enumeration refusal is the broader
 * statement and replaces a lookup entry for the same table.
 */
export interface RefusedArtifactTable {
  readonly table: string;
  readonly reason: string;
  readonly read?: "lookup";
}

/**
 * The leading clause `createSnRecordReader` words a 403 with. Deliberately
 * stable upstream (`cli/test/resolve.test.js` matches it). If it ever drifts,
 * a 403 stops matching here and is classified as a fault (exit 3) — the
 * fail-closed direction: still never GO.
 */
const REFUSED_403 = /: read refused \(403\)/;
/** The reader's wording for a namespace 404 ("not a resource … for the connected user"). */
const REFUSED_NAMESPACE =
  /: the table is not a resource on this instance for the connected user/;

/** True for an undecidable read that is a refusal rather than a fault. */
export function isRefusal(read: TableRead): boolean {
  return (
    read.outcome === "undecidable" &&
    (REFUSED_403.test(read.detail) || REFUSED_NAMESPACE.test(read.detail))
  );
}

function hasAddressableSysId(row: Record<string, unknown>): boolean {
  const value = row["sys_id"];
  return typeof value === "string" && value.trim() !== "";
}

export interface ClassifyingReader extends RecordReader {
  /** Tables refused so far, in read order; one entry per table. */
  refused(): readonly RefusedArtifactTable[];
  /**
   * The same classification for the impact analysis's lookup reads, recorded
   * into the same `refused()` list but tagged `read: "lookup"`, so the report
   * does not word a lookup refusal as an incomplete enumeration.
   */
  forLookup(): RecordReader;
}

/**
 * Wraps the scope adapter's reader. Reads of tables outside `tables` (the
 * `sys_scope` lookup) pass through untouched; reads of an artifact table are
 * classified by the policy in the header.
 */
export function createClassifyingReader(
  reader: RecordReader,
  tables: readonly string[] = LIVE_ARTIFACT_TABLES,
): ClassifyingReader {
  const watched = new Set(tables);
  const refused: RefusedArtifactTable[] = [];
  const record = (
    table: string,
    reason: string,
    via: "enumeration" | "lookup",
  ): void => {
    const index = refused.findIndex((entry) => entry.table === table);
    if (index === -1) {
      refused.push(
        via === "lookup" ? { table, reason, read: via } : { table, reason },
      );
    } else if (via === "enumeration" && refused[index]?.read === "lookup") {
      refused[index] = { table, reason };
    }
  };

  const classify = async (
    request: TableQueryRequest,
    via: "enumeration" | "lookup",
  ): Promise<TableRead> => {
    const read = await reader.queryRecords(request);
    if (!watched.has(request.table)) return read;

    if (read.outcome === "undecidable") {
      if (isRefusal(read)) {
        record(request.table, read.detail, via);
        return read;
      }
      // Delegated decision 2026-09-28 (wave 13): not a refusal, so not a
      // statement about what this profile may see — the read broke. Thrown
      // here (the port itself never rejects) so the resolve stage fails and
      // the run keeps its infrastructure-fault exit 3 rather than being
      // softened into an INCONCLUSIVE by the adapter's per-table tolerance.
      throw new ResolutionFaultError(
        `${request.table} could not be ${via === "lookup" ? "read by the impact lookup" : "enumerated"} (transport/infrastructure fault, not a refusal): ${read.detail}`,
      );
    }

    if (read.truncated) {
      record(
        request.table,
        `the read was truncated (${read.truncationReason ?? "reason not reported"}) — ${read.records.length} row(s) returned` +
          (read.total === undefined ? "" : ` of ${read.total}`),
        via,
      );
    } else {
      const trimmed = read.records.filter(
        (row) => !hasAddressableSysId(row),
      ).length;
      if (trimmed > 0) {
        record(
          request.table,
          `${trimmed} row(s) came back with no readable sys_id (ACL-trimmed)`,
          via,
        );
      }
    }
    return read;
  };

  const lookup: RecordReader = {
    profile: reader.profile,
    queryRecords: (request) => classify(request, "lookup"),
  };
  return {
    profile: reader.profile,
    queryRecords: (request) => classify(request, "enumeration"),
    refused: () => [...refused],
    forLookup: () => lookup,
  };
}

/** True for an entry the scope enumeration refused (the untagged default). */
export function isEnumerationRefusal(entry: RefusedArtifactTable): boolean {
  return entry.read !== "lookup";
}

const listRefused = (refused: readonly RefusedArtifactTable[]): string =>
  refused.map((entry) => `${entry.table} (${entry.reason})`).join("; ");

/**
 * The one-line warning the CLI prints when the enumeration refused any
 * artifact table; `undefined` when it refused none (lookup refusals are
 * `formatRefusedLookups`').
 */
export function formatRefusedTables(
  refused: readonly RefusedArtifactTable[],
  enumerated: number = LIVE_ARTIFACT_TABLES.length,
): string | undefined {
  const tables = refused.filter(isEnumerationRefusal);
  if (tables.length === 0) return undefined;
  return (
    `live artifact enumeration is incomplete — ${tables.length} of ${enumerated} table(s) refused, so the verdict cannot be GO: ` +
    listRefused(tables)
  );
}

/**
 * The one-line warning the CLI prints when only the impact analysis's lookup
 * read of a table was refused; `undefined` when there was no such refusal.
 */
export function formatRefusedLookups(
  refused: readonly RefusedArtifactTable[],
): string | undefined {
  const tables = refused.filter((entry) => !isEnumerationRefusal(entry));
  if (tables.length === 0) return undefined;
  return (
    `impact lookup is incomplete — ${tables.length} table(s) refused the impact analysis's lookup read (not the enumeration), so the verdict cannot be GO: ` +
    listRefused(tables)
  );
}
