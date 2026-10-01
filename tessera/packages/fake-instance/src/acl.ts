// QA-18 — an OPT-IN ACL/role model for the fake (W2, ADR-007; delegated
// decision 2026-09-23).
//
// The fake has always been an admin-shaped instance: every table write lands.
// That is still the default — no `acl` option, no checks, byte-identical
// behaviour for every existing suite. With `acl` set, the fake enforces a small
// list of table ACL rules against the roles the caller is configured to hold,
// and a denied write answers HTTP 403 exactly where a real instance would:
// before the mutation, so a refused write changes nothing.
//
// Deliberately narrow:
//   * only table writes are modelled (create / write / delete); reads are not,
//     because the W2 channel ships write ACLs only and a read ACL model the
//     fake does not need would be invented behaviour;
//   * a rule applies to a request when its `table` and `operation` match and
//     its optional `when` predicate accepts the row (the incoming body for a
//     create, the stored row for a write or delete). Several rules on one
//     table/operation must ALL be satisfied, mirroring how ServiceNow evaluates
//     every matching ACL;
//   * there is no implicit `admin` override — a scenario that wants one lists
//     the role. The point of the model is to prove a non-admin refusal, and a
//     hidden bypass would make a mis-configured test pass for the wrong reason.

import { setOwn, type SnRecord, type StoredRecord } from "./record.js";

/** A Table API mutation, named the way `sys_security_acl.operation` names it. */
export type FakeAclOperation = "create" | "write" | "delete";

export interface FakeAclRule {
  readonly table: string;
  readonly operation: FakeAclOperation;
  /** The role a caller must hold for this rule to pass. */
  readonly role: string;
  /**
   * Row-level condition (the ACL's `condition`): the rule applies only to rows
   * this accepts. Receives the incoming body for `create`, the stored row
   * (with the incoming patch merged over it) for `write`, and the stored row
   * for `delete`. Absent = the rule applies to every row of the table.
   */
  readonly when?: (row: Readonly<SnRecord>) => boolean;
}

export interface FakeAclOptions {
  /** Roles the (single, implicit) caller holds. */
  readonly roles: readonly string[];
  /** Rules to enforce. Default: {@link W2_AUTHORING_CHANNEL_ACL_RULES}. */
  readonly rules?: readonly FakeAclRule[];
}

/** The W2 role an admin grants by hand (C6: the CLI never grants it). */
export const W2_AUTHORING_ROLE = "x_tessera.author";

const isAtfStepInput = (row: Readonly<SnRecord>): boolean =>
  row["document"] === "sys_atf_step";

/**
 * The W2 authoring channel as the fake models it: `sys_variable_value` rows
 * whose `document` is `sys_atf_step` (the ATF step inputs a projection writes)
 * may be created, written or deleted only by a holder of
 * {@link W2_AUTHORING_ROLE}. Mirrors the ACLs in
 * `@tessera/teststore-atf/assets/tessera-authoring-channel.update-set.xml`.
 */
export const W2_AUTHORING_CHANNEL_ACL_RULES: readonly FakeAclRule[] = (
  ["create", "write", "delete"] as const
).map((operation) => ({
  table: "sys_variable_value",
  operation,
  role: W2_AUTHORING_ROLE,
  when: isAtfStepInput,
}));

/** A denied check, carrying what the 403 body reports. */
export interface FakeAclDenial {
  readonly table: string;
  readonly operation: FakeAclOperation;
  readonly role: string;
}

export interface FakeAcl {
  /** `undefined` = allowed; otherwise the first rule the caller fails. */
  check(
    table: string,
    operation: FakeAclOperation,
    row: Readonly<SnRecord>,
  ): FakeAclDenial | undefined;
}

export function createFakeAcl(options: FakeAclOptions): FakeAcl {
  const roles = new Set(options.roles);
  const rules = options.rules ?? W2_AUTHORING_CHANNEL_ACL_RULES;
  return {
    check(table, operation, row) {
      for (const rule of rules) {
        if (rule.table !== table || rule.operation !== operation) continue;
        if (rule.when && !rule.when(row)) continue;
        if (!roles.has(rule.role)) {
          return { table, operation, role: rule.role };
        }
      }
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// W6a L3 — an OPT-IN read-ACL model (delegated decision 2026-09-26).
//
// Kept separate from the write model above (its own option, no roles): the
// point is to reproduce what a denied READ looks like on the wire, which is
// what `@tessera/sn-client`'s `fetchAll` truncation logic (api/table.ts) has
// to cope with:
//   * a row read ACL is evaluated AFTER the database page is fetched, so the
//     denied rows are dropped from that page — the page comes back short —
//     while `X-Total-Count` still reports every matching row;
//   * with the count omitted (`sysparm_no_count=true` or `omitTotalCount`)
//     the page is trimmed the same way, just without the header. Since wave
//     15 `fetchAll` and runner-atf's `readTable` answer a short, non-empty
//     header-less page with a one-window probe (`sysparm_offset` advanced by
//     the requested window): rows there make the read partial
//     ("short-page-no-total"), a failed probe does too ("probe-failed"). A
//     page trimmed to zero rows still reads as the end — the accepted
//     residual, which this model reproduces faithfully;
//   * a field read ACL keeps the row and blanks the field ("");
//   * a denied row read by sys_id answers the ordinary "No Record found" 404
//     (whose detail already says "or ACL restricts the record retrieval").
// The query itself still filters on stored values, as the database does.

export interface FakeReadAclRule {
  readonly table: string;
  /**
   * Absent = a row-level rule (`table`): a matching row is hidden. Present =
   * a field-level rule (`table.field`): these fields are blanked instead.
   */
  readonly fields?: readonly string[];
  /** Row condition; absent = every row of the table. */
  readonly when?: (row: Readonly<StoredRecord>) => boolean;
}

export interface FakeReadAclOptions {
  readonly rules: readonly FakeReadAclRule[];
}

export interface FakeReadAcl {
  /** True when a row-level rule denies reading `row`. */
  hides(table: string, row: Readonly<StoredRecord>): boolean;
  /** A copy of `row` with every field-level-denied field set to "". */
  redact(table: string, row: Readonly<StoredRecord>): StoredRecord;
}

export function createFakeReadAcl(options: FakeReadAclOptions): FakeReadAcl {
  const applies = (
    rule: FakeReadAclRule,
    table: string,
    row: Readonly<StoredRecord>,
  ): boolean => rule.table === table && (!rule.when || rule.when(row));
  return {
    hides(table, row) {
      return options.rules.some(
        (rule) => rule.fields === undefined && applies(rule, table, row),
      );
    },
    redact(table, row) {
      const out: StoredRecord = { ...row };
      for (const rule of options.rules) {
        if (rule.fields === undefined || !applies(rule, table, row)) continue;
        for (const field of rule.fields) {
          // Only a field the row has: blanking must not invent a column.
          if (Object.hasOwn(out, field)) setOwn(out, field, "");
        }
      }
      return out;
    },
  };
}
