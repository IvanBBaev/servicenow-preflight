// Vendored from github.com/IvanBBaev/servicenow-mcp @ 5acdcc7 (src/api/aggregate.ts).
// MIT upstream; vendored by the sole author/copyright owner (ADR-002).

import { snRequest } from "../core/http.js";
import { assertTableAllowed } from "../core/policy.js";
import { expectResult } from "./shared.js";

/**
 * ServiceNow Aggregate (Stats) API: server-side count/avg/min/max/sum with
 * optional grouping, so the model can summarise without pulling every row.
 */

export interface AggregateOptions {
  table: string;
  query?: string;
  count?: boolean;
  avgFields?: string[];
  minFields?: string[];
  maxFields?: string[];
  sumFields?: string[];
  groupBy?: string[];
  having?: string;
}

export async function aggregate(opts: AggregateOptions): Promise<unknown> {
  assertTableAllowed(opts.table);
  const params = new URLSearchParams();
  if (opts.query) params.set("sysparm_query", opts.query);
  if (opts.count) params.set("sysparm_count", "true");
  if (opts.avgFields?.length)
    params.set("sysparm_avg_fields", opts.avgFields.join(","));
  if (opts.minFields?.length)
    params.set("sysparm_min_fields", opts.minFields.join(","));
  if (opts.maxFields?.length)
    params.set("sysparm_max_fields", opts.maxFields.join(","));
  if (opts.sumFields?.length)
    params.set("sysparm_sum_fields", opts.sumFields.join(","));
  if (opts.groupBy?.length)
    params.set("sysparm_group_by", opts.groupBy.join(","));
  if (opts.having) params.set("sysparm_having", opts.having);

  const { data } = await snRequest<{ result: unknown }>({
    method: "GET",
    path: `/api/now/stats/${encodeURIComponent(opts.table)}`,
    params,
  });
  return expectResult(data, "Aggregate API");
}

export interface CountRowsOptions {
  table: string;
  /** Encoded query; absent counts every row of the table. */
  query?: string;
}

/**
 * Why {@link countRows} has no count:
 *
 * - `request-failed` — the Stats API request failed (HTTP error, transport
 *   error, timeout, a 403 on the stats resource).
 * - `malformed-response` — the request succeeded but `result.stats.count`
 *   is missing or not a non-negative integer.
 */
export type CountRowsFailureReason = "request-failed" | "malformed-response";

export type CountRowsResult =
  | { ok: true; count: number }
  | { ok: false; reason: CountRowsFailureReason; message: string };

/**
 * Read `result.stats.count` out of a Stats API body, fail-closed.
 *
 * ServiceNow sends the count as a decimal STRING (`{"result":{"stats":
 * {"count":"42"}}}`). Only a plain run of digits that is a safe integer is
 * accepted; anything else — missing, empty, signed, fractional, exponent,
 * hex, padded, beyond 2^53 — answers `undefined`, never 0, so a caller can
 * not mistake an unreadable count for "no rows".
 *
 * Delegated decision 2026-09-30 (wave 16): a JSON NUMBER that is a
 * non-negative safe integer is accepted too. It is not the documented
 * shape, but it is unambiguous; every other non-string type is refused.
 */
export function parseStatsCount(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const result: unknown = (data as { result?: unknown }).result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return undefined;
  }
  const stats: unknown = (result as { stats?: unknown }).stats;
  if (typeof stats !== "object" || stats === null) return undefined;
  const raw: unknown = (stats as { count?: unknown }).count;
  let value: number;
  if (typeof raw === "string") {
    if (!/^\d+$/.test(raw)) return undefined;
    value = Number(raw);
  } else if (typeof raw === "number") {
    value = raw;
  } else {
    return undefined;
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Count the rows matching `query` via the Aggregate (Stats) API
 * (`GET /api/now/stats/<table>?sysparm_count=true`). Never throws for an
 * instance-side failure: a failed request or an unreadable count comes back
 * as a typed failure, so a caller can fail closed instead of reading 0.
 *
 * UNVERIFIED (wave 16): whether this count honours row-level read ACLs on a
 * real instance is not established by any live capture in this repo. If it
 * is ACL-filtered it counts only the rows the caller may read — see the
 * `crossCheckCount` notes in `api/table.ts` for what that means.
 *
 * Delegated decision 2026-09-30 (wave 16): the table policy check
 * (`assertTableAllowed`) still THROWS, like every other api function — a
 * denied table is the operator's configuration, not an instance answer, and
 * must not be flattened into "count unavailable".
 */
export async function countRows(
  opts: CountRowsOptions,
): Promise<CountRowsResult> {
  assertTableAllowed(opts.table);
  const params = new URLSearchParams();
  if (opts.query) params.set("sysparm_query", opts.query);
  params.set("sysparm_count", "true");
  let data: unknown;
  try {
    ({ data } = await snRequest<unknown>({
      method: "GET",
      path: `/api/now/stats/${encodeURIComponent(opts.table)}`,
      params,
    }));
  } catch (error) {
    return {
      ok: false,
      reason: "request-failed",
      message: error instanceof Error ? error.message : "non-Error thrown",
    };
  }
  const count = parseStatsCount(data);
  if (count === undefined) {
    return {
      ok: false,
      reason: "malformed-response",
      message:
        "Unexpected response from ServiceNow Aggregate API: result.stats.count is missing or not a non-negative integer.",
    };
  }
  return { ok: true, count };
}
