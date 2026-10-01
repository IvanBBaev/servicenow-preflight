// TEMPORARY — PLAN Phase 0.5 walking skeleton (named ARCH-1 exception; README).
//
// `SnRecord` is `Record<string, unknown>` and the workspace compiles with
// `noUncheckedIndexedAccess`, so every field read off a ServiceNow row is
// `unknown`. These helpers are the ONE place that narrows it, so a missing
// column fails as a named skeleton error at the read site instead of leaking
// `undefined` into a sys_id.

import { SkeletonInfrastructureError } from "./errors.js";

export type SnRecordLike = Record<string, unknown>;

/**
 * A reference field comes back either flat (`sysparm_exclude_reference_link`)
 * or as `{ value, link }`. Both shapes reduce to the sys_id string.
 */
export function readField(
  record: SnRecordLike,
  field: string,
): string | undefined {
  const raw = record[field];
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (raw && typeof raw === "object" && "value" in raw) {
    const value: unknown = raw.value;
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Same as `readField`, but a missing/blank value is an infrastructure fault. */
export function requireField(
  record: SnRecordLike,
  field: string,
  what: string,
): string {
  const value = readField(record, field);
  if (value === undefined || value === "") {
    throw new SkeletonInfrastructureError(
      `${what}: the instance returned a row without a usable "${field}"`,
    );
  }
  return value;
}

/** `sys_id` of a row, or an infrastructure fault naming what was being read. */
export function requireSysId(record: SnRecordLike, what: string): string {
  return requireField(record, "sys_id", what);
}
