import type { Check, CheckResult, CheckStatus } from "../types.js";
import {
  SnAuthError,
  SnHttpError,
  SnNetworkError,
  type SnClient,
} from "../http/client.js";
import { chunk, inClause } from "../http/query.js";

const NAME = "remote-set-preview";

/**
 * `sys_remote_update_set.state` values this gate understands. This is the
 * RETRIEVED-side vocabulary — distinct from the LOCAL `sys_update_set` states
 * (`in progress` / `complete` / `ignore`) the `update-set-state` check reads.
 * Which values are pending vs terminal, and why (OPP-4):
 *
 * - `loaded` — retrieved onto the target but never previewed. PENDING: it can
 *   be committed at any moment, and committing without a preview is exactly
 *   the accident this gate exists to stop → fail.
 * - `previewed` — the preview ran; whether it is CLEAN is decided by its
 *   `sys_update_preview_problem` rows, never by the state alone. PENDING.
 * - `committed` — already applied to the target. TERMINAL: the commit has
 *   happened, so there is nothing left for a pre-deployment gate to stop.
 *
 * Anything else (a transient mid-commit / mid-retrieval value, or a custom
 * state) is pending-but-unverifiable → warn, never pass (fail-closed).
 */
const LOADED_STATE = "loaded";
const PREVIEWED_STATE = "previewed";
const COMMITTED_STATE = "committed";

/**
 * Filter for the `sys_remote_update_set` read. A static literal — no dynamic
 * value is interpolated, so the validated query builder is not needed for this
 * clause; every DYNAMIC value in this check flows through `inClause` (SR-1).
 * Excluding `committed` keeps years of terminal history out of the
 * (auto-paginating) read while every non-terminal row — including unexpected
 * states — is still fetched and classified client-side (OPP-4).
 */
const PENDING_QUERY = `state!=${COMMITTED_STATE}`;

/**
 * `sys_update_preview_problem.status` values meaning a human explicitly
 * resolved the problem. "Accept remote update" records `ignored` (the
 * platform's raw value — the local record is kept and the incoming change
 * discarded), "Skip remote update" records `skipped`. `accepted` is retained
 * as a defensive superset member so a platform version that emits it is still
 * read as resolved. Anything else — the empty status of a fresh problem or an
 * unrecognised custom value — reads as UNRESOLVED, so a weird status can never
 * sneak a collision past the gate (OPP-4, fail-closed).
 */
const RESOLVED_STATUSES = new Set(["ignored", "accepted", "skipped"]);

/**
 * The advisory `sys_update_preview_problem.type`. The only other stock value is
 * `error`; an unknown/empty type is counted as an ERROR, not a warning, so a
 * malformed problem row cannot soften the verdict (OPP-4, fail-closed).
 */
const WARNING_TYPE = "warning";

/** At most this many problem descriptions are quoted in a fail message. */
const MAX_SAMPLES = 3;

/** Longest quoted problem description before it is ellipsised. */
const SAMPLE_MAX_LENGTH = 120;

/**
 * Read a string-ish value, unwrapping a `{ value }` reference object. Table API
 * reference columns arrive as `{ link, value }` (or `""` when empty), never a
 * bare string — `sys_update_preview_problem.remote_update_set` is one such
 * column, so every cell read funnels through here.
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

/** The retrieved set's state, lower-cased for comparison. */
function readState(row: Record<string, unknown>): string {
  return str(row.state).toLowerCase();
}

/** Outcome of parsing the optional `updateSetId` focus value. */
type FocusParse =
  { kind: "ok"; focus?: string } | { kind: "malformed"; got: string };

/**
 * Parse the optional focus value. `ctx.updateSetId` is typed as a string, but a
 * programmatic caller can hand anything through — a malformed value is
 * surfaced as a warn, never silently treated as "gate everything" (OPP-4;
 * mirrors the malformed-entry handling of scoped-app-deps' options parsing).
 * An absent or blank value means "no focus": gate every pending set.
 */
function parseFocus(raw: unknown): FocusParse {
  if (raw === undefined || raw === null) return { kind: "ok" };
  if (typeof raw !== "string") return { kind: "malformed", got: typeof raw };
  const trimmed = raw.trim();
  return trimmed === "" ? { kind: "ok" } : { kind: "ok", focus: trimmed };
}

