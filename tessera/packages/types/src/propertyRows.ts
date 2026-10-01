// What several `sys_properties` rows answering for ONE name read as.
//
// Pure: it judges normalised values the caller already holds and performs no
// I/O. It lives here for the same reason `incompleteRead` does —
// `@tessera/doctor` and `@tessera/phase05` both reduce duplicate property
// rows, and two copies of that rule had already drifted into two rules: the
// doctor read the production flag as "production" from any seen row that was
// not `false`, phase05 only from a seen `true`, so `false` + `garbage` was
// production to one probe and unknown to the other.
//
// Delegated decision 2026-09-30 (wave 16): the two probes unify on the MORE
// conservative rule, the doctor's. For a property with a declared safe
// direction, ONE value licenses the unsafe reading (`false` for the production
// flag: "not production"; `true` for the ATF runner: "enabled"), and any seen
// row that normalises to anything else — `garbage`, the empty string, `yes` —
// reads in the safe direction. That holds on a complete read whose rows
// differ and on an incomplete read alike; an incomplete read whose seen rows
// all read the licensing value decides nothing, because an unseen row may not.
// Fail closed: a value nobody can interpret must not license destructive work.

/**
 * Which way a boolean-ish property fails closed.
 *
 * `licensing` is the ONLY normalised value that licenses the unsafe reading;
 * every other value, the empty string included, reads in the safe direction.
 * `canonical` is the value that states the safe direction outright; when
 * several rows read safe, a row reading `canonical` is the one reported.
 */
export interface PropertySafeDirection {
  readonly licensing: string;
  readonly canonical: string;
}

/**
 * `glide.installation.production` (§11.2): the safe direction is
 * "production", which refuses destructive work. Only an exact `false`
 * (after trimming and case-folding) reads as a non-production instance.
 */
export const PRODUCTION_SAFE_DIRECTION: PropertySafeDirection = Object.freeze({
  licensing: "false",
  canonical: "true",
});

/**
 * `sn_atf.runner.enabled` (DR-3): the safe direction is "not enabled" / not
 * ready. Only an exact `true` reads as an enabled runner — the reading
 * `@tessera/doctor`'s `atfRunnerEnabledPrecondition` (only `true` is `ready`)
 * and `@tessera/phase05`'s provisioner (enabled only when every row reads
 * `true`) already give it.
 */
export const ATF_RUNNER_SAFE_DIRECTION: PropertySafeDirection = Object.freeze({
  licensing: "true",
  canonical: "false",
});

/**
 * The reading rows are compared on: trimmed and case-folded, so `"true"` and
 * `" TRUE"` agree. Nothing else is folded — `yes` is not `true`.
 */
export function normalisePropertyValue(value: string): string {
  return value.trim().toLowerCase();
}

/** Whether one normalised value reads in `direction`'s safe direction. */
export function readsSafeDirection(
  value: string,
  direction: PropertySafeDirection,
): boolean {
  return value !== direction.licensing;
}

/**
 * - `agreed` — a complete read whose rows all normalise to the same value;
 *   `index` is always the first row. What that value MEANS is the caller's
 *   (see {@link readsSafeDirection}).
 * - `safe` — the rows differ, or the read is incomplete, and row `index` reads
 *   in the declared safe direction, which settles it.
 * - `undecidable` — rows differ with no safe direction declared, or an
 *   incomplete read saw nothing in the safe direction.
 * - `absent` — a complete read with no rows.
 */
export type PropertyRowsDecision =
  | { readonly kind: "agreed"; readonly index: 0 }
  | { readonly kind: "safe"; readonly index: number }
  | {
      readonly kind: "undecidable";
      readonly reason: "differing" | "incomplete";
    }
  | { readonly kind: "absent" };

/**
 * Decide what the rows returned for ONE property name read as.
 *
 * `values` are the rows' values, already {@link normalisePropertyValue}d, in
 * response order. `complete` is whether the read can be taken as the whole
 * picture (`incompletePropertyRead` returned `undefined`). `direction` is the
 * property's safe direction, or `undefined` for a property that has none —
 * its differing rows are then never resolved, by order or otherwise.
 */
export function decidePropertyRows(
  values: readonly string[],
  complete: boolean,
  direction?: PropertySafeDirection,
): PropertyRowsDecision {
  const safeIndex = (): number => {
    if (direction === undefined) return -1;
    const canonical = values.indexOf(direction.canonical);
    if (canonical !== -1) return canonical;
    return values.findIndex((value) => readsSafeDirection(value, direction));
  };
  if (!complete) {
    // An incomplete read has no value, even when every row it saw agrees —
    // the unseen rows are exactly where a disagreement would hide. Only a
    // SEEN row in the safe direction survives: no unseen row can make it
    // less safe.
    const index = safeIndex();
    return index === -1
      ? { kind: "undecidable", reason: "incomplete" }
      : { kind: "safe", index };
  }
  const [first] = values;
  if (first === undefined) return { kind: "absent" };
  if (values.every((value) => value === first)) {
    return { kind: "agreed", index: 0 };
  }
  // Rows that differ are never resolved by order. With a safe direction at
  // least one of them is not the licensing value, so this always resolves.
  const index = safeIndex();
  return index === -1
    ? { kind: "undecidable", reason: "differing" }
    : { kind: "safe", index };
}
