// The scope adapter — "everything this application ships" (ARCH-5, PLAN Phase 2).
//
// This is the coarsest of ARCH-5's three inputs and the only one that answers
// without a story or an update set to hang off, which makes it the fallback the
// CLI reaches for when nothing else names the change. It is also the easiest
// place in the pipeline to manufacture a green: the enumeration is one query per
// table, and a query that was refused renders exactly like an application that
// contains nothing. Every branch below exists to keep those two apart (QA-9),
// which is why an adapter this small still ends up with a report attached.
//
// The other half of the split is DEV-1's: "that scope does not exist" is a fact
// the instance stated and the user fixes by typing a different argument, while
// "I could not read sys_scope" is an absence of evidence. The first throws
// `ResolutionInputError`, the second `ResolutionFaultError`, and neither is ever
// allowed to become an empty artifact list.

import type {
  AffectedArtifact,
  PipelineContext,
  TargetArtifactRef,
  TargetInput,
} from "@tessera/types";

import { ResolutionFaultError, ResolutionInputError } from "./errors.js";
import { artifactKey, assertQueryValue, isSysId, isTableName } from "./keys.js";
import { describeReadTruncation } from "./read.js";
import type { RecordReader, SnRecord } from "./read.js";
import { completeArtifacts } from "./types.js";
import type {
  ResolutionLevel,
  ResolutionNote,
  ResolutionReport,
  SourceResolver,
} from "./types.js";

/**
 * DESIGN §12.3 row 3 pins the MVP impact surface to Script Includes: they are
 * the artifacts the Phase-6 generator can actually write a test for, so
 * enumerating more tables now would only grow the checklist with rows nothing
 * downstream can satisfy. The option exists so a later phase widens the surface
 * by passing a longer list rather than by editing this file.
 */
export const DEFAULT_ARTIFACT_TABLES: readonly string[] = [
  "sys_script_include",
];

export interface ScopeResolverOptions {
  readonly artifactTables?: readonly string[];
}

const SCOPE_TABLE = "sys_scope";

/**
 * Identity only. TM-1 wants untrusted free text branded where it is ingested,
 * and the way this package satisfies that is by never reading any: `scope` and
 * `name` are the labels a human uses to address a row, not prose that travels
 * on to the generator.
 */
const SCOPE_FIELDS: readonly string[] = ["sys_id", "scope", "name"];
// `sys_scope` is read back so every row can be checked against the filter that
// asked for it (M2, in the enumeration loop).
const ARTIFACT_FIELDS: readonly string[] = ["sys_id", "name", "sys_scope"];

/**
 * The Table API renders every field as a string, so anything else here is a
 * row that cannot supply the value — same treatment as an absent one. Trimming
 * matters because a field the instance returns as whitespace is not a name.
 */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function note(level: ResolutionLevel, message: string): ResolutionNote {
  return { source: "scope", level, message };
}

/**
 * Blank and duplicated entries are dropped once, at construction. A repeated
 * table would otherwise cost a second identical read and emit a second count
 * note for rows the de-duplication immediately discards — noise that reads like
 * a real second source.
 */
function normalizeTables(tables: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tables) {
    const table = text(raw);
    if (table === undefined || seen.has(table)) continue;
    seen.add(table);
    out.push(table);
  }
  return out;
}

/** How a row identifies itself in a message, in descending order of use. */
function scopeLabel(row: SnRecord, fallback: string): string {
  return text(row["scope"]) ?? text(row["name"]) ?? fallback;
}

/** A scope row reduced to what anything downstream can address it by. */
export interface ScopeIdentity {
  readonly sysId: string;
  /** How the row calls itself — for messages, never for a query. */
  readonly label: string;
}

/**
 * The one read that turns `--scope <something>` into a row identity.
 *
 * Module-level and exported rather than closed over the resolver, because the
 * ImpactAnalyzer needs the same answer for the same flag: its where-used search
 * is confined to a single scope (DESIGN §12.3 row 3) and confines it by
 * `sys_scope=<sysId>`. Two copies of this lookup would be two chances to
 * disagree about what `--scope global` means.
 *
 * @throws ResolutionInputError when the instance answered and the argument is
 * wrong (blank, unknown, ambiguous) — the caller fixes it by typing something
 * else. @throws ResolutionFaultError when the read did not complete, which is an
 * absence of evidence and never an absence of scope (DEV-1).
 */
