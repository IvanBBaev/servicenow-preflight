/**
 * Pre-deployment preflight checks for ServiceNow, as a library.
 *
 * The entry point is {@link runPreflight}, which runs a list of {@link Check}s
 * against a target instance ({@link PreflightContext}) and returns an aggregate
 * {@link PreflightReport}. Call it with no explicit list to run
 * {@link defaultChecks}, or pass your own {@link CheckSelection}. The bundled
 * CLI (`servicenow-preflight` / `snpf`) is a thin wrapper over this same
 * function. Every symbol needed to build and run checks, or to drive a
 * {@link SnClient} directly, is re-exported here.
 *
 * @packageDocumentation
 */
import { defaultChecks } from "./checks/index.js";
import type {
  Check,
  CheckResult,
  CheckStatus,
  CheckSelection,
  PreflightContext,
  PreflightReport,
} from "./types.js";

export type {
  Check,
  CheckResult,
  CheckStatus,
  CheckSelection,
  PreflightAuth,
  PreflightContext,
  PreflightReport,
} from "./types.js";
export type {
  SnClient,
  SnTable,
  SnCicd,
  SnAuth,
  SnTls,
  SnRawResponse,
  SnRequestOptions,
  SnClientConfig,
  CicdTestSuiteResult,
  TableQueryResult,
} from "./http/client.js";
export {
  createSnClient,
  SnError,
  SnAuthError,
  SnNetworkError,
  SnHttpError,
  SnTruncationError,
  SnResponseError,
} from "./http/client.js";
export { createFakeSnClient } from "./http/fake.js";
export type { FakeFixtures, ForcedFailure } from "./http/fake.js";
export {
  EncodedQueryError,
  IN_CHUNK_SIZE,
  isSafeIdentifier,
  isSysId,
  assertIdentifier,
  assertSysId,
  eq,
  inClause,
  and,
  or,
  chunk,
  scopeFilterClause,
  resolveScope,
} from "./http/query.js";
export type { ResolvedScope } from "./http/query.js";
export {
  loadConfig,
  resolveAuthFromEnv,
  resolveTlsFromEnv,
  namespacedEnv,
  UsageError,
  type PreflightConfig,
  type LoadedConfig,
  type LoadConfigOptions,
} from "./config.js";
export {
  loadRegistry,
  resolveInstance,
  instanceNames,
  registryPath,
  PREFLIGHT_DIR,
  REGISTRY_BASENAME,
  type InstanceDef,
  type InstanceRegistry,
  type ResolvedInstance,
} from "./registry.js";
export {
  loadManifest,
  writeManifest,
  mergeManifest,
  emptyManifest,
  manifestPath,
  logicalId,
  slugify,
  STATE_DIR,
  type StateManifest,
  type AtfTestState,
  type AtfSuiteState,
  type AtfCoverage,
  type AtfRunRef,
  type InstanceIdentity,
  type InstalledAppState,
} from "./state/manifest.js";
export {
  pullManifest,
  syncManifest,
  EmptySnapshotError,
  type SyncOptions,
} from "./state/sync.js";
export {
  computeDrift,
  type DriftReport,
  type DriftEntry,
} from "./state/drift.js";
export { formatJUnit } from "./report/junit.js";
export { formatSarif } from "./report/sarif.js";
export {
  defaultChecks,
  instanceUrlConfigured,
  connectivityAuth,
  updateSetState,
  defaultSetLeakage,
  remoteSetPreview,
  atfEnablement,
  atfRun,
  scopedAppDeps,
  i18nCompleteness,
  aclRoleSanity,
  testDrift,
} from "./checks/index.js";

/**
 * Apply a {@link CheckSelection} to a list of checks: keep only those named in
 * `only` (when present), then drop any named in `skip`. Matching is by the
 * check's `name`. Unknown names are silently ignored.
 */
export function selectChecks(
  checks: Check[],
  select?: CheckSelection,
): Check[] {
  if (!select) return checks;
  let out = checks;
  if (select.only && select.only.length > 0) {
    const only = new Set(select.only);
    out = out.filter((c) => only.has(c.name));
  }
  if (select.skip && select.skip.length > 0) {
    const skip = new Set(select.skip);
    out = out.filter((c) => !skip.has(c.name));
  }
  return out;
}

/**
 * Run a set of preflight checks against a target ServiceNow instance and
 * return an aggregate report. The run is considered failing (`ok: false`)
 * if any check returns a `fail` status.
 *
 * `ctx.select` (only / skip by check name) filters the supplied `checks`
 * before they run.
 */
export async function runPreflight(
  ctx: PreflightContext,
  checks: Check[] = defaultChecks,
): Promise<PreflightReport> {
  // Reject an ambiguous check set: two checks sharing a `name` make selection
  // (only/skip), result mapping, and reporting ambiguous. Fail closed rather
  // than run a set we cannot reason about.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.name)) duplicates.add(check.name);
    seen.add(check.name);
  }
  if (duplicates.size > 0) {
    const names = [...duplicates].sort().join(", ");
    const message = `Duplicate check name(s): ${names}. Check names must be unique.`;
    return {
      ok: false,
      results: [{ name: "preflight", status: "fail", message }],
      summary: { pass: 0, warn: 0, fail: 1 },
    };
  }

  const selected = selectChecks(checks, ctx.select);

  // Nothing to run means nothing was verified. A pre-deployment gate must never
  // report a vacuous pass (exit 0 having checked nothing), so surface it as a
  // failure — whether the supplied set was empty or a selection narrowed it to
  // zero.
  if (selected.length === 0) {
    const message =
      checks.length === 0
        ? "No checks were supplied to runPreflight; nothing was verified."
        : "No checks matched the selection (ctx.select.only/skip); nothing was verified.";
    return {
      ok: false,
      results: [{ name: "preflight", status: "fail", message }],
      summary: { pass: 0, warn: 0, fail: 1 },
    };
  }

  // Run each check in isolation: a check that throws or rejects must not abort
  // the whole run. Convert the throw into a `fail` result and keep going so the
  // report still renders and every other check still reports.
  const results: CheckResult[] = [];
  for (const check of selected) {
    try {
      results.push(await check.run(ctx));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({
        name: check.name,
        status: "fail",
        message: `Check threw an error: ${detail}`,
      });
    }
  }

  // Summarise fail-closed: an unrecognised status is untrustworthy for a gate,
  // so it is counted (and surfaced) as a failure rather than silently producing
  // a NaN bucket and a vacuous `ok: true`.
  const validStatuses: readonly CheckStatus[] = ["pass", "warn", "fail"];
  const summary: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  const normalized: CheckResult[] = results.map((result) => {
    if ((validStatuses as readonly string[]).includes(result.status)) {
      summary[result.status] += 1;
      return result;
    }
    summary.fail += 1;
    return {
      name: result.name,
      status: "fail",
      message: `Check "${result.name}" returned an unrecognised status "${String(
        result.status,
      )}"; treated as fail. Original message: ${result.message}`,
    };
  });

  return { ok: summary.fail === 0, results: normalized, summary };
}

// Re-exported for consumers that only need the auth type name.
export type { PreflightAuth as Auth } from "./types.js";
