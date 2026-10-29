import type { Check, CheckResult, CheckStatus, Finding } from "../types.js";
import type { SnClient, TableQueryResult } from "../http/client.js";
import {
  assertIdentifier,
  chunk,
  eq,
  inClause,
  isSafeIdentifier,
  isSysId,
  resolveScope,
} from "../http/query.js";
import {
  errorResult,
  rowFinding,
  str,
  triageZeroRead,
  withFindings,
} from "./cert-common.js";
import { IN_PROGRESS_STATES, SHIPPABLE_STATE } from "./update-set-state.js";

const NAME = "update-set-collisions";

/** Fields of the target `sys_update_set` read (scope path). */
const SET_FIELDS = "sys_id,name,state,application";

/** Fields of the target `sys_update_xml` read: the record keys only. */
const TARGET_XML_FIELDS = "sys_id,name,update_set";

/**
 * Fields of the collision read: the record key plus the owning set's name and
 * state, dot-walked. The record XML (`payload`) is never requested.
 */
const PARTNER_XML_FIELDS =
  "sys_id,name,update_set,update_set.name,update_set.state";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Run one chunked `IN` read over `values`, folding the pages into one
 * {@link TableQueryResult}: rows concatenated, trimmed if any page was, and a
 * pre-trim count only when every page reported one.
 */
async function readChunked(
  http: SnClient,
  table: string,
  field: string,
  values: readonly string[],
  fields: string,
): Promise<TableQueryResult> {
  const rows: Record<string, unknown>[] = [];
  let securityTrimmed = false;
  let totalCount: number | undefined = 0;
  for (const batch of chunk(values)) {
    const page = await http.table(table).queryWithMeta({
      sysparm_query: inClause(field, batch),
      sysparm_fields: fields,
    });
    rows.push(...page.rows);
    securityTrimmed ||= page.securityTrimmed;
    totalCount =
      totalCount === undefined || page.totalCount === undefined
        ? undefined
        : totalCount + page.totalCount;
  }
  return { rows, securityTrimmed, totalCount };
}

/** One other update set that captures some of the target records. */
interface Partner {
  id: string;
  name: string;
  state: string;
  records: Set<string>;
}

/** "<name> (M records)" for each partner, largest first, then by name. */
function describePartners(partners: readonly Partner[]): string {
  return [...partners]
    .sort(
      (a, b) => b.records.size - a.records.size || a.name.localeCompare(b.name),
    )
    .map((p) => `${p.name} (${p.records.size} records)`)
    .join(", ");
}

/** The distinct record keys captured by the given partners. */
function recordsOf(partners: readonly Partner[]): Set<string> {
  const out = new Set<string>();
  for (const p of partners) for (const r of p.records) out.add(r);
  return out;
}

/**
 * Finds records the target update set(s) capture that another update set
 * also captures — on the target instance the last commit wins, so a record
 * shipped by two sets ends up in whichever lands second.
 *
 * Target sets: `ctx.updateSetId` when set, otherwise every `in progress` set
 * of the scope's application. Their `sys_update_xml` record keys (`name`) are
 * looked up across all update sets; a row in a non-target set is a collision.
 * The instance's Default sets (`is_default`) are ignored as collision
 * partners — they collect stray edits, not shipments — and counted.
 *
 * - **fail** — a collision with another `in progress` set, or a read was
 *   security-trimmed.
 * - **warn** — collisions only with completed (or otherwise closed) sets; no
 *   scope and no update set id; no target sets; an ambiguous zero-row read;
 *   or record keys that could not be queried safely.
 * - **pass** — no target record is captured anywhere else.
 *
 * Messages carry update set names and counts only — never record XML.
 */