/**
 * True when a retrieved set is the one the configured `updateSetId` points at.
 * Matched client-side (never interpolated into `sysparm_query`) against:
 *
 * - `remote_sys_id` — a retrieved set carries the ORIGIN set's sys_id here, so
 *   the same `updateSetId` that drives the local-side `update-set-state` check
 *   on the source instance finds its retrieved copy on the target (OPP-4);
 * - `sys_id` — in case the caller points at the remote row itself;
 * - `name` — case-insensitively, for name-keyed configs.
 *
 * Client-side matching also sidesteps the query builder's identifier charset
 * (names may carry spaces) without ever building a query from the value (SR-1).
 */
function matchesFocus(row: Record<string, unknown>, focus: string): boolean {
  const wanted = focus.toLowerCase();
  return (
    str(row.remote_sys_id).toLowerCase() === wanted ||
    str(row.sys_id).toLowerCase() === wanted ||
    str(row.name).toLowerCase() === wanted
  );
}

/** The retrieved sets matching the focus value (see {@link matchesFocus}). */
function filterByFocus(
  rows: Record<string, unknown>[],
  focus: string,
): Record<string, unknown>[] {
  return rows.filter((row) => matchesFocus(row, focus));
}

/** One previewed set's problem rows, distilled to what the verdict needs. */
interface ProblemTally {
  unresolvedErrors: number;
  unresolvedWarnings: number;
  /** Problems a human explicitly accepted/skipped — resolved, but reviewable. */
  resolved: number;
  /** Bounded sample descriptions of the unresolved errors. */
  samples: string[];
}

/** A problem description bounded for a message; never empty. */
function sample(row: Record<string, unknown>): string {
  const text = str(row.description) || "(no description)";
  return text.length <= SAMPLE_MAX_LENGTH
    ? text
    : `${text.slice(0, SAMPLE_MAX_LENGTH - 1)}…`;
}

/** Classify one previewed set's `sys_update_preview_problem` rows. */
function tallyProblems(rows: Record<string, unknown>[]): ProblemTally {
  const tally: ProblemTally = {
    unresolvedErrors: 0,
    unresolvedWarnings: 0,
    resolved: 0,
    samples: [],
  };
  for (const row of rows) {
    if (RESOLVED_STATUSES.has(str(row.status).toLowerCase())) {
      tally.resolved++;
      continue;
    }
    // Unresolved. Only an explicit `warning` type is advisory — an unknown or
    // empty type counts as an error so it can never soften the verdict (OPP-4).
    if (str(row.type).toLowerCase() === WARNING_TYPE) {
      tally.unresolvedWarnings++;
      continue;
    }
    tally.unresolvedErrors++;
    if (tally.samples.length < MAX_SAMPLES) tally.samples.push(sample(row));
  }
  return tally;
}

/**
 * Batch-fetch the preview problems for every previewed set in one go, grouped
 * by `remote_update_set` sys_id. The ids are packed into
 * `remote_update_setIN…` clauses of at most `IN_CHUNK_SIZE` (SN-6) and each id
 * is charset-validated by {@link inClause}, so the batched query cannot be
 * injected into (SR-1). Uses `queryWithMeta` so ACL security-trimming of the
 * problem rows is surfaced: hidden problems mean a "clean" preview cannot be
 * trusted, so the caller must degrade to unverified rather than pass (OPP-4).
 */
async function fetchProblemsBySet(
  http: SnClient,
  setIds: readonly string[],
): Promise<{
  bySet: Map<string, Record<string, unknown>[]>;
  trimmed: boolean;
}> {
  const bySet = new Map<string, Record<string, unknown>[]>();
  for (const id of setIds) bySet.set(id, []);
  let trimmed = false;
  for (const ids of chunk(setIds)) {
    // No `sysparm_limit`: the client auto-paginates, so a set with more
    // problems than a single page can never look cleaner through truncation.
    const { rows, securityTrimmed } = await http
      .table("sys_update_preview_problem")
      .queryWithMeta({
        sysparm_query: inClause("remote_update_set", ids),
        sysparm_fields: "sys_id,remote_update_set,type,status,description",
      });
    if (securityTrimmed) trimmed = true;
    for (const row of rows) {
      const list = bySet.get(str(row.remote_update_set));
      if (list) list.push(row);
    }
  }
  return { bySet, trimmed };
}

