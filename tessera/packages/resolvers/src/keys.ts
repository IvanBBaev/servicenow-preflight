import type { TargetArtifactRef } from "@tessera/types";

import { ResolutionInputError } from "./errors.js";

/**
 * ARCH-5 de-duplicates by sys_id. The key carries the table as well, because a
 * sys_id is only unique per table in principle and a collision would silently
 * merge two different artifacts into one row.
 */
export function artifactKey(ref: TargetArtifactRef): string {
  return `${ref.table}:${ref.sysId}`;
}

/** A sys_id as the Table API renders it — 32 lowercase hex characters. */
export const SYS_ID_RE = /^[0-9a-f]{32}$/;

export function isSysId(value: string): boolean {
  return SYS_ID_RE.test(value);
}

/**
 * Characters that carry meaning inside an encoded `sysparm_query`: `^` joins
 * conditions (`^OR`, `^NQ` opens a whole new query group), `=` and `,` belong
 * to operators and IN-lists, `@` separates the arguments of the relative and
 * BETWEEN operators, and CR/LF have no business in a single-line value.
 */
const QUERY_METACHARACTERS = /[\^=,@\r\n]/;

/**
 * Refuses a caller-supplied value that would be spliced into an encoded query.
 *
 * Delegated decision 2026-09-25: there is no escape syntax for an encoded
 * query value, so a value carrying a query metacharacter is rejected rather
 * than "cleaned" — `STRY0001^NQnumber=STRY0999` used to open a second query
 * group and resolve a story nobody named. It is an input error: the instance
 * was never asked, and the fix is a different argument.
 */
export function assertQueryValue(value: string, what: string): void {
  if (QUERY_METACHARACTERS.test(value)) {
    throw new ResolutionInputError(
      `${what} ${JSON.stringify(value)} contains a character that is part of ServiceNow's encoded-query syntax (one of ^ = , @ CR LF); it cannot be matched safely, so no query was sent`,
    );
  }
}

/**
 * A Table API field name, optionally dot-walked (`story`, `u_story.ref`). Used
 * for configuration that becomes the LEFT side of a query condition.
 */
const FIELD_NAME_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;

export function isFieldName(value: string): boolean {
  return FIELD_NAME_RE.test(value);
}

/**
 * A plain Table API table name: lowercase letters, digits and underscores, no
 * dot-walk. Used for anything that becomes the `table` of a read.
 *
 * Delegated decision 2026-09-26 (L4): a table name is an identifier, not a
 * value, and it is never escaped — so the shape is checked instead. `^NQ`, `.`,
 * uppercase and whitespace all fail it; ServiceNow's own dictionary never
 * produces a table name outside this set.
 */
export const TABLE_NAME_RE = /^[a-z0-9_]+$/;

export function isTableName(value: string): boolean {
  return TABLE_NAME_RE.test(value);
}
