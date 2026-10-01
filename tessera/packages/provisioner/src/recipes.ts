// How a not-ready finding becomes a planned write.
//
// The division of labour is the point. The DOCTOR decides what is wrong and
// says so with evidence; it is read-only and owns no payloads. The PROVISIONER
// decides what to write, and derives that from a row it observes for itself at
// plan time — not from the finding's prose. So a plan always addresses the row
// it will actually PATCH, and a finding that cannot be turned into a precise
// write becomes a blocker instead of a guess.

import {
  ATF_RUNNER_ENABLED_PROPERTY,
  PRECONDITION_IDS,
  SYS_PROPERTIES_TABLE,
  type InstanceProbe,
} from "@tessera/doctor";

import type { ProvisionStep } from "./types.js";

/** Either a precise write, or the reason there cannot be one. */
export type RecipeResult =
  | { readonly outcome: "step"; readonly step: ProvisionStep }
  | { readonly outcome: "blocked"; readonly why: string };

/**
 * The one write a recipe is allowed to produce, declared next to the recipe.
 *
 * Delegated decision 2026-09-25: `apply()` used to trust any structurally
 * well-formed plan, so a hand-built or tampered plan could PATCH any table
 * (`sys_user_has_role`, say) and was only caught — if at all — by the
 * post-hoc re-diagnosis, after the write had landed. The allowlist of tables
 * and the exact field payload are therefore declared here, by the recipe that
 * owns them, and `apply()` refuses any step that does not match its recipe's
 * declaration BEFORE the first write. A recipe that declares nothing can plan,
 * but none of its steps can ever be applied (fail closed).
 */
export interface RecipeWriteScope {
  readonly kind: "update-record";
  readonly table: string;
  /** The exact field payload — keys AND values — every step of this recipe writes. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface Recipe {
  (probe: InstanceProbe, signal?: AbortSignal): Promise<RecipeResult>;
  /** What this recipe may write. See `RecipeWriteScope`. */
  readonly writes: RecipeWriteScope;
}

/** Attach a recipe's declared write scope to its implementation. */
export function defineRecipe(
  writes: RecipeWriteScope,
  run: (probe: InstanceProbe, signal?: AbortSignal) => Promise<RecipeResult>,
): Recipe {
  return Object.assign(run, { writes: Object.freeze({ ...writes }) });
}

const ENABLE_ATF_RUNNER_WRITE: RecipeWriteScope = {
  kind: "update-record",
  table: SYS_PROPERTIES_TABLE,
  fields: { value: "true" },
};

/**
 * DR-3 — set `sn_atf.runner.enabled` to `true` on the row that answered.
 *
 * The `absent` branch is the interesting one. A `sys_properties` row that reads
 * as absent is either genuinely unset or ACL-trimmed (the Table API renders the
 * two identically — the OPP-1(b) lesson), and the two want opposite writes:
 * create one, or update the row you cannot see. Creating a duplicate row for a
 * property name that may already exist is not a remedy, it is a second source
 * of truth for whether ATF runs. So this stays a blocker for an admin.
 */
export const enableAtfRunnerRecipe: Recipe = defineRecipe(
  ENABLE_ATF_RUNNER_WRITE,
  async (probe, signal) => {
    const read = await probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY, signal);

    if (read.duplicates !== undefined) {
      // Delegated decision 2026-09-26: more than one row answered for the
      // property, so there is no single row to PATCH. Disagreeing rows leave
      // it unknowable which one ATF honours; agreeing rows would be split into
      // disagreeing ones by a write to just one of them. Both are a blocker
      // for an admin, and the blocker names every row the probe saw.
      const rows = (read.rows ?? [])
        .map(
          (row) =>
            `${SYS_PROPERTIES_TABLE}/${row.sysId ?? "(no sys_id)"}=${JSON.stringify(row.value)}`,
        )
        .join(", ");
      return {
        outcome: "blocked",
        why:
          `${ATF_RUNNER_ENABLED_PROPERTY} has ${read.duplicates} duplicate ` +
          `${SYS_PROPERTIES_TABLE} rows (${rows}) — updating one of them ` +
          `cannot make the property reliably true, so an admin must remove ` +
          `the duplicates and leave one row: ${read.detail}`,
      };
    }

    if (read.outcome === "found") {
      if (read.sysId === undefined) {
        return {
          outcome: "blocked",
          why: `${SYS_PROPERTIES_TABLE} answered for ${ATF_RUNNER_ENABLED_PROPERTY} without a sys_id — there is no row to address`,
        };
      }
      return {
        outcome: "step",
        step: {
          precondition: PRECONDITION_IDS.atfRunnerEnabled,
          action: {
            kind: "update",
            table: SYS_PROPERTIES_TABLE,
            description: `set ${ATF_RUNNER_ENABLED_PROPERTY} to true on ${SYS_PROPERTIES_TABLE}/${read.sysId} (DR-3)`,
          },
          write: {
            kind: "update-record",
            table: SYS_PROPERTIES_TABLE,
            sysId: read.sysId,
            fields: { ...ENABLE_ATF_RUNNER_WRITE.fields },
          },
          observed: read.detail,
        },
      };
    }

    if (read.outcome === "absent") {
      return {
        outcome: "blocked",
        why:
          `${read.detail} — the row is either genuinely unset or ACL-trimmed, and the Table API ` +
          `renders those identically. Creating a second ${SYS_PROPERTIES_TABLE} row for ` +
          `${ATF_RUNNER_ENABLED_PROPERTY} would be a blind write, so an admin must set it`,
      };
    }

    return {
      outcome: "blocked",
      why: `cannot plan a write against a row this run could not read: ${read.detail}`,
    };
  },
);

/**
 * Precondition id → recipe. A finding whose id is absent from this map is a
 * finding this phase cannot remediate; the doctor's own `remedy` pointer is
 * advisory and is deliberately NOT trusted as proof that a write exists for it.
 */
export const DEFAULT_RECIPES: Readonly<Record<string, Recipe>> = {
  [PRECONDITION_IDS.atfRunnerEnabled]: enableAtfRunnerRecipe,
};