/** Build a `CheckResult` for this check with the frozen name. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Target-side preview gate for retrieved update sets (OPP-4). Before a promote
 * commits anything on the TARGET instance, every pending
 * `sys_remote_update_set` must have been previewed and every
 * `sys_update_preview_problem` resolved — the preview on the target is where
 * update-set collisions actually surface, so this check is the legitimate home
 * of the collision-detection intent the local-side `update-set-state` check
 * deliberately does not carry (CC-42).
 *
 * Focus: reuses the same `updateSetId` configuration that drives
 * `update-set-state` (config `updateSetId` / env `SNPF_UPDATE_SET` /
 * `PreflightContext.updateSetId`), so one config drives both sides of a
 * promote. When set, it is matched client-side against each retrieved set's
 * `remote_sys_id` (the origin set's sys_id), its own `sys_id`, or its `name`.
 * When unset, ALL pending (not yet committed) retrieved sets are gated.
 *
 * - **fail** — a gated set is `loaded` but its preview has never been run; a
 *   previewed set has unresolved preview problems of type `error` (or an
 *   unknown type — fail-closed); or the read failed for auth/network reasons.
 * - **warn** — no credentials are configured (nothing to authenticate the
 *   reads with — `connectivity-auth` already names the fix, so an unconfigured
 *   run is not failed twice); a previewed set carries only unresolved
 *   `warning` problems and/or problems explicitly resolved as
 *   accepted/skipped; a set is in an unrecognised state; the configured set
 *   has no pending retrieved copy on the target (it may simply not be
 *   retrieved yet); rows are hidden by ACL security-trimming; `updateSetId` is
 *   malformed; or another transport error left the gate unverified.
 * - **pass** — every gated pending set is `previewed` with zero preview
 *   problems, or (with no focus configured) nothing is pending at all.
 *
 * Never throws: `SnAuthError` / `SnNetworkError` map to `fail`, other
 * transport errors map to `warn` (explicitly unverified).
 */
