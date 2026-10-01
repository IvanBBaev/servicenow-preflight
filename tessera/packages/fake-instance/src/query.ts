// QA-18 — a usable subset of ServiceNow's encoded-query language.
//
// The fake must *filter*, not replay: §4a's invariants (sweep scoping,
// run-id namespacing, fresh-create identity) are asserted with real queries
// such as `name STARTSWITH tessera-<runId>`. The subset below covers every
// operator `@tessera/sn-client` emits today (`api/table.ts` builds
// `sysparm_query` from caller strings and appends `ORDERBYsys_id` for
// `fetchAll`; `api/atf.ts` builds `active=<bool>^ORDERBYname`) plus the
// comparison operators a sweep query needs.
//
// Deliberate fidelity notes (documented, not accidental):
//   * `=` / `!=` / `IN` compare exactly by default; the LIKE family is
//     case-insensitive. Real ServiceNow collation is case-insensitive for both
//     — matching that for `=` too would make a test unable to distinguish two
//     run-ids that differ only in case, so the default fake is the stricter of
//     the two. `QuerySemantics.caseInsensitiveEquals` opts into the real
//     collation (W6a L3).
//   * `!=` matches an empty value by default. `notEqualsExcludesEmpty` opts
//     into the SQL-style reading (an empty/NULL column never satisfies `!=`),
//     which is PLAUSIBLE for a real instance but not evidenced anywhere in
//     this repo, so it stays opt-in (W6a L3).
//   * A condition on a field the table does not have is resolved per table by
//     `applyUnknownFieldPolicy` (W6a M1) — see `UnknownQueryFieldMode`.
//   * Field lookups use `Object.hasOwn`: a field named `constructor` or
//     `toString` is just an absent field, never an inherited member (W6a L1).
//   * `>`/`<`/`>=`/`<=` compare numerically when both operands parse as finite
//     numbers, lexicographically otherwise (ISO-8601 and the Table API's
//     "YYYY-MM-DD HH:mm:ss" both sort correctly under a string compare).

import type { StoredRecord } from "./record.js";

/** A single `field<op>value` condition. */
export interface QueryCondition {
  field: string;
  operator: QueryOperator;
  value: string;
}

export type QueryOperator =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "LIKE"
  | "NOT LIKE"
  | "STARTSWITH"
  | "ENDSWITH"
  | "IN"
  | "NOT IN"
  | "ISEMPTY"
  | "ISNOTEMPTY"
  | "ANYTHING";

/** One `ORDERBY` / `ORDERBYDESC` term. */
export interface QuerySort {
  field: string;
  direction: "asc" | "desc";
}

/**
 * Parsed query: OR of groups (`^NQ`), each group an AND of terms (`^`), each
 * term an OR of alternatives (`^OR`) — ServiceNow's actual precedence.
 */
export interface ParsedQuery {
  groups: QueryCondition[][][];
  sort: QuerySort[];
}

/**
 * What a condition on an unknown field (one the table does not have) does.
 *
 *   * `"ignore"` — a real instance's default: the term is dropped, so it
 *     matches every row. Never a 400.
 *   * `"no-rows"` — a real instance with
 *     `glide.invalid_query.returns_no_rows=true`: the whole query answers zero
 *     rows.
 *   * `"legacy-empty"` — the fake's pre-W6a behaviour: the field reads as ""
 *     on every row, so `unknown=x` matches nothing and `unknownISEMPTY`
 *     matches everything. Matches neither real configuration; kept only as an
 *     explicit opt-in for a suite that still needs it.
 *
 * The default is `"ignore"` — see `DEFAULT_UNKNOWN_QUERY_FIELD`.
 */
export type UnknownQueryFieldMode = "ignore" | "no-rows" | "legacy-empty";

/** Row-level matching knobs (W6a L3); every default is the legacy behaviour. */
export interface MatchSemantics {
  /** `=` / `!=` / `IN` / `NOT IN` fold case, as a real instance does. */
  readonly caseInsensitiveEquals?: boolean;
  /** `!=` never matches an empty value (SQL NULL-style). */
  readonly notEqualsExcludesEmpty?: boolean;
}

/** Table-level knobs: row matching plus the unknown-field policy. */
export interface QuerySemantics extends MatchSemantics {
  readonly unknownQueryField?: UnknownQueryFieldMode;
}