export async function findScopeIdentity(
  reader: RecordReader,
  ctx: PipelineContext,
  scope: string,
): Promise<ScopeIdentity> {
  const wanted = scope.trim();
  if (wanted === "") {
    // A blank `--scope` is usually an env var that expanded to nothing. It is
    // a definite fact about the request rather than about the instance, so it
    // is an input error — and answering it with "no scope was given" would
    // hide the empty variable behind a clean-looking run.
    throw new ResolutionInputError(
      "--scope was given as an empty value; name an application scope (its scope name or its sys_id)",
    );
  }

  // A scope is normally addressed by its scope name (`x_snc_myapp`), and
  // `global` is an ordinary value of that column rather than a special case.
  // `name` is matched too because that is the label the Studio shows.
  const byId = isSysId(wanted);
  assertQueryValue(wanted, "--scope");
  const read = await reader.queryRecords({
    table: SCOPE_TABLE,
    query: byId ? `sys_id=${wanted}` : `scope=${wanted}^ORname=${wanted}`,
    fields: [...SCOPE_FIELDS],
    // Two is all the evidence an ambiguity needs; more would only be rows
    // nobody reads.
    //
    // Delegated decision 2026-10-01 (wave 17): no Stats count here — one
    // page of at most two rows identifying the scope, not an enumeration; an
    // empty answer is already refused naming ACL trimming, and
    // `crossCheckCount` only acts on a `fetchAll` read.
    limit: 2,
    signal: ctx.signal,
  });

  if (read.outcome === "undecidable") {
    throw new ResolutionFaultError(
      `could not read ${SCOPE_TABLE} to resolve \`${wanted}\`: ${read.detail}`,
    );
  }

  const [row, second] = read.records;
  if (row === undefined) {
    // The instance answered — and an empty answer from the Table API is the
    // same shape whether the scope is not installed or is simply trimmed from
    // this caller. Naming only the first reading tells an operator to install
    // an application that may already be sitting there, unreadable.
    throw new ResolutionInputError(
      `no application scope ${byId ? "with sys_id" : "named"} \`${wanted}\` on the source instance (${reader.profile}) — ` +
        `the instance answered with no matching row, which is either a scope ` +
        `that is not there or one this profile cannot read`,
    );
  }
  if (second !== undefined) {
    // Picking the first would silently enumerate a different application than
    // the one the caller meant, and the run would look perfectly healthy.
    const candidates = read.records
      .map((candidate, index) => scopeLabel(candidate, `row ${index + 1}`))
      .join(", ");
    throw new ResolutionInputError(
      `\`${wanted}\` matches more than one application scope on the source instance (${candidates}); name the one you mean by its sys_id`,
    );
  }

  const sysId = text(row["sys_id"]);
  if (sysId === undefined) {
    // The instance answered with a row but withheld the field that identifies
    // it. Nothing about the scope's contents can be asked from here, so this
    // is a fault, not a statement that the scope is missing.
    throw new ResolutionFaultError(
      `${SCOPE_TABLE} answered for \`${wanted}\` with a row carrying no readable sys_id, so its contents cannot be read`,
    );
  }
  // Delegated decision 2026-09-25: the row must be the scope that was NAMED.
  // The Table API may match looser than byte equality (case-insensitive
  // collation), and a row that answered about another application would
  // enumerate that application under this one's name. A row failing the check
  // is treated as no match (fail closed).
  const named = byId
    ? sysId === wanted
    : text(row["scope"]) === wanted || text(row["name"]) === wanted;
  if (!named) {
    throw new ResolutionInputError(
      `no application scope ${byId ? "with sys_id" : "named"} \`${wanted}\` exactly on the source instance (${reader.profile}) — ` +
        `the instance answered with \`${scopeLabel(row, sysId)}\`, which is not the scope that was named`,
    );
  }
  if (!isSysId(sysId)) {
    // Interpolated into every enumeration query below; a value not shaped
    // like a sys_id is not an address (Delegated decision 2026-09-25).
    throw new ResolutionFaultError(
      `${SCOPE_TABLE} answered for \`${wanted}\` with a sys_id that is not 32 lowercase hex characters (${JSON.stringify(sysId)}), so its contents cannot be read`,
    );
  }
  return { sysId, label: scopeLabel(row, wanted) };
}