export const remoteSetPreview: Check = {
  name: NAME,
  description:
    "Retrieved update sets on the target instance have a clean preview.",
  async run(ctx): Promise<CheckResult> {
    // With nothing to authenticate as, the reads below can only fail at the
    // transport layer — a configuration gap, not an instance problem. Warn and
    // skip (mirroring connectivity-auth, which names the fix) so an
    // unconfigured default run is not turned into a hard fail.
    if (!ctx.auth && !ctx.tls) {
      return result(
        "warn",
        "No credentials configured; cannot verify retrieved update set previews (set SNPF_USER/SNPF_PASS, SNPF_TOKEN, SNPF_API_KEY, an OAuth grant, or SNPF_MTLS_CERT/KEY).",
      );
    }

    const parsed = parseFocus(ctx.updateSetId);
    if (parsed.kind === "malformed") {
      return result(
        "warn",
        `Malformed updateSetId (expected a string, got ${parsed.got}); the remote preview gate is unverified.`,
      );
    }
    const focus = parsed.focus;

    try {
      // `queryWithMeta` so a zero-row (or short) read caused by ACL
      // security-trimming is a signal, never mistaken for "nothing pending".
      const { rows, totalCount, securityTrimmed } = await ctx.http
        .table("sys_remote_update_set")
        .queryWithMeta({
          sysparm_query: PENDING_QUERY,
          sysparm_fields: "sys_id,name,state,remote_sys_id",
        });

      const candidates =
        focus === undefined ? rows : filterByFocus(rows, focus);
      // Defensive: the query already excludes `committed`, but a row that
      // slips through (e.g. a fake or an odd query translation) is terminal —
      // already applied — and must not be gated (OPP-4).
      const pending = candidates.filter(
        (row) => readState(row) !== COMMITTED_STATE,
      );

      if (pending.length === 0) {
        if (securityTrimmed) {
          return result(
            "warn",
            `Cannot verify retrieved update sets: ${totalCount ?? "some"} pending row(s) match but only ${rows.length} are visible — the account is security-trimmed on sys_remote_update_set; the preview gate is unverified.`,
          );
        }
        if (focus !== undefined) {
          // Never a silent pass: the configured set simply may not have been
          // retrieved on the target yet, which is itself a promote blocker.
          return result(
            "warn",
            `No pending retrieved update set matching "${focus}" was found on the target instance — it may simply not have been retrieved yet (or was already committed). Retrieve and preview it before deploying; this gate could not verify it.`,
          );
        }
        return result(
          "pass",
          "No pending retrieved update sets on the target instance — nothing awaiting preview or commit.",
        );
      }

      // Classify each pending set by state (see the state vocabulary above).
      const loadedLabels: string[] = [];
      const unrecognised: string[] = [];
      const previewed: { id: string; label: string }[] = [];
      for (const row of pending) {
        const state = readState(row);
        const id = str(row.sys_id);
        const label = str(row.name) || id || "(unnamed)";
        if (state === PREVIEWED_STATE) {
          if (id === "") {
            // Without a sys_id its problem rows cannot be queried — the
            // preview cannot be confirmed clean, so it must not pass (OPP-4).
            unrecognised.push(
              `"${label}" (previewed, but its sys_id is unreadable — preview problems cannot be verified)`,
            );
          } else {
            previewed.push({ id, label });
          }
        } else if (state === LOADED_STATE) {
          loadedLabels.push(label);
        } else {
          unrecognised.push(`"${label}" (state "${state || "unknown"}")`);
        }
      }

      const { bySet, trimmed: problemsTrimmed } = await fetchProblemsBySet(
        ctx.http,
        previewed.map((set) => set.id),
      );

      const failures: string[] = [];
      const warns: string[] = [];
      let clean = 0;

      for (const label of loadedLabels) {
        failures.push(
          `"${label}" is loaded but its preview has not been run — open the retrieved set and run "Preview Update Set" (then resolve every problem) before committing`,
        );
      }

      for (const set of previewed) {
        const tally = tallyProblems(bySet.get(set.id) ?? []);
        if (tally.unresolvedErrors > 0) {
          const quoted = tally.samples.map((s) => `"${s}"`).join("; ");
          failures.push(
            `"${set.label}" has ${tally.unresolvedErrors} unresolved preview error(s) (e.g. ${quoted}) — resolve every error in the preview before committing`,
          );
        } else if (tally.unresolvedWarnings > 0 || tally.resolved > 0) {
          const parts: string[] = [];
          if (tally.unresolvedWarnings > 0) {
            parts.push(
              `${tally.unresolvedWarnings} unresolved preview warning(s)`,
            );
          }
          if (tally.resolved > 0) {
            parts.push(
              `${tally.resolved} preview problem(s) explicitly resolved as accepted/skipped`,
            );
          }
          warns.push(
            `"${set.label}" previewed with ${parts.join(" and ")} — review before committing`,
          );
        } else {
          clean++;
        }
      }

      if (unrecognised.length > 0) {
        warns.push(
          `${unrecognised.length} retrieved set(s) in a state this gate does not recognise (cannot confirm a clean preview): ${unrecognised.join(", ")}`,
        );
      }
      if (securityTrimmed) {
        const hidden =
          totalCount === undefined ? undefined : totalCount - rows.length;
        warns.push(
          `${hidden ?? "some"} retrieved-set row(s) are hidden by ACL security-trimming — the gate may not have seen every pending set (unverified)`,
        );
      }
      if (problemsTrimmed) {
        warns.push(
          "some sys_update_preview_problem rows are hidden by ACL security-trimming — preview cleanliness is unverified",
        );
      }

      if (failures.length > 0) {
        const also = warns.length > 0 ? ` Also: ${warns.join("; ")}.` : "";
        return result(
          "fail",
          `${failures.length} of ${pending.length} pending retrieved update set(s) fail the preview gate: ${failures.join("; ")}.${also}`,
        );
      }
      if (warns.length > 0) {
        return result("warn", `Preview gate advisories: ${warns.join("; ")}.`);
      }
      return result(
        "pass",
        focus !== undefined
          ? `Retrieved update set matching "${focus}" is previewed cleanly (${clean} set(s), 0 unresolved preview problems).`
          : `All ${clean} pending retrieved update set(s) are previewed cleanly (0 unresolved preview problems).`,
      );
    } catch (err) {
      if (err instanceof SnAuthError) {
        return result(
          "fail",
          "Authentication failed while reading sys_remote_update_set / sys_update_preview_problem; cannot verify the preview gate.",
        );
      }
      if (err instanceof SnNetworkError) {
        return result(
          "fail",
          `Could not reach the instance to verify retrieved update set previews: ${err.message}`,
        );
      }
      if (err instanceof SnHttpError) {
        // The tables may be unavailable to this account — advisory.
        return result(
          "warn",
          `Could not read the retrieved update set tables (HTTP ${err.status}); the preview gate is unverified.`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return result(
        "warn",
        `Unexpected error while verifying retrieved update set previews (the preview gate is unverified): ${message}`,
      );
    }
  },
};