export const updateSetCollisions: Check = {
  name: NAME,
  description:
    "No record in the target update set(s) is also captured in another update set.",
  meta: {
    requires: "updateSetId or scope",
    summary:
      "Records in the target update set(s) are not also captured in other open or completed update sets.",
    severity: "blocker",
    tables: ["sys_update_set", "sys_update_xml"],
    remediation:
      "For each listed update set, merge it with the target, move the shared records into one set, or back the duplicate change out — otherwise whichever set commits last on the target wins.",
    verdicts: {
      pass: "No target record is captured in any other update set.",
      warn: "Collisions only with completed sets, no scope or update set id, no target sets, an ambiguous read, or record keys that could not be queried safely.",
      fail: "A target record is also captured in another in-progress update set, or a read was security-trimmed.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const updateSetId = ctx.updateSetId?.trim();
    const scope = ctx.scope?.trim();
    if (!updateSetId && !scope) {
      return result(
        "warn",
        "No scope or update set set — skipping the update set collision check (pass a scope or an update set id to enable it).",
      );
    }

    try {
      let trimmed = false;
      const subject = updateSetId
        ? `update set "${updateSetId}"`
        : `the in-progress update sets of scope "${scope}"`;

      // --- 1. The instance's Default sets: never collision partners. ----------
      const defaults = await ctx.http.table("sys_update_set").queryWithMeta({
        sysparm_query: eq("is_default", "true"),
        sysparm_fields: "sys_id,name",
      });
      trimmed ||= defaults.securityTrimmed;
      const defaultIds = new Set(
        defaults.rows.map((r) => str(r, "sys_id")).filter((id) => id !== ""),
      );

      // --- 2. The target sets. ------------------------------------------------
      let targetIds: string[];
      if (updateSetId) {
        targetIds = [assertIdentifier(updateSetId, "updateSetId")];
      } else {
        const resolved = await resolveScope(ctx, scope as string);
        const app =
          resolved.sysId ??
          (isSysId(resolved.input) ? resolved.input : undefined);
        const sets = await ctx.http.table("sys_update_set").queryWithMeta({
          // `state` is filtered client-side: "in progress" carries a space,
          // which the injection-safe builder rightly refuses to emit.
          sysparm_query: app
            ? eq("application", app)
            : eq("application.scope", resolved.input),
          sysparm_fields: SET_FIELDS,
        });
        if (sets.rows.length === 0) {
          switch (triageZeroRead(sets)) {
            case "trimmed":
              return result(
                "fail",
                `Cannot list the update sets of scope "${scope}": ${
                  sets.totalCount ?? "some"
                } match but 0 are visible — the account is security-trimmed. Grant it read access to sys_update_set.`,
              );
            case "empty":
              return result(
                "warn",
                `No update sets in scope "${scope}" — nothing to compare. Pass an update set id to check a specific set.`,
              );
            case "ambiguous":
              return result(
                "warn",
                `No update sets visible in scope "${scope}" and no pre-trim count arrived — cannot confirm the target sets are free of collisions.`,
              );
          }
        }
        trimmed ||= sets.securityTrimmed;
        targetIds = sets.rows
          .filter((r) => IN_PROGRESS_STATES.has(str(r, "state").toLowerCase()))
          .map((r) => str(r, "sys_id"))
          .filter((id) => id !== "" && !defaultIds.has(id));
        if (targetIds.length === 0) {
          return result(
            "warn",
            `No in-progress update set in scope "${scope}" (Default sets excluded) — nothing to compare. Pass an update set id to check a specific set.`,
          );
        }
      }
      const targets = new Set(targetIds);

      // --- 3. The record keys the target sets capture. ------------------------
      const targetXml = await readChunked(
        ctx.http,
        "sys_update_xml",
        "update_set",
        targetIds,
        TARGET_XML_FIELDS,
      );
      if (targetXml.rows.length === 0) {
        switch (triageZeroRead(targetXml)) {
          case "trimmed":
            return result(
              "fail",
              `Cannot read the records of ${subject}: ${
                targetXml.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sys_update_xml.`,
            );
          case "empty":
            if (!trimmed) {
              return result(
                "pass",
                `No record in the target update set(s) is captured anywhere else (${subject} carries no records).`,
              );
            }
            break;
          case "ambiguous":
            return result(
              "warn",
              `No records visible in ${subject} and no pre-trim count arrived — either it is empty, or the account cannot read sys_update_xml. Cannot confirm it is free of collisions.`,
            );
        }
      }
      trimmed ||= targetXml.securityTrimmed;
      const names = [
        ...new Set(
          targetXml.rows.map((r) => str(r, "name")).filter((n) => n !== ""),
        ),
      ];
      const safeNames = names.filter((n) => isSafeIdentifier(n));
      const skipped = names.length - safeNames.length;

      // --- 4. Every capture of those keys, anywhere. --------------------------
      const captures = await readChunked(
        ctx.http,
        "sys_update_xml",
        "name",
        safeNames,
        PARTNER_XML_FIELDS,
      );
      trimmed ||= captures.securityTrimmed;

      const partners = new Map<string, Partner>();
      const defaultHits = new Set<string>();
      const targetRowByName = new Map<string, Record<string, unknown>>();
      for (const row of targetXml.rows) {
        const key = str(row, "name");
        if (key && !targetRowByName.has(key)) targetRowByName.set(key, row);
      }
      for (const row of captures.rows) {
        const setId = str(row, "update_set");
        const key = str(row, "name");
        if (!setId || !key || targets.has(setId)) continue;
        if (defaultIds.has(setId)) {
          defaultHits.add(key);
          continue;
        }
        let partner = partners.get(setId);
        if (!partner) {
          partner = {
            id: setId,
            name: str(row, "update_set.name"),
            state: str(row, "update_set.state").toLowerCase(),
            records: new Set(),
          };
          partners.set(setId, partner);
        }
        partner.records.add(key);
      }

      // Dot-walk fallback: a set whose name or state did not arrive is read
      // by sys_id.
      const missing = [...partners.values()]
        .filter((p) => p.state === "" || p.name === "")
        .map((p) => p.id)
        .filter((id) => isSafeIdentifier(id));
      if (missing.length > 0) {
        const sets = await readChunked(
          ctx.http,
          "sys_update_set",
          "sys_id",
          missing,
          "sys_id,name,state",
        );
        trimmed ||= sets.securityTrimmed;
        for (const row of sets.rows) {
          const partner = partners.get(str(row, "sys_id"));
          if (!partner) continue;
          partner.name ||= str(row, "name");
          partner.state ||= str(row, "state").toLowerCase();
        }
      }
      for (const p of partners.values()) p.name ||= p.id;

      const all = [...partners.values()];
      const open = all.filter((p) => IN_PROGRESS_STATES.has(p.state));
      const closed = all.filter((p) => !IN_PROGRESS_STATES.has(p.state));

      const findings: Finding[] = [];
      const addFindings = (group: readonly Partner[], kind: string): void => {
        for (const key of [...recordsOf(group)].sort()) {
          const row = targetRowByName.get(key) ?? { name: key };
          const others = group
            .filter((p) => p.records.has(key))
            .map((p) => p.name)
            .sort();
          const finding = rowFinding(
            NAME,
            "sys_update_xml",
            row,
            kind,
            "name",
            `${key} (sys_update_xml): ${kind} — also in ${others.join(", ")}`,
          );
          if (kind === "closed-collision") finding.status = "warn";
          findings.push(finding);
        }
      };
      addFindings(open, "open-collision");
      addFindings(closed, "closed-collision");

      const notes: string[] = [];
      if (closed.length > 0) {
        const completed = closed.every((p) => p.state === SHIPPABLE_STATE);
        notes.push(
          `${recordsOf(closed).size} record(s) are already captured in ${
            completed ? "completed" : "closed"
          } update sets: ${describePartners(closed)}.`,
        );
      }
      if (skipped > 0) {
        notes.push(
          `${skipped} update record name(s) could not be queried safely.`,
        );
      }
      if (defaultHits.size > 0) {
        notes.push(
          `${defaultHits.size} record(s) also sit in a Default update set (ignored).`,
        );
      }
      const done = (status: CheckStatus, message: string): CheckResult =>
        withFindings(result(status, message), findings);

      if (open.length > 0) {
        return done(
          "fail",
          [
            `${recordsOf(open).size} record(s) are also captured in other open update sets: ${describePartners(open)}.`,
            ...notes,
            ...(trimmed
              ? [
                  "(Note: a read was security-trimmed, so this list may be incomplete.)",
                ]
              : []),
          ].join(" "),
        );
      }
      if (trimmed) {
        return done(
          "fail",
          [
            `Cannot fully compare ${subject} — a sys_update_set or sys_update_xml read was security-trimmed. Grant the account read access; the records it cannot see are the ones this gate cannot clear.`,
            ...notes,
          ].join(" "),
        );
      }
      if (closed.length > 0 || skipped > 0) {
        return done("warn", notes.join(" "));
      }
      const tail = defaultHits.size > 0 ? ` ${notes.join(" ")}` : "";
      return result(
        "pass",
        `No record in the target update set(s) is captured anywhere else (${names.length} records).${tail}`,
      );
    } catch (err) {
      return errorResult(NAME, "update set collisions", err);
    }
  },
};
