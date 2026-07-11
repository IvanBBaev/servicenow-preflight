import type { Check, CheckResult } from "../types.js";
import {
  SnAuthError,
  SnHttpError,
  SnNetworkError,
  type SnClient,
} from "../http/client.js";
import { eq } from "../http/query.js";

const NAME = "update-set-state";

/**
 * The only `sys_update_set.state` value that is safe to ship. This is the LOCAL
 * update-set vocabulary — a local set is `in progress`, `complete`, or `ignore`.
 * (`loaded`/`previewed`/`committed` belong to `sys_remote_update_set` on the
 * *retrieved* side; `building`/`saved`/`merged`/`collision` are not real
 * `sys_update_set` states at all.)
 */
const SHIPPABLE_STATE = "complete";

/** Local states meaning the set is still being worked on. */
const IN_PROGRESS_STATES = new Set(["in progress", "in_progress"]);

/**
 * `ignore` is a deliberate "do not migrate this set" marker. It is neither
 * shippable nor merely unfinished — it must be surfaced as its own failure so a
 * pipeline never silently deploys (or nags someone to "finish") a set the author
 * explicitly excluded.
 */
const IGNORE_STATE = "ignore";

/**
 * Read a string-ish value, unwrapping a `{ value }` reference object. Table API
 * reference columns arrive as `{ link, value }` (or `""` when empty), never a
 * bare string — so `sys_id`, `state`, `name`, `base_update_set` all funnel
 * through here.
 */
function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") return inner.trim();
    if (typeof inner === "number") return String(inner);
  }
  return "";
}

/** The set's state, lower-cased for comparison. */
function readState(row: Record<string, unknown>): string {
  return str(row.state).toLowerCase();
}

/** A human-friendly label for the set (its name, else its sys_id). */
function readLabel(row: Record<string, unknown>, fallbackId: string): string {
  const name = str(row.name);
  return name || fallbackId;
}

/**
 * A merged child set carries a non-empty `base_update_set` reference (the batch
 * base it was merged into). Because the Table API returns that column as a
 * `{ link, value }` object — never a bare string — the merge signal only shows
 * up once the reference is unwrapped.
 */
function isMergedChild(row: Record<string, unknown>): boolean {
  return str(row.base_update_set) !== "";
}

/** One update set in the batch, distilled to what the verdict needs. */
interface BatchSet {
  id: string;
  label: string;
  state: string;
  merged: boolean;
  changeCount: number;
}

/**
 * Load the update-set batch rooted at `rootId`: the root plus every descendant
 * linked through `sys_update_set.parent` (London+ batches child sets under a
 * parent container). Returns the raw rows (root first, breadth-first) or `null`
 * when the root does not exist. Following the parent links is what stops a
 * "complete" parent container from masking an `in progress` child.
 */
async function loadBatch(
  http: SnClient,
  rootId: string,
): Promise<Record<string, unknown>[] | null> {
  const root = await http.table("sys_update_set").get(rootId);
  if (!root) return null;

  const byId = new Map<string, Record<string, unknown>>();
  const rootKey = str(root.sys_id) || rootId;
  byId.set(rootKey, root);

  let frontier = [rootKey];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const parentId of frontier) {
      const children = await http.table("sys_update_set").query({
        // `parentId` is user input (the root) or an instance sys_id — validated
        // through the query builder so neither can inject an encoded-query
        // operator (SR-1).
        sysparm_query: eq("parent", parentId),
        sysparm_fields: "sys_id,name,state,parent,base_update_set",
      });
      for (const child of children) {
        const cid = str(child.sys_id);
        if (cid && !byId.has(cid)) {
          byId.set(cid, child);
          next.push(cid);
        }
      }
    }
    frontier = next;
  }

  return [...byId.values()];
}

/** Count the change rows (`sys_update_xml`) belonging to a single set. */
async function countChanges(http: SnClient, setId: string): Promise<number> {
  const rows = await http.table("sys_update_xml").query({
    // `setId` is the user-supplied root or an instance sys_id — validated
    // through the query builder to keep operators out of the query (SR-1).
    sysparm_query: eq("update_set", setId),
    sysparm_fields: "sys_id",
  });
  return rows.length;
}

/** Build a `CheckResult` for this check with the frozen name. */
function result(status: CheckResult["status"], message: string): CheckResult {
  return { name: NAME, status, message };
}

/** Render a "label (state)" list for the failing/odd sets in a message. */
function describeStates(sets: BatchSet[]): string {
  return sets
    .map((s) => `"${s.label}" (state "${s.state || "unknown"}")`)
    .join(", ");
}