/**
 * The fake's unknown-field policy when a caller does not choose one.
 *
 * Delegated decision 2026-09-26: the default is `"ignore"`, a real instance's
 * out-of-box behaviour (the term is dropped and the query answers as if it
 * were not there). It was `"legacy-empty"` until the one dependent that relied
 * on an absent column matching nothing — packages/cli/test/resolve.test.js
 * "reaches the story adapter with --update-set-story-field (OPP-1b)" — was
 * made explicit by declaring `sys_update_set`'s fields via `tableSchema`. A
 * suite that needs another policy passes `unknownQueryField` explicitly.
 */
export const DEFAULT_UNKNOWN_QUERY_FIELD: UnknownQueryFieldMode = "ignore";

/** An own field value, or "" — never an inherited `Object.prototype` member. */
export function fieldValue(record: StoredRecord, field: string): string {
  return Object.hasOwn(record, field) ? (record[field] ?? "") : "";
}

/** Operators, longest-first so `!=` never parses as `=` and `NOT IN` beats `IN`. */
const OPERATORS: readonly QueryOperator[] = [
  "ISNOTEMPTY",
  "STARTSWITH",
  "NOT LIKE",
  "ANYTHING",
  "ENDSWITH",
  "ISEMPTY",
  "NOT IN",
  "LIKE",
  "IN",
  ">=",
  "<=",
  "!=",
  "=",
  ">",
  "<",
];

/** Operators that take no right-hand operand. */
const NULLARY: ReadonlySet<QueryOperator> = new Set<QueryOperator>([
  "ISEMPTY",
  "ISNOTEMPTY",
  "ANYTHING",
]);

/**
 * Split `token` at its operator. The operator may not start at index 0 (a
 * condition always names a field first), and the earliest match wins so a
 * field named `in_progress` cannot be cut at its embedded `IN`... which it
 * cannot anyway, because operators are matched case-sensitively in uppercase.
 */
function parseCondition(token: string): QueryCondition | undefined {
  let best: { at: number; operator: QueryOperator } | undefined;
  for (const operator of OPERATORS) {
    const at = token.indexOf(operator, 1);
    if (at < 0) continue;
    if (best === undefined || at < best.at) best = { at, operator };
  }
  if (best === undefined) return undefined;
  const field = token.slice(0, best.at);
  if (!field) return undefined;
  const value = NULLARY.has(best.operator)
    ? ""
    : token.slice(best.at + best.operator.length);
  return { field, operator: best.operator, value };
}

/** `ORDERBYDESCname` / `ORDERBYname` — checked before the operator scan. */
function parseSort(token: string): QuerySort | undefined {
  if (token.startsWith("ORDERBYDESC")) {
    return { field: token.slice("ORDERBYDESC".length), direction: "desc" };
  }
  if (token.startsWith("ORDERBY")) {
    return { field: token.slice("ORDERBY".length), direction: "asc" };
  }
  return undefined;
}

/**
 * Parse an encoded query. An empty/absent query matches every row.
 * Unparseable tokens are dropped rather than thrown on: a real instance
 * silently ignores nonsense clauses, and a fake that threw would turn a
 * sloppy query into a test failure with a misleading cause.
 */
export function parseQuery(encoded: string | undefined | null): ParsedQuery {
  const sort: QuerySort[] = [];
  const groups: QueryCondition[][][] = [];
  if (!encoded?.trim()) return { groups, sort };

  for (const rawGroup of encoded.split("^NQ")) {
    const terms: QueryCondition[][] = [];
    for (const rawToken of rawGroup.split("^")) {
      const token = rawToken.trim();
      if (!token || token === "EQ") continue;

      const sorted = parseSort(token);
      if (sorted) {
        if (sorted.field) sort.push(sorted);
        continue;
      }

      const isOrContinuation = token.startsWith("OR") && terms.length > 0;
      const body = isOrContinuation ? token.slice(2) : token;
      const condition = parseCondition(body);
      if (!condition) continue;

      const last = terms[terms.length - 1];
      if (isOrContinuation && last) last.push(condition);
      else terms.push([condition]);
    }
    groups.push(terms);
  }
  return { groups, sort };
}

