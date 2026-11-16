import type { SnClient, TableQueryResult } from "../http/client.js";
import { and, eq, inClause, scopeFilterClause } from "../http/query.js";
import { triageZeroRead } from "../checks/cert-common.js";
import { UsageError } from "../config.js";
import {
  emptyManifest,
  logicalId,
  mergeManifest,
  type AtfCoverage,
  type AtfRunRef,
  type AtfSuiteState,
  type AtfTestState,
  type IdentityMissingReason,
  type InstalledAppState,
  type InstanceIdentity,
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

/** Version-capture tables read during a sync (OPP-1 / OPP-5). */
const PROPERTIES_TABLE = "sys_properties";
const STORE_APP_TABLE = "sys_store_app";
const APP_TABLE = "sys_app";
const PLUGIN_TABLE = "sys_plugins";

/** The `sys_properties` names that identify the platform build (OPP-1). */
const BUILD_NAME_PROPERTY = "glide.buildname";
const WAR_PROPERTY = "glide.war";

/**
 * Fields requested for the test read (CC-15). `sys_scope.scope` is the crucial
 * one: it dot-walks to the scope **name** (e.g. `x_acme_app`). Without it the
 * Table API returns `sys_scope` as a 32-hex sys_id — which is per-instance — and
 * every logical `id` would prefix by that sys_id, producing 100% false drift
 * across instances. The coverage hints are included so a real instance still
 * populates `covers` when the fields exist (the fake ignores `sysparm_fields`).
 */
const TEST_FIELDS =
  "sys_id,name,active,sys_scope.scope,scope,covers_type,covers_name,coverage_type,coverage_name";

/** Fields requested for the suite read — scope name pinned like the tests (CC-15). */
const SUITE_FIELDS = "sys_id,name,sys_scope.scope,scope";

/** Options controlling a {@link pullManifest} run. */
export interface SyncOptions {
  /** Restrict tests/suites to this scope (dot-walked `sys_scope.scope`). */
  scope?: string;
  /** Also pull each test's most recent `sys_atf_test_result` (extra queries). */
  withLastRun?: boolean;
  /** ISO timestamp stamped as `syncedAt` (injectable for deterministic tests). */
  now?: string;
  /**
   * Permit committing an ALL-EMPTY snapshot over a non-empty committed manifest
   * (SN-1). Off by default: an empty pull over real coverage is far more likely
   * a least-privilege/ACL problem than a genuine "all tests deleted", so
   * {@link syncManifest} refuses it unless this is set. It can NOT override a
   * proven security-trim or an unreadable `active` column: those raise
   * {@link IncompleteSnapshotError} before this option is consulted (RR-47).
   */
  allowEmpty?: boolean;
}

/**
 * Thrown by {@link syncManifest} when a pull returns an all-empty snapshot that
 * would overwrite a non-empty committed manifest (SN-1) — the soft refusal a
 * caller can override with `SyncOptions.allowEmpty` once they have confirmed
 * the emptiness is real. A proven security-trim never reaches this refusal: it
 * raises {@link IncompleteSnapshotError} first (RR-47), so `securityTrimmed` is
 * always `false` on an error thrown by this version; the field stays for
 * callers that read it.
 */
export class EmptySnapshotError extends Error {
  /** Kept for compatibility; `false` on every error {@link syncManifest} throws. */
  readonly securityTrimmed: boolean;
  constructor(message: string, securityTrimmed: boolean) {
    super(message);
    this.name = "EmptySnapshotError";
    this.securityTrimmed = securityTrimmed;
  }
}

/**
 * Thrown by {@link pullManifest} / {@link syncManifest} when the ATF reads
 * cannot be trusted to describe the instance (RR-47, ST-1, ST-5, ST-19):
 *
 * - `"security-trimmed"` — the test, suite or suite→test link read reported
 *   more rows (`X-Total-Count`) than this account could see, so the snapshot
 *   would silently drop tests, suites or suite membership;
 * - `"active-unreadable"` — a test row came back without a readable `active`
 *   value (field-level read ACL, or the column is not returned), so every such
 *   test would be recorded inactive and drift could never block on it.
 *
 * Always a hard refusal: `SyncOptions.allowEmpty` does not apply, and nothing
 * is merged or written.
 */
export class IncompleteSnapshotError extends Error {
  /** The table whose read was incomplete. */
  readonly table: string;
  /** Why the read cannot be trusted. */
  readonly reason: "security-trimmed" | "active-unreadable";
  constructor(
    message: string,
    table: string,
    reason: "security-trimmed" | "active-unreadable",
  ) {
    super(message);
    this.name = "IncompleteSnapshotError";
    this.table = table;
    this.reason = reason;
  }
}

/**
 * Refuse a read that ServiceNow proved incomplete (`X-Total-Count` above the
 * visible rows). A partial test, suite or link read is never a snapshot of the
 * instance (RR-47, ST-1, ST-19).
 */
function assertNotTrimmed(
  table: string,
  instanceHint: string,
  read: TableQueryResult,
): void {
  if (!read.securityTrimmed) return;
  throw new IncompleteSnapshotError(
    `Refusing to sync: the instance reported ${String(read.totalCount)} ${table} ` +
      `row(s) for this read but this account can see only ${read.rows.length}. ACL ` +
      `security-trimming is hiding ${instanceHint} — a manifest built from this ` +
      `read would silently drop them. Re-run sync with an account that can read ` +
      `${table} in scope. --allow-empty does not override this.`,
    table,
    "security-trimmed",
  );
}

/**
 * Two same-scope artifacts whose names slug to the same logical `id` would
 * corrupt merge reconciliation (`idRemap`) and suite membership — the second
 * would silently shadow the first, so the manifest would carry one where the
 * instance has two. Detect it at sync time and fail loudly (CC-4).
 */
function assertNoLogicalIdCollisions(
  items: { id: string; name: string }[],
  kind: string,
): void {
  const seen = new Map<string, string>();
  for (const item of items) {
    const prior = seen.get(item.id);
    if (prior !== undefined) {
      throw new Error(
        `Logical id collision: ${kind}s "${prior}" and "${item.name}" both map to ` +
          `"${item.id}". Two ${kind}s in one scope cannot share a slug — rename one ` +
          `so their names slug differently, then re-run sync.`,
      );
    }
    seen.set(item.id, item.name);
  }
}

/** Coerce an unknown field to a trimmed string ("" when absent). */
function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

/**
 * ServiceNow booleans arrive as `"true"`/`"false"` (real booleans in a fake,
 * `{ value }` with display values on). Anything else — absent, `null`, blank
 * or an unknown word — is `undefined`: the value was not readable, and
 * guessing `false` would hide the test from drift (ST-5).
 */
function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const raw = refValue(value).toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
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

/**
 * Build the `sysparm_query` for a scoped table read. The scope is turned into a
 * single-term filter by {@link scopeFilterClause} — a scope NAME dot-walks
 * (`sys_scope.scope=<name>`), a 32-hex sys_id filters directly
 * (`sys_scope=<sysId>`), so `sync` accepts either form consistently (SN-4)
 * without a per-run lookup. Charset-validated, so a config-supplied scope can
 * never inject an encoded-query operator (SR-1). An absent scope yields no scope
 * term (pull everything).
 */
function scopedQuery(scope: string | undefined, extra?: string): string {
  return and(scope ? scopeFilterClause(scope) : "", extra ?? "");
}

/** Pull the tests for a scope into {@link AtfTestState}s (no `lastRun` yet). */
async function pullTests(
  client: SnClient,
  opts: SyncOptions,
): Promise<AtfTestState[]> {
  // No `sysparm_limit`: SnClient auto-paginates, so a scope with more than one
  // page of tests is pulled in full. An explicit cap here silently truncated
  // the manifest, which then compared as drift against the real instance.
  // `queryWithMeta` surfaces `securityTrimmed` (X-Total-Count > visible rows) so
  // an ACL-hidden result set can be distinguished from a genuinely empty one.
  // A trimmed read is refused outright (RR-47, ST-1): dropping the hidden
  // tests would let drift pass a promote they never covered.
  const read = await client.table(TEST_TABLE).queryWithMeta({
    sysparm_query: scopedQuery(opts.scope),
    sysparm_fields: TEST_FIELDS,
  });
  assertNotTrimmed(TEST_TABLE, "ATF tests", read);
  const unreadable: string[] = [];
  const tests = read.rows
    .filter((r) => str(r.sys_id))
    .map((r) => {
      const name = str(r.name) || str(r.sys_id);
      const scope = rowScope(r, opts.scope);
      const active = bool(r.active);
      if (active === undefined) unreadable.push(name);
      const test: AtfTestState = {
        id: logicalId(scope, name),
        sysId: str(r.sys_id),
        name,
        active: active ?? false,
      };
      const covers = rowCoverage(r);
      if (covers) test.covers = covers;
      return test;
    });
  if (unreadable.length > 0) {
    const shown = unreadable
      .slice(0, 5)
      .map((n) => `"${n}"`)
      .join(", ");
    const more =
      unreadable.length > 5 ? ` and ${unreadable.length - 5} more` : "";
    throw new IncompleteSnapshotError(
      `Refusing to sync: ${unreadable.length} ${TEST_TABLE} row(s) came back ` +
        `without a readable "active" value (${shown}${more}). A field-level read ` +
        `ACL or a missing column would record every such test as inactive, and ` +
        `drift never blocks on an inactive test. Re-run sync with an account ` +
        `that can read ${TEST_TABLE}.active.`,
      TEST_TABLE,
      "active-unreadable",
    );
  }
  return tests;
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
  // No `sysparm_limit` on either read — the client auto-paginates (see
  // pullTests). Both reads go through `queryWithMeta` and refuse a proven
  // trim (RR-47): a hidden suite drops out of the manifest, a hidden link row
  // leaves its suite with no members and no signal (ST-19). The link rows are
  // pure join tuples — no scope name, no id to prefix — so no field pinning.
  const suiteRead = await client.table(SUITE_TABLE).queryWithMeta({
    sysparm_query: scopedQuery(opts.scope),
    sysparm_fields: SUITE_FIELDS,
  });
  assertNotTrimmed(SUITE_TABLE, "ATF suites", suiteRead);

  const linkRead = await client.table(SUITE_TEST_TABLE).queryWithMeta({
    sysparm_query: scopedQuery(opts.scope),
  });
  assertNotTrimmed(SUITE_TEST_TABLE, "suite membership rows", linkRead);
  const testIdsBySuite = new Map<string, string[]>();
  for (const link of linkRead.rows) {
    const suiteId = refValue(link.test_suite);
    const testSysId = refValue(link.test);
    if (!suiteId || !testSysId) continue;
    const test = testBySysId.get(testSysId);
    if (!test) continue;
    const list = testIdsBySuite.get(suiteId) ?? [];
    list.push(test.id);
    testIdsBySuite.set(suiteId, list);
  }

  return suiteRead.rows
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
      // Bounded to the single newest result per test via ORDERBYDESC + limit 1
      // — already optimal, so it stays per-test rather than an unbounded IN pull
      // of every historical result. `test.sysId` (an instance sys_id) is routed
      // through the builder so it cannot inject an operator (SR-1).
      sysparm_query: and(eq("test", test.sysId), "ORDERBYDESCsys_created_on"),
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
 * Classify WHY one identity property's value is missing (OPP-1 part (b)),
 * reusing the certification checks' zero-read triage ({@link triageZeroRead})
 * over `queryWithMeta`'s pre-trim `X-Total-Count`. Proof discipline: a reason
 * is returned only when the metadata PROVES it; any ambiguity — no count, a
 * failed re-read, contradictory rows — returns `undefined` (unknown).
 *
 * - An untrimmed combined read that carried a count proves every matching row
 *   was visible, so the missing value is real — no row, or only blank rows —
 *   → `"absent"`. A blank visible row under a TRIMMED or count-less read is
 *   NOT proof: a second, valued row for the same name could be ACL-hidden.
 * - Otherwise the combined read cannot attribute hidden rows to one property
 *   NAME, so the name is re-read alone for a per-name count. Zero visible
 *   rows triage as the certification checks do: provably zero → `"absent"`,
 *   hidden rows → `"trimmed"`. Visible rows that are all blank are `"absent"`
 *   only when the per-name count proves nothing else is hidden, `"trimmed"`
 *   when it proves hidden matching rows exist; a visible VALUE contradicts
 *   the captured absence, so no reason may be claimed.
 */
async function classifyMissingProperty(
  client: SnClient,
  name: string,
  meta: TableQueryResult,
): Promise<IdentityMissingReason | undefined> {
  if (meta.totalCount !== undefined && !meta.securityTrimmed) return "absent";
  let single: TableQueryResult;
  try {
    single = await client.table(PROPERTIES_TABLE).queryWithMeta({
      sysparm_query: eq("name", name),
      sysparm_fields: "name,value",
    });
  } catch {
    return undefined;
  }
  if (single.rows.length > 0) {
    if (!single.rows.every((r) => str(r.value) === "")) return undefined;
    if (single.totalCount === undefined) return undefined;
    return single.securityTrimmed ? "trimmed" : "absent";
  }
  const triage = triageZeroRead(single);
  if (triage === "empty") return "absent";
  if (triage === "trimmed") return "trimmed";
  return undefined;
}

/** The platform build properties read by {@link readBuildInfo}. */
export interface BuildInfo {
  /** Non-blank `glide.buildname` (release family), when visible. */
  buildName?: string;
  /** Non-blank `glide.war` (exact build / patch level), when visible. */
  war?: string;
  /** The raw read, for zero-row / security-trim triage by the caller. */
  read: TableQueryResult;
}

/**
 * Read `glide.buildname` and `glide.war` from `sys_properties` in one query
 * built with the validated {@link inClause} (SR-1). Blank values count as
 * absent. Errors propagate: the sync swallows them (best-effort capture), the
 * `platform-release` check maps them to a verdict.
 */
export async function readBuildInfo(client: SnClient): Promise<BuildInfo> {
  const read = await client.table(PROPERTIES_TABLE).queryWithMeta({
    sysparm_query: inClause("name", [BUILD_NAME_PROPERTY, WAR_PROPERTY]),
    sysparm_fields: "name,value",
  });
  const values = new Map<string, string>();
  for (const row of read.rows) {
    const name = str(row.name);
    if (name !== BUILD_NAME_PROPERTY && name !== WAR_PROPERTY) continue;
    const value = str(row.value);
    if (value) values.set(name, value);
  }
  const info: BuildInfo = { read };
  const buildName = values.get(BUILD_NAME_PROPERTY);
  const war = values.get(WAR_PROPERTY);
  if (buildName !== undefined) info.buildName = buildName;
  if (war !== undefined) info.war = war;
  return info;
}

/**
 * Read the platform version identity from `sys_properties` (OPP-1). Both
 * property names go through the validated builder ({@link inClause}) — never
 * raw string interpolation (SR-1). A property that is unreadable, ACL-hidden,
 * or blank is recorded as absent, never fabricated; when both are absent the
 * whole identity is absent and drift reports an advisory instead of gating.
 *
 * Part (b): a missing value on an otherwise-captured identity is classified
 * via {@link classifyMissingProperty} and recorded as `buildNameMissing` /
 * `warMissing`, so drift can say "not set on the instance" instead of sending
 * the user to fix ACLs for a property that provably does not exist. No reason
 * is attached when BOTH values are missing — the identity block itself stays
 * absent and drift's pre-capture advisory covers that case.
 */
async function pullIdentity(
  client: SnClient,
): Promise<InstanceIdentity | undefined> {
  let info: BuildInfo;
  try {
    info = await readBuildInfo(client);
  } catch {
    // Version capture is best-effort: the ATF reads (which ran first) already
    // surfaced real auth/network problems, so a failure here is most likely an
    // ACL on sys_properties. Record honest absence rather than aborting the
    // sync — drift downgrades absence to an advisory (OPP-1).
    return undefined;
  }
  const { buildName, war, read: meta } = info;
  if (buildName === undefined && war === undefined) return undefined;
  const identity: InstanceIdentity = {};
  if (buildName !== undefined) {
    identity.buildName = buildName;
  } else {
    const reason = await classifyMissingProperty(
      client,
      BUILD_NAME_PROPERTY,
      meta,
    );
    if (reason) identity.buildNameMissing = reason;
  }
  if (war !== undefined) {
    identity.war = war;
  } else {
    const reason = await classifyMissingProperty(client, WAR_PROPERTY, meta);
    if (reason) identity.warMissing = reason;
  }
  return identity;
}

/**
 * Read the installed app/plugin inventory (OPP-5): `sys_store_app` and
 * `sys_app` rows keyed by scope, plus `sys_plugins` entries that carry a
 * version. Only the INSTALLED `version` column is ever read — never
 * `latest_version`, which is the store's newest available and would let an
 * outdated app masquerade as current (SN-5).
 *
 * Returns `undefined` (never captured) when:
 * - any of the three reads throws (best-effort, see {@link pullIdentity});
 * - any read was security-trimmed — a PARTIAL inventory would produce false
 *   "missing on target" failures at drift time, so it is dropped whole;
 * - all three reads are empty and untrimmed — a real instance always has
 *   plugins, so all-empty almost certainly means ACL trimming the client
 *   could not prove (mirrors the SN-1 reasoning for ATF rows).
 */
async function pullApps(
  client: SnClient,
): Promise<InstalledAppState[] | undefined> {
  let storeRows: Record<string, unknown>[];
  let appRows: Record<string, unknown>[];
  let pluginRows: Record<string, unknown>[];
  try {
    // Store/scoped apps are read unfiltered so scope + installed version are
    // captured even for inactive ones; plugins are filtered to active with a
    // static literal query (no dynamic value — SR-1 does not apply).
    const [store, app, plugin] = await Promise.all([
      client.table(STORE_APP_TABLE).queryWithMeta({
        sysparm_fields: "sys_id,scope,name,version",
      }),
      client.table(APP_TABLE).queryWithMeta({
        sysparm_fields: "sys_id,scope,name,version",
      }),
      client.table(PLUGIN_TABLE).queryWithMeta({
        sysparm_query: "active=true",
        sysparm_fields: "sys_id,id,source,name,version",
      }),
    ]);
    if (store.securityTrimmed || app.securityTrimmed || plugin.securityTrimmed)
      return undefined;
    storeRows = store.rows;
    appRows = app.rows;
    pluginRows = plugin.rows;
  } catch {
    return undefined;
  }

  if (
    storeRows.length === 0 &&
    appRows.length === 0 &&
    pluginRows.length === 0
  ) {
    return undefined;
  }

  // Dedupe by id with precedence store app > scoped app > plugin: a store app
  // is the authoritative installed record for its scope.
  const apps = new Map<string, InstalledAppState>();
  const addScoped = (row: Record<string, unknown>): void => {
    const id = str(row.scope);
    if (!id || apps.has(id)) return;
    const entry: InstalledAppState = { id };
    const name = str(row.name);
    if (name) entry.name = name;
    // SN-5: the installed `version` column only — never `latest_version`.
    const version = str(row.version);
    if (version) entry.version = version;
    // Recorded even without a version: presence alone drives the
    // missing-on-target failure mode at drift time (OPP-5).
    apps.set(id, entry);
  };
  storeRows.forEach(addScoped);
  appRows.forEach(addScoped);
  for (const row of pluginRows) {
    const id = str(row.id) || str(row.source);
    if (!id || apps.has(id)) continue;
    // Plugins without a version carry no comparable signal (unlike apps, whose
    // presence is meaningful per scope), so only versioned ones are recorded.
    const version = str(row.version);
    if (!version) continue;
    const entry: InstalledAppState = { id, version };
    const name = str(row.name);
    if (name) entry.name = name;
    apps.set(id, entry);
  }
  return [...apps.values()];
}

/**
 * ST-21: the url is written into the committed manifest, so one carrying
 * `user:pass@` is refused before anything is read (the value is not echoed).
 */
function assertNoUserinfo(url: string | undefined): void {
  if (url === undefined) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new UsageError(
      `The instance url for the state manifest carries credentials ` +
        `(user:password@); the manifest is committed, so remove them.`,
    );
  }
}

/**
 * Pull a fresh snapshot. Shared by {@link pullManifest} and
 * {@link syncManifest}. A trimmed ATF read or an unreadable `active` column
 * throws {@link IncompleteSnapshotError} before anything is merged (RR-47).
 */
async function pullSnapshot(
  client: SnClient,
  instance: string,
  url: string | undefined,
  opts: SyncOptions,
): Promise<StateManifest> {
  assertNoUserinfo(url);
  const tests = await pullTests(client, opts);
  if (opts.withLastRun) await attachLastRuns(client, tests, opts);

  const testBySysId = new Map<string, AtfTestState>();
  for (const t of tests) if (t.sysId) testBySysId.set(t.sysId, t);

  const suites = await pullSuites(client, opts, testBySysId);

  // Fail loudly on same-scope slug collisions before they corrupt the merge.
  assertNoLogicalIdCollisions(tests, "test");
  assertNoLogicalIdCollisions(suites, "suite");

  // Version capture (OPP-1 / OPP-5) — best-effort AFTER the ATF reads, so a
  // real auth/network problem has already propagated; a capture-only failure
  // records honest absence and the sync still succeeds.
  const [identity, apps] = await Promise.all([
    pullIdentity(client),
    pullApps(client),
  ]);

  const manifest = emptyManifest(instance, url, opts.scope);
  manifest.tests = tests;
  manifest.suites = suites;
  if (opts.now) manifest.syncedAt = opts.now;
  if (identity) manifest.identity = identity;
  if (apps) manifest.apps = apps;
  return manifest;
}

/**
 * Pull a fresh {@link StateManifest} snapshot from an instance. This is the raw
 * instance reality — NOT merged with any committed manifest. Callers typically
 * pass the result to {@link mergeManifest} against {@link loadManifest} output
 * and then {@link writeManifest} it. Throws {@link IncompleteSnapshotError}
 * when a test, suite or suite-link read is security-trimmed or a test's
 * `active` value is unreadable (RR-47).
 */
export async function pullManifest(
  client: SnClient,
  instance: string,
  url: string | undefined,
  opts: SyncOptions = {},
): Promise<StateManifest> {
  return pullSnapshot(client, instance, url, opts);
}

/**
 * Convenience: pull a snapshot and merge it into an existing committed manifest,
 * returning the manifest to write. Pure w.r.t. the filesystem — the caller reads
 * `existing` and writes the result.
 *
 * RR-47: any proven security-trim on the test, suite or suite-link read, and
 * any test row without a readable `active` value, throws
 * {@link IncompleteSnapshotError} — on a first sync too, and whether or not
 * the snapshot is empty. `opts.allowEmpty` does not apply.
 *
 * SN-1: an ALL-EMPTY (untrimmed) snapshot over a non-empty committed manifest
 * is refused. Zero visible rows on a least-privilege account usually means ACL
 * security-trimming the instance could not prove — committing would erase
 * real coverage. The refusal is a soft {@link EmptySnapshotError} that
 * `opts.allowEmpty` overrides.
 */
export async function syncManifest(
  client: SnClient,
  instance: string,
  url: string | undefined,
  existing: StateManifest | undefined,
  opts: SyncOptions = {},
): Promise<StateManifest> {
  const snapshot = await pullSnapshot(client, instance, url, opts);
  const snapshotEmpty =
    snapshot.tests.length === 0 && snapshot.suites.length === 0;
  if (
    snapshotEmpty &&
    existing &&
    (existing.tests.length > 0 || existing.suites.length > 0)
  ) {
    if (!opts.allowEmpty) {
      throw new EmptySnapshotError(
        `Refusing to overwrite the committed manifest for "${instance}" (which holds ` +
          `${existing.tests.length} test(s) and ${existing.suites.length} suite(s)) with ` +
          `an empty snapshot of 0 tests and 0 suites. Zero visible rows on a ` +
          `least-privilege account usually means ACL security-trimming, not "no ` +
          `tests" — verify the account can read the ATF tables in scope. To commit ` +
          `the empty snapshot intentionally, re-run with --allow-empty.`,
        false,
      );
    }
  }
  return mergeManifest(existing, snapshot);
}