/**
 * Verifies the target update set — and the batch it heads — is in a deployable
 * state before shipping.
 *
 * Given `ctx.updateSetId`, reads the `sys_update_set` record, follows
 * `parent` links to include every child set in the batch, and counts each set's
 * `sys_update_xml` change rows. Classification uses the LOCAL update-set
 * vocabulary only (`in progress` / `complete` / `ignore`):
 *
 * - **pass** — every set in the batch is `complete` and the batch carries at
 *   least one change (a pure container parent with changed children is not
 *   "empty").
 * - **warn** — no update set was specified, some set is in an unrecognised
 *   state, the instance was transiently unreachable, or a set is a merged/base
 *   set (deployable, but merges can carry collisions — review it).
 * - **fail** — the set does not exist; any set is still `in progress`; any set
 *   is `ignore` (explicitly do-not-migrate); the batch is `complete` but empty;
 *   or the read failed for auth/HTTP reasons.
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
        'No update set specified (set SNPF_UPDATE_SET, add "updateSetId" to the config file, or set PreflightContext.updateSetId); skipping the update-set state check.',
      );
    }

    let sets: BatchSet[];
    try {
      const rawSets = await loadBatch(ctx.http, updateSetId);
      if (!rawSets) {
        return result(
          "fail",
          `Update set "${updateSetId}" was not found on the instance.`,
        );
      }
      sets = [];
      for (const raw of rawSets) {
        const id = str(raw.sys_id) || updateSetId;
        sets.push({
          id,
          label: readLabel(raw, id),
          state: readState(raw),
          merged: isMergedChild(raw),
          changeCount: await countChanges(ctx.http, id),
        });
      }
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

    const root = sets[0];
    if (!root) {
      return result(
        "fail",
        `Update set "${updateSetId}" could not be read from the instance.`,
      );
    }
    const isBatch = sets.length > 1;
    const rootLabel = root.label;

    // `ignore` — explicitly do-not-migrate. Its own verdict, never "finish it".
    const ignored = sets.filter((s) => s.state === IGNORE_STATE);
    if (ignored.length > 0) {
      if (!isBatch) {
        return result(
          "fail",
          `Update set "${root.label}" is marked "ignore" — explicitly flagged do-not-migrate; it must not be deployed. Remove it from this deployment or change its state.`,
        );
      }
      return result(
        "fail",
        `Update set batch "${rootLabel}" includes ${ignored.length} set(s) marked "ignore" (explicitly do-not-migrate): ${ignored
          .map((s) => `"${s.label}"`)
          .join(", ")} — remove them or change their state before deploying.`,
      );
    }

    // Any set still in progress fails the batch — naming the offending child so
    // a "complete" parent container cannot mask an unfinished child set.
    const inProgress = sets.filter((s) => IN_PROGRESS_STATES.has(s.state));
    if (inProgress.length > 0) {
      if (!isBatch) {
        return result(
          "fail",
          `Update set "${root.label}" is still in progress (state "${root.state}") — complete it before deploying.`,
        );
      }
      return result(
        "fail",
        `Update set batch "${rootLabel}" has ${inProgress.length} set(s) still in progress: ${describeStates(
          inProgress,
        )} — complete them before deploying.`,
      );
    }

    // Anything that is not `complete` at this point is an unrecognised state.
    const unrecognised = sets.filter((s) => s.state !== SHIPPABLE_STATE);
    if (unrecognised.length > 0) {
      if (!isBatch) {
        return result(
          "warn",
          `Update set "${root.label}" is in an unrecognised state "${root.state || "unknown"}" (${root.changeCount} change(s)); expected "complete".`,
        );
      }
      return result(
        "warn",
        `Update set batch "${rootLabel}" has ${unrecognised.length} set(s) in an unrecognised state: ${describeStates(
          unrecognised,
        )}; expected "complete".`,
      );
    }

    // Every set is `complete`. Judge the batch as a whole.
    const totalChanges = sets.reduce((n, s) => n + s.changeCount, 0);
    if (totalChanges === 0) {
      return result(
        "fail",
        `Update set ${isBatch ? `batch "${rootLabel}"` : `"${rootLabel}"`} is complete but contains 0 changes${
          isBatch ? " across the batch" : ""
        } — nothing to deploy.`,
      );
    }

    const merged = sets.filter((s) => s.merged);
    if (merged.length > 0) {
      return result(
        "warn",
        `Update set ${isBatch ? "batch " : ""}"${rootLabel}" includes a merged/base update set (${merged
          .map((s) => `"${s.label}"`)
          .join(
            ", ",
          )}); merges can carry collisions — review before deploying.`,
      );
    }

    return result(
      "pass",
      `Update set ${isBatch ? `batch "${rootLabel}"` : `"${rootLabel}"`} is complete and consistent (${totalChanges} change(s)${
        isBatch ? ` across ${sets.length} sets` : ""
      }).`,
    );
  },
};