/** Numeric compare when both sides are finite numbers, else lexicographic. */
function compare(left: string, right: string): number {
  const a = Number(left);
  const b = Number(right);
  if (left.trim() !== "" && right.trim() !== "" && isFinite(a) && isFinite(b)) {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Evaluate one condition against a stored (all-string) record. */
export function matchCondition(
  record: StoredRecord,
  condition: QueryCondition,
  semantics: MatchSemantics = {},
): boolean {
  // Delegated decision 2026-09-26: `Object.hasOwn`, not `record[field]`, so a
  // `constructorLIKEx` query no longer throws on a function value and
  // `toStringISNOTEMPTY` no longer matches every row through inheritance.
  const actual = fieldValue(record, condition.field);
  const expected = condition.value;
  const fold = semantics.caseInsensitiveEquals
    ? (text: string): string => text.toLowerCase()
    : (text: string): string => text;
  const inList = (): boolean =>
    expected.split(",").map(fold).includes(fold(actual));
  switch (condition.operator) {
    case "=":
      return fold(actual) === fold(expected);
    case "!=":
      // Delegated decision 2026-09-26: opt-in only — no doc, fixture or
      // comment in the repo evidences that a real `!=` skips empty values.
      if (semantics.notEqualsExcludesEmpty && actual === "") return false;
      return fold(actual) !== fold(expected);
    case ">":
      return compare(actual, expected) > 0;
    case ">=":
      return compare(actual, expected) >= 0;
    case "<":
      return compare(actual, expected) < 0;
    case "<=":
      return compare(actual, expected) <= 0;
    case "LIKE":
      return actual.toLowerCase().includes(expected.toLowerCase());
    case "NOT LIKE":
      return !actual.toLowerCase().includes(expected.toLowerCase());
    case "STARTSWITH":
      return actual.toLowerCase().startsWith(expected.toLowerCase());
    case "ENDSWITH":
      return actual.toLowerCase().endsWith(expected.toLowerCase());
    case "IN":
      return inList();
    case "NOT IN":
      return !inList();
    case "ISEMPTY":
      return actual === "";
    case "ISNOTEMPTY":
      return actual !== "";
    case "ANYTHING":
      return true;
  }
}

/** Evaluate a parsed query's filter half (sorting is applied separately). */
export function matchQuery(
  record: StoredRecord,
  query: ParsedQuery,
  semantics: MatchSemantics = {},
): boolean {
  if (query.groups.length === 0) return true;
  return query.groups.some((terms) =>
    terms.every((alternatives) =>
      alternatives.some((condition) =>
        matchCondition(record, condition, semantics),
      ),
    ),
  );
}

/**
 * Resolve conditions on unknown fields for one table (W6a M1). `knownFields`
 * is the table's field set — the caller decides what "known" means (the fake
 * uses every own key of any stored row plus a declared `tableSchema`).
 * Returns the query to evaluate, or `null` for "answer zero rows".
 *
 * Under `"ignore"` an unknown alternative is dropped from its `^OR` term, a
 * term left with no alternatives is dropped, and a group left with no terms
 * matches every row. Sorting is untouched in every mode: an `ORDERBY` on an
 * unknown field sorts every row as "" and so keeps input order, which is what
 * ignoring it means.
 */
export function applyUnknownFieldPolicy(
  query: ParsedQuery,
  knownFields: ReadonlySet<string>,
  mode: UnknownQueryFieldMode,
): ParsedQuery | null {
  if (mode === "legacy-empty") return query;
  const known = (condition: QueryCondition): boolean =>
    knownFields.has(condition.field);
  if (mode === "no-rows") {
    const anyUnknown = query.groups.some((terms) =>
      terms.some((alternatives) => !alternatives.every(known)),
    );
    return anyUnknown ? null : query;
  }
  return {
    sort: query.sort,
    groups: query.groups.map((terms) =>
      terms
        .map((alternatives) => alternatives.filter(known))
        .filter((alternatives) => alternatives.length > 0),
    ),
  };
}

/**
 * Stable sort by the query's ORDERBY terms. Input order is preserved for ties,
 * which keeps the fake's paging deterministic even for an unordered query —
 * the very thing `queryTable(fetchAll)` guards against on a real instance.
 */
export function sortRecords(
  records: readonly StoredRecord[],
  sort: readonly QuerySort[],
): StoredRecord[] {
  if (sort.length === 0) return [...records];
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      for (const term of sort) {
        const delta = compare(
          fieldValue(left.record, term.field),
          fieldValue(right.record, term.field),
        );
        if (delta !== 0) return term.direction === "desc" ? -delta : delta;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.record);
}
