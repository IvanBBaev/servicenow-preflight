import type { SnClient } from "../http/client.js";
import {
  emptyManifest,
  logicalId,
  mergeManifest,
  type AtfCoverage,
  type AtfRunRef,
  type AtfSuiteState,
  type AtfTestState,
  type StateManifest,
} from "./manifest.js";

/**
 * `sync` — pull ATF metadata from an instance into a {@link StateManifest}.
 *
 * Reads are done over the **Table API** (there is no ATF create/list CI/CD
 * endpoint — the CI/CD API is suite-run only; per-test detail lives in
 * `sys_atf_test_result*`). `sync` is strictly **read-only** against the
 * instance: it never mutates ATF. The pulled snapshot is merged into the
 * committed manifest (see {@link mergeManifest}) so logical `id`s stay stable.
 */

/** ATF tables read during a sync. */
const TEST_TABLE = "sys_atf_test";
const SUITE_TABLE = "sys_atf_test_suite";
const SUITE_TEST_TABLE = "sys_atf_test_suite_test";
const TEST_RESULT_TABLE = "sys_atf_test_result";

/** Options controlling a {@link pullManifest} run. */
export interface SyncOptions {
  /** Restrict tests/suites to this scope (dot-walked `sys_scope.scope`). */
  scope?: string;
  /** Also pull each test's most recent `sys_atf_test_result` (extra queries). */
  withLastRun?: boolean;
  /** ISO timestamp stamped as `syncedAt` (injectable for deterministic tests). */
  now?: string;
  /** Per-query row cap (defensive; default 1000). */
  limit?: number;
}

/** Coerce an unknown field to a trimmed string ("" when absent). */
function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

/** ServiceNow booleans arrive as `"true"`/`"false"` (or real booleans in a fake). */
function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return str(value).toLowerCase() === "true";
}

/**
 * A reference field may arrive as a plain sys_id string or, with display values
 * on, as `{ value, display_value }`. Extract the raw `value`.
 */
function refValue(value: unknown): string {
  if (value && typeof value === "object" && "value" in value) {
    return str(value.value);
  }
  return str(value);
}

/** Read the scope name from a test/suite row (dot-walked field or reference). */
function rowScope(
  row: Record<string, unknown>,
  fallback?: string,
): string | undefined {
  return (
    str(row["sys_scope.scope"]) ||
    str(row.scope) ||
    refValue(row.sys_scope) ||
    fallback ||
    undefined
  );
}

/** Optional coverage hint carried on a test row (best-effort; often absent). */
function rowCoverage(row: Record<string, unknown>): AtfCoverage | undefined {
  const type = str(row.covers_type) || str(row.coverage_type);
  const name = str(row.covers_name) || str(row.coverage_name);
  if (type && name) return { type, name };
  return undefined;
}

/** Build the `sysparm_query` for a scoped table read. */
function scopedQuery(scope: string | undefined, extra?: string): string {
  const parts: string[] = [];
  if (scope) parts.push(`sys_scope.scope=${scope}`);
  if (extra) parts.push(extra);
  return parts.join("^");
}

/** Pull the tests for a scope into {@link AtfTestState}s (no `lastRun` yet). */
async function pullTests(
  client: SnClient,
  opts: SyncOptions,
): Promise<AtfTestState[]> {
  const rows = await client.table(TEST_TABLE).query({
    sysparm_query: scopedQuery(opts.scope),
    sysparm_limit: String(opts.limit ?? 1000),
  });
  return rows
    .filter((r) => str(r.sys_id))
    .map((r) => {
      const name = str(r.name) || str(r.sys_id);
      const scope = rowScope(r, opts.scope);
      const test: AtfTestState = {
        id: logicalId(scope, name),
        sysId: str(r.sys_id),
        name,
        active: bool(r.active),
      };
      const covers = rowCoverage(r);
      if (covers) test.covers = covers;
      return test;
    });
}

/**
 * Pull suites and their member tests. Membership comes from
 * `sys_atf_test_suite_test` (suite → test link rows); each linked test sys_id is
 * mapped to its logical `id` via `testBySysId`.
 */
