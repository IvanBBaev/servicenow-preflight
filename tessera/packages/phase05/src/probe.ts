// TEMPORARY — PLAN Phase 0.5 walking skeleton (named ARCH-1 exception; README).
//
// The §11.2 read-only instance probe the TargetGuard classifies with. Two
// properties, both READS — the guard owns no transport, so the composition
// root injects this. An unreadable property is reported as `unreachable`, never
// as a clearance: a probe that cannot be read must not make an instance look
// safer than the allowlist says it is.

import type { InstanceProbe, ProbeFn } from "@tessera/guard";
import { tableApi } from "@tessera/sn-client";
import {
  ATF_RUNNER_SAFE_DIRECTION,
  decidePropertyRows,
  incompletePropertyRead,
  normalisePropertyValue,
  PRODUCTION_PROPERTY,
  PRODUCTION_SAFE_DIRECTION,
  PROPERTY_READ_LIMIT,
  readsSafeDirection,
  SYS_PROPERTIES_TABLE,
} from "@tessera/types";
import type { PropertySafeDirection } from "@tessera/types";

import { ATF_RUNNER_ENABLED_PROPERTY } from "./atf.js";
import { readField } from "./snRecords.js";

// Delegated decision 2026-10-01 (wave 17): the production property name is
// declared once, in `@tessera/types` (beside `SYS_PROPERTIES_TABLE`), and
// re-exported here under the name this module always exported it by —
// `@tessera/doctor` re-exports the same binding, so the two probes cannot read
// the production flag under two spellings.
export { PRODUCTION_PROPERTY } from "@tessera/types";

// Delegated decision 2026-09-30 (wave 16): the property row/read limits and
// the incomplete-read rule bound to sys_properties are declared once, in
// `@tessera/types`, and re-exported here under the names this module always
// exported them by — `@tessera/doctor` re-exports the same bindings, so the
// guard probe and the doctor cannot drift to different limits. Reads ask for
// ONE row more than they compare (wave 14), so an eleventh row is DETECTED;
// an incomplete read yields no value — fail closed.
export { PROPERTY_READ_LIMIT, PROPERTY_ROW_LIMIT } from "@tessera/types";

/**
 * Why a `sys_properties` read cannot be taken as complete, or `undefined`
 * when it can: `@tessera/types`' `incompletePropertyRead`, re-exported as-is.
 */
export { incompletePropertyRead as incompleteRead };

/** One property's reading, and the reason it is missing or caveated. */
interface PropertyReading {
  readonly value?: boolean;
  readonly note?: string;
}

/**
 * Reduce every row returned for ONE property name to a single reading.
 *
 * Delegated decision 2026-09-26: rows that disagree are not resolved by
 * order — the last row used to win, so `true` then `false` for
 * `glide.installation.production` read as a non-production instance.
 *
 * Delegated decision 2026-09-30 (wave 16): the rule is `@tessera/types`'
 * `decidePropertyRows`, the one `@tessera/doctor` uses, with each property's
 * safe direction declared explicitly — "production" for the production flag
 * (`PRODUCTION_SAFE_DIRECTION`), "not enabled" for the ATF runner
 * (`ATF_RUNNER_SAFE_DIRECTION`, the reading `provisioner.ts` and the doctor's
 * runner precondition already give). Only the licensing value (`false`,
 * `true` respectively) reads in the unsafe direction; any other value — the
 * empty string, `yes`, `garbage` — fails closed to the safe one, with a note.
 * This probe used to report such values, and differing rows with no `true`,
 * as NO boolean, which made the production flag read "unknown" here and
 * "production" in the doctor. Notes never quote an instance-authored value:
 * `unreachable` is printed verbatim.
 */