export function createScopeResolver(
  reader: RecordReader,
  options: ScopeResolverOptions = {},
): SourceResolver {
  const tables = normalizeTables(
    options.artifactTables ?? DEFAULT_ARTIFACT_TABLES,
  );

  async function resolveWithReport(
    ctx: PipelineContext,
    input: TargetInput,
  ): Promise<ResolutionReport> {
    if (input.scope === undefined) {
      // Not a warning: nothing was asked of this adapter, so nothing about the
      // answer is missing. A warning here would make every story-only run look
      // incomplete and teach the reader to ignore the level that matters.
      return {
        artifacts: [],
        notes: [
          note("info", "no --scope was given, so this adapter read nothing"),
        ],
      };
    }

    // Delegated decision 2026-09-26 (L4): a configured table becomes the
    // `table` of a read, and a table name is never escaped — so its shape is
    // checked before anything is sent. `sys_script^NQactive=true` and friends
    // are refused as an input error (the fix is different configuration),
    // with zero reads. Checked here rather than at construction so a resolver
    // that is never asked about a scope never refuses anything.
    const badTables = tables.filter((table) => !isTableName(table));
    if (badTables.length > 0) {
      throw new ResolutionInputError(
        `artifactTables contains ${badTables.map((t) => JSON.stringify(t)).join(", ")}, ` +
          `which is not a table name (lowercase letters, digits, underscores), ` +
          `so no query was sent`,
      );
    }

    const notes: ResolutionNote[] = [];
    const { sysId: scopeSysId, label } = await findScopeIdentity(
      reader,
      ctx,
      input.scope,
    );
    notes.push(
      note("info", `scope \`${label}\` is ${SCOPE_TABLE}/${scopeSysId}`),
    );

    const artifacts: AffectedArtifact[] = [];
    const seen = new Set<string>();
    const undecided: string[] = [];

    // Sequential on purpose. The note order has to be reproducible for a CI log
    // to be diffable, and a widened table list must not turn into a burst of
    // parallel queries against an instance that is very likely production.
    // Re-checked at the point of use: `findScopeIdentity` is exported, and
    // this id is spliced into `sys_scope=<id>` for every table below
    // (Delegated decision 2026-09-25).
    if (!isSysId(scopeSysId)) {
      throw new ResolutionFaultError(
        `scope \`${label}\` resolved to ${JSON.stringify(scopeSysId)}, which is not a sys_id, so its contents cannot be read`,
      );
    }
    for (const table of tables) {
      const read = await reader.queryRecords({
        table,
        // ORDERBY keeps the paging inside `fetchAll` stable; without it the
        // transport appends its own ORDERBYsys_id, which would order the
        // artifact list by an id no human recognises.
        query: `sys_scope=${scopeSysId}^ORDERBYname`,
        fields: [...ARTIFACT_FIELDS],
        fetchAll: true,
        // Delegated decision 2026-10-01 (wave 17): this read decides the
        // inventory, so it confirms its end with one Stats API count when the
        // instance sends no X-Total-Count. Without it, read ACLs trimming the
        // LAST window read as the end of results and a partial list passed as
        // the whole one (fail open). The cost is one extra GET, and only on a
        // header-less read that otherwise looked complete.
        crossCheckCount: true,
        signal: ctx.signal,
      });

      if (read.outcome === "undecidable") {
        // One failed table does not invalidate the others: the rows another
        // table did return are still true. Recorded and carried on with, so the
        // caller sees both the artifacts and the hole in them.
        undecided.push(read.detail);
        notes.push(
          note(
            "warning",
            `${table} could not be enumerated for scope \`${label}\`: ${read.detail}`,
          ),
        );
        continue;
      }

      if (read.truncated) {
        // QA-9: the read stopped before the full result set, so the list below
        // is part of the application, not the application.
        //
        // Delegated decision 2026-09-26: the clause naming WHY comes from
        // `describeReadTruncation` (the transport's `describeTruncation`),
        // not a sentence that assumed the cap. A short page under a larger
        // X-Total-Count (read ACLs) and a capped read with no X-Total-Count
        // are both partial too, and "raise SN_MAX_RECORDS" is the wrong advice
        // for the first. Only the wording moved: the warning is still pushed
        // for every truncated read, so `isIncomplete` and `resolve()`'s refusal
        // (H1) are exactly as fail-closed as before. A truncated read with no
        // reason (a stub) is worded as partial without a guessed cause.
        notes.push(
          note(
            "warning",
            `${table} enumeration ${describeReadTruncation(read)}, so this is a partial list of scope \`${label}\` — artifacts are missing from it`,
          ),
        );
      }

      // Delegated decision 2026-09-26 (M2): every returned row must belong to
      // the scope that was asked for. The Table API answers an ignored
      // condition as if unfiltered, so a row from another application (or one
      // that does not carry `sys_scope` at all — fail closed) means the whole
      // read is untrustworthy: a fault, not a warning about one row.
      const foreign = read.records.filter(
        (row) => text(row["sys_scope"]) !== scopeSysId,
      );
      if (foreign.length > 0) {
        throw new ResolutionFaultError(
          `${table} answered for scope \`${label}\` with ${foreign.length} row(s) ` +
            `whose sys_scope is not ${scopeSysId} — the instance did not apply ` +
            `the filter it was sent, so none of the answer can be trusted`,
        );
      }

      let kept = 0;
      for (const row of read.records) {
        const sysId = text(row["sys_id"]);
        if (sysId === undefined) {
          // Field-level ACL trimming renders as a row with the field simply
          // absent. Nothing downstream can read, diff or test a row it cannot
          // address, so it is dropped — out loud.
          notes.push(
            note(
              "warning",
              `${table}: skipped a row with no readable sys_id, so it is missing from this list`,
            ),
          );
          continue;
        }
        if (!isSysId(sysId)) {
          // Delegated decision 2026-09-26 (L4): an artifact's sys_id is spliced
          // into later reads (impact, generation), so a value not shaped like
          // one is not an address. Same treatment as an absent one: skipped,
          // out loud.
          notes.push(
            note(
              "warning",
              `${table}: skipped a row whose sys_id ${JSON.stringify(sysId)} is not a valid sys_id (32 lowercase hex characters), so it is missing from this list`,
            ),
          );
          continue;
        }
        const ref: TargetArtifactRef = {
          table,
          sysId,
          // Never an empty label: a checklist row printed as `[  ]` tells a
          // reviewer nothing, and table/sys_id is at least addressable.
          name: text(row["name"]) ?? `${table}/${sysId}`,
        };
        const key = artifactKey(ref);
        // Defensive: one table cannot return the same sys_id twice, but a
        // widened list containing a table and its parent could, and ARCH-5
        // de-duplicates by identity rather than trusting the query.
        if (seen.has(key)) continue;
        seen.add(key);
        artifacts.push({ ref, resolvedBy: "scope" });
        kept += 1;
      }

      notes.push(
        note("info", `${table}: ${kept} artifact(s) in scope \`${label}\``),
      );
    }

    if (tables.length === 0) {
      // Configured with nothing to look at. Returning an empty list silently
      // would be the same silent green as a failed read, so it is a warning
      // even though no read went wrong.
      notes.push(
        note(
          "warning",
          `no artifact tables are configured, so nothing was enumerated for scope \`${label}\``,
        ),
      );
    } else if (undecided.length === tables.length) {
      // Not one table answered. There is no artifact list here to be partially
      // wrong — the contents of the scope are simply unknown, and an empty
      // array would be indistinguishable from an empty application (QA-9).
      throw new ResolutionFaultError(
        `nothing could be read about the contents of scope \`${label}\`: ${undecided.join("; ")}`,
      );
    } else if (artifacts.length === 0) {
      // Delegated decision 2026-09-26 (M3): tables answered and named nothing.
      // The Table API renders "this application has none" and "this profile
      // is not shown them" as the same empty result (OPP-1b), so a scope that
      // resolved to zero artifacts is a warning — the report is incomplete —
      // and never a clean answer a run can pass on.
      notes.push(
        note(
          "warning",
          `scope \`${label}\` resolved to no artifacts in ${tables.join(", ")} — ` +
            `either the application has none there, or this profile ` +
            `(${reader.profile}) cannot read them`,
        ),
      );
    }

    return { artifacts, notes };
  }

  return {
    source: "scope",
    // The port's `resolve` has no notes channel: a complete report's artifacts
    // come back as a copy (so a caller mutating the array cannot reach into the
    // report the CLI is about to print), and an incomplete report throws
    // instead (H1, see `completeArtifacts`).
    resolve: async (ctx: PipelineContext, input: TargetInput) =>
      completeArtifacts(await resolveWithReport(ctx, input), "scope"),
    resolveWithReport,
  };
}