async function pullSuites(
  client: SnClient,
  opts: SyncOptions,
  testBySysId: Map<string, AtfTestState>,
): Promise<AtfSuiteState[]> {
  const suiteRows = await client.table(SUITE_TABLE).query({
    sysparm_query: scopedQuery(opts.scope),
    sysparm_limit: String(opts.limit ?? 1000),
  });

  const linkRows = await client.table(SUITE_TEST_TABLE).query({
    sysparm_limit: String(opts.limit ?? 1000),
  });
  const testIdsBySuite = new Map<string, string[]>();
  for (const link of linkRows) {
    const suiteId = refValue(link.test_suite);
    const testSysId = refValue(link.test);
    if (!suiteId || !testSysId) continue;
    const test = testBySysId.get(testSysId);
    if (!test) continue;
    const list = testIdsBySuite.get(suiteId) ?? [];
    list.push(test.id);
    testIdsBySuite.set(suiteId, list);
  }

  return suiteRows
    .filter((r) => str(r.sys_id))
    .map((r) => {
      const name = str(r.name) || str(r.sys_id);
      const sysId = str(r.sys_id);
      return {
        id: logicalId(rowScope(r, opts.scope), name),
        sysId,
        name,
        testIds: testIdsBySuite.get(sysId) ?? [],
      };
    });
}

/** Normalise a raw `sys_atf_test_result.status` to `pass` / `fail` / raw. */
function normaliseRunStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (s === "success" || s === "passed" || s === "pass") return "pass";
  if (["failure", "failed", "error", "errored", "fail"].includes(s))
    return "fail";
  return s || "unknown";
}

/** Attach each test's most recent `sys_atf_test_result` as `lastRun`. */
async function attachLastRuns(
  client: SnClient,
  tests: AtfTestState[],
  opts: SyncOptions,
): Promise<void> {
  for (const test of tests) {
    if (!test.sysId) continue;
    const rows = await client.table(TEST_RESULT_TABLE).query({
      sysparm_query: `test=${test.sysId}^ORDERBYDESCsys_created_on`,
      sysparm_limit: "1",
    });
    const row = rows[0];
    if (!row) continue;
    const at = str(row.sys_created_on) || opts.now || "";
    const lastRun: AtfRunRef = {
      at,
      status: normaliseRunStatus(str(row.status)),
    };
    const resultId = str(row.sys_id);
    if (resultId) lastRun.resultId = resultId;
    test.lastRun = lastRun;
  }
}

/**
 * Pull a fresh {@link StateManifest} snapshot from an instance. This is the raw
 * instance reality — NOT merged with any committed manifest. Callers typically
 * pass the result to {@link mergeManifest} against {@link loadManifest} output
 * and then {@link writeManifest} it.
 */
export async function pullManifest(
  client: SnClient,
  instance: string,
  url: string | undefined,
  opts: SyncOptions = {},
): Promise<StateManifest> {
  const tests = await pullTests(client, opts);
  if (opts.withLastRun) await attachLastRuns(client, tests, opts);

  const testBySysId = new Map<string, AtfTestState>();
  for (const t of tests) if (t.sysId) testBySysId.set(t.sysId, t);

  const suites = await pullSuites(client, opts, testBySysId);

  const manifest = emptyManifest(instance, url, opts.scope);
  manifest.tests = tests;
  manifest.suites = suites;
  if (opts.now) manifest.syncedAt = opts.now;
  return manifest;
}

/**
 * Convenience: pull a snapshot and merge it into an existing committed manifest,
 * returning the manifest to write. Pure w.r.t. the filesystem — the caller reads
 * `existing` and writes the result.
 */
export async function syncManifest(
  client: SnClient,
  instance: string,
  url: string | undefined,
  existing: StateManifest | undefined,
  opts: SyncOptions = {},
): Promise<StateManifest> {
  const snapshot = await pullManifest(client, instance, url, opts);
  return mergeManifest(existing, snapshot);
}