function readOne(
  name: string,
  values: readonly string[],
  direction: PropertySafeDirection,
  incomplete: string | undefined,
): PropertyReading {
  const safe = direction.canonical === "true";
  const decision = decidePropertyRows(
    values,
    incomplete === undefined,
    direction,
  );
  switch (decision.kind) {
    case "agreed": {
      const [value = ""] = values;
      if (!readsSafeDirection(value, direction)) return { value: !safe };
      if (value === direction.canonical) return { value: safe };
      return {
        value: safe,
        note: `${name} reads neither true nor false, so it fails closed and is read as ${String(safe)}`,
      };
    }
    case "safe":
      return incomplete === undefined
        ? {
            value: safe,
            note: `${name} has ${values.length} rows with differing values; one reads in its safe direction, so it is read as ${String(safe)}`,
          }
        : {
            value: safe,
            note: `${incomplete}; a ${name} row that was read reads in its safe direction, so it is read as ${String(safe)}`,
          };
    case "undecidable":
      // With a declared direction, differing rows always resolve; only an
      // incomplete read that saw nothing but the licensing value lands here.
      return incomplete === undefined
        ? {
            note: `${name} has ${values.length} rows with differing values, so it is unknown`,
          }
        : { note: `${incomplete}; ${name} is unknown` };
    case "absent":
      return { note: `${name} is absent` };
  }
}

/** Read ONE §11.2 property with its own query and its own row budget. */
async function readProperty(
  name: string,
  direction: PropertySafeDirection,
): Promise<PropertyReading> {
  let records: Awaited<ReturnType<typeof tableApi.queryTable>>["records"];
  let total: number | undefined;
  try {
    ({ records, total } = await tableApi.queryTable({
      table: SYS_PROPERTIES_TABLE,
      query: `name=${name}`,
      fields: ["name", "value"],
      limit: PROPERTY_READ_LIMIT,
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      note: `${SYS_PROPERTIES_TABLE} is unreadable for ${name}: ${detail}`,
    };
  }
  const incomplete = incompletePropertyRead(name, records.length, total);
  const values: string[] = [];
  for (const record of records) {
    if (readField(record, "name") !== name) {
      // Delegated decision 2026-09-30 (wave 16): a row answering for another
      // name (or none) means the instance did not answer the query asked, so
      // nothing it returned is evidence for this property — unknown, fail
      // closed. The stray name is not quoted: `unreachable` is verbatim.
      return {
        note: `${SYS_PROPERTIES_TABLE} answered the ${name} read with a row for another property, so ${name} is unknown`,
      };
    }
    values.push(normalisePropertyValue(readField(record, "value") ?? ""));
  }
  return readOne(name, values, direction, incomplete);
}

/**
 * Read both §11.2 properties.
 *
 * Delegated decision 2026-09-30 (wave 16): one query per property, each with
 * its own `PROPERTY_READ_LIMIT`. A single query for both names made them
 * share one eleven-row budget, so duplicates of one property made the read of
 * the other incomplete (and so unknown). Two requests instead of one; a
 * refused read is now named per property.
 */
export function createInstanceProbe(): ProbeFn {
  // The ref is ignored on purpose: `@tessera/sn-client` is bound to ONE
  // instance by the environment (ARCH-7/18), and Phase 0.5 runs one instance in
  // all three roles, so there is nothing to select on.
  return async (): Promise<InstanceProbe> => {
    const [production, atfRunner] = await Promise.all([
      readProperty(PRODUCTION_PROPERTY, PRODUCTION_SAFE_DIRECTION),
      readProperty(ATF_RUNNER_ENABLED_PROPERTY, ATF_RUNNER_SAFE_DIRECTION),
    ]);
    const unreachable: string[] = [];
    const productionProperty = production.value;
    const atfRunnerEnabled = atfRunner.value;
    if (production.note !== undefined) unreachable.push(production.note);
    if (atfRunner.note !== undefined) unreachable.push(atfRunner.note);

    return {
      ...(productionProperty === undefined ? {} : { productionProperty }),
      ...(atfRunnerEnabled === undefined ? {} : { atfRunnerEnabled }),
      ...(unreachable.length > 0 ? { unreachable } : {}),
    };
  };
}
