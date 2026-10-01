// TEMPORARY — PLAN Phase 0.5 walking skeleton (named ARCH-1 exception; README).
//
// The Provisioner exists in Phase 0.5 to make an ABSENCE explicit: this run
// fabricates no run-scoped state. There are no temp users, no seed data, no
// standing infrastructure created — so `plan()` returns an EMPTY plan and that
// emptiness is the deliverable, not a gap.
//
// What it does still do is the ARCH-33 half of the contract: standing infra is
// VERIFIED, never created. `sn_atf.runner.enabled` must already be true on the
// runner instance (DR-3) — ATF silently refuses to execute otherwise, and the
// run would come back green-looking with no result rows. So a disabled runner
// is reported as a planned ACTION, which core turns into a hard "missing
// standing infrastructure" stage error pointing at preflight_plan/apply. The
// Provisioner itself never writes it.

import type { Provisioner } from "@tessera/core";
import type {
  PipelineContext,
  ProvisionAction,
  ProvisionPlan,
} from "@tessera/types";
import {
  incompletePropertyRead,
  PROPERTY_READ_LIMIT,
  SYS_PROPERTIES_TABLE,
} from "@tessera/types";
import { tableApi } from "@tessera/sn-client";

import { ATF_RUNNER_ENABLED_PROPERTY } from "./atf.js";
import {
  SkeletonInfrastructureError,
  SkeletonUnsupportedActionError,
} from "./errors.js";
import { readField } from "./snRecords.js";

export interface S5ProvisionerOptions {
  /**
   * Skip the DR-3 property probe. Only for a caller that has already verified
   * the runner out of band; the default is to check, because a silently
   * disabled ATF runner is the failure mode this port exists to catch.
   */
  readonly skipRunnerPropertyCheck?: boolean;
}

/**
 * Delegated decision 2026-09-25: only a trimmed, lowercase `"true"` reads as
 * an enabled runner — the same vocabulary as the guard probe (`probe.ts`),
 * which treats anything but `"true"`/`"false"` as unreadable. `"1"`/`"yes"`
 * used to pass here while the guard called the same value unknown; two
 * adapters disagreeing about one property is how a run starts on a runner ATF
 * does not consider enabled. Fail closed: every other value is NOT enabled,
 * so the plan carries the DR-3 action to set the property to `"true"`.
 */
const ENABLED_VALUE = "true";

export function createS5Provisioner(
  options: S5ProvisionerOptions = {},
): Provisioner {
  return {
    async plan(): Promise<ProvisionPlan> {
      // Phase 0.5 fabricates NO run-scoped state. Every action below is a
      // standing-infra finding, and core refuses to proceed on any of them.
      const actions: ProvisionAction[] = [];

      if (options.skipRunnerPropertyCheck !== true) {
        const enabled = await readAtfRunnerEnabled();
        if (!enabled) {
          actions.push({
            kind: "update",
            table: SYS_PROPERTIES_TABLE,
            description: `${ATF_RUNNER_ENABLED_PROPERTY} must be true before ATF will execute anything (DR-3)`,
          });
        }
      }

      return { actions };
    },

    apply(ctx: PipelineContext, plan: ProvisionPlan): Promise<void> {
      // Unreachable through `runPipeline` — core throws on a non-empty plan
      // before it would ever call `apply` (ARCH-33). Implemented as a refusal
      // rather than a no-op so a future direct caller cannot quietly turn the
      // run loop into something that writes standing infrastructure.
      return Promise.reject(
        new SkeletonUnsupportedActionError(
          `run ${ctx.runId}: the Phase 0.5 provisioner never applies anything ` +
            `(${plan.actions.length} action(s) requested) — standing infrastructure ` +
            "is preflight_plan/preflight_apply's job (ARCH-33)",
        ),
      );
    },
  };
}

async function readAtfRunnerEnabled(): Promise<boolean> {
  let records;
  let total: number | undefined;
  try {
    ({ records, total } = await tableApi.queryTable({
      table: SYS_PROPERTIES_TABLE,
      query: `name=${ATF_RUNNER_ENABLED_PROPERTY}`,
      fields: ["name", "value"],
      // Delegated decision 2026-09-26: more than one row, so a duplicate
      // property row is SEEN rather than hidden behind whichever row the
      // instance happened to return first. The guard probe reads up to ten.
      // Delegated decision 2026-09-30 (wave 14): plus one, so an eleventh
      // row is detected rather than silently cut off (see below).
      limit: PROPERTY_READ_LIMIT,
    }));
  } catch (error) {
    // Fail closed: an unreadable property is NOT an enabled runner.
    throw new SkeletonInfrastructureError(
      `could not read ${ATF_RUNNER_ENABLED_PROPERTY} from ${SYS_PROPERTIES_TABLE}`,
      { cause: error },
    );
  }
  // Delegated decision 2026-09-26: enabled only when there is at least one row
  // and EVERY row reads `true`. Differing duplicates are not an enabled runner
  // — since wave 16 the guard probe (`probe.ts`) reads them as `false` under
  // `@tessera/types`' `ATF_RUNNER_SAFE_DIRECTION` — so the two adapters agree
  // on when the runner is on.
  // Delegated decision 2026-09-30 (wave 14): an incomplete read faults, like
  // an unreadable one. Ten agreeing `true` rows used to read as enabled with a
  // differing eleventh row never fetched; answering "not enabled" instead
  // would plan a DR-3 write that names the wrong problem.
  const incomplete = incompletePropertyRead(
    ATF_RUNNER_ENABLED_PROPERTY,
    records.length,
    total,
  );
  if (incomplete !== undefined) {
    throw new SkeletonInfrastructureError(
      `could not read ${ATF_RUNNER_ENABLED_PROPERTY} completely: ${incomplete}`,
    );
  }
  if (records.length === 0) return false;
  return records.every(
    (row) =>
      (readField(row, "value") ?? "").trim().toLowerCase() === ENABLED_VALUE,
  );
}
