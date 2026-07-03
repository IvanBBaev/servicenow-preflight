import type { Check, CheckResult } from "../types.js";
import { SnAuthError, SnHttpError, SnNetworkError } from "../http/client.js";

const NAME = "update-set-state";

/**
 * Update-set states that are safe to ship. ServiceNow marks a finished set as
 * `complete`; everything else (`in progress`, `building`, `loaded`, `previewed`,
 * `ignore`, `saved`, …) is still in flight and should not be deployed.
 */
const SHIPPABLE_STATES = new Set(["complete"]);

/**
 * States that indicate a set is still being worked on — deploying one of these
 * ships an unfinished, possibly inconsistent set of changes.
 */
const IN_PROGRESS_STATES = new Set([
  "in progress",
  "in_progress",
  "building",
  "loaded",
  "previewed",
  "saved",
  "ignore",
]);

/** Read a string field from a record, trimming and lower-casing for comparison. */
function readState(row: Record<string, unknown>): string {
  const raw = row.state;
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Read a human-friendly label for the set (name, else its sys_id). */
function readLabel(row: Record<string, unknown>, fallbackId: string): string {
  const name = row.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  return fallbackId;
}

/**
 * Detect merge/collision indicators on the set or its change rows. Merged update
 * sets and collision-flagged changes still deploy, but warrant a human look —
 * hence a `warn` rather than a hard `fail`.
 */
function hasCollisionIndicator(
  set: Record<string, unknown>,
  changes: Record<string, unknown>[],
): boolean {
  const state = readState(set);
  if (state === "merged" || state === "collision") return true;

  // Some instances expose a base/merge marker on the set itself.
  const merged = set.merged;
  if (merged === true || merged === "true") return true;
  const base = set.base_update_set;
  if (typeof base === "string" && base.trim()) return true;

  // A change row flagged as a collision / replace-on-upgrade conflict.
  return changes.some((row) => {
    const disposition = row.disposition;
    if (typeof disposition === "string") {
      const d = disposition.trim().toLowerCase();
      if (d === "collision" || d === "skipped") return true;
    }
    const collision = row.collision;
    return collision === true || collision === "true";
  });
}

/** Build a `CheckResult` for this check with the frozen name. */
function result(status: CheckResult["status"], message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Verifies the target update set is in a deployable state before shipping.
 *
 * Given `ctx.updateSetId`, reads the `sys_update_set` record and its
 * `sys_update_xml` change rows, then classifies:
 *
 * - **pass** — the set is `complete` and carries at least one change.
 * - **warn** — no update set was specified, the set is in an unrecognised state,
 *   the instance was transiently unreachable, or the set shows merge/collision
 *   indicators (deployable, but review it).
 * - **fail** — the set does not exist, is still in progress, is `complete` but
 *   empty (nothing to ship), or the read failed for auth/HTTP reasons.
 *
 * A check must never throw: transport/API errors are caught and mapped to a
 * result (auth/HTTP → `fail`, network → `warn`).
 */
export const updateSetState: Check = {
  name: NAME,
  description: "The target update set is in a deployable state.",
  async run(ctx) {
    const updateSetId = ctx.updateSetId?.trim();
    if (!updateSetId) {
      return result(
        "warn",
        "No update set specified (pass --update-set or set PreflightContext.updateSetId); skipping update-set state check.",
      );
    }

    let set: Record<string, unknown> | null;
    let changes: Record<string, unknown>[];
    try {
      set = await ctx.http.table("sys_update_set").get(updateSetId);
      if (!set) {
        return result(
          "fail",
          `Update set "${updateSetId}" was not found on the instance.`,
        );
      }
      changes = await ctx.http.table("sys_update_xml").query({
        sysparm_query: `update_set=${updateSetId}`,
        sysparm_fields: "sys_id,disposition,collision",
      });
    } catch (err) {
      if (err instanceof SnAuthError) {
        return result(
          "fail",
          `Not authorized to read the update set${
            err.status ? ` (HTTP ${err.status})` : ""
          }: ${err.message}`,
        );
      }
      if (err instanceof SnNetworkError) {
        return result(
          "warn",
          `Could not reach the instance to read the update set (transient): ${err.message}`,
        );
      }
      if (err instanceof SnHttpError) {
        return result(
          "fail",
          `Failed to read the update set (HTTP ${err.status}): ${err.message}`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return result(
        "fail",
        `Unexpected error reading the update set: ${message}`,
      );
    }

    const label = readLabel(set, updateSetId);
    const state = readState(set);
    const changeCount = changes.length;

    if (hasCollisionIndicator(set, changes)) {
      return result(
        "warn",
        `Update set "${label}" shows merge/collision indicators (state "${state || "unknown"}", ${changeCount} change(s)); review before deploying.`,
      );
    }

    if (IN_PROGRESS_STATES.has(state)) {
      return result(
        "fail",
        `Update set "${label}" is still in progress (state "${state}") — complete it before deploying.`,
      );
    }

    if (SHIPPABLE_STATES.has(state)) {
      if (changeCount === 0) {
        return result(
          "fail",
          `Update set "${label}" is complete but contains 0 changes — nothing to deploy.`,
        );
      }
      return result(
        "pass",
        `Update set "${label}" is complete and consistent (${changeCount} change(s)).`,
      );
    }

    return result(
      "warn",
      `Update set "${label}" is in an unrecognised state "${state || "unknown"}" (${changeCount} change(s)); expected "complete".`,
    );
  },
};
