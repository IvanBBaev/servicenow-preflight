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
} from "./http/client.js";
export {
  createSnClient,
  SnError,
  SnAuthError,
  SnNetworkError,
  SnHttpError,
} from "./http/client.js";
export { createFakeSnClient } from "./http/fake.js";
export type { FakeFixtures, ForcedFailure } from "./http/fake.js";
export {
  loadConfig,
  resolveAuthFromEnv,
  resolveTlsFromEnv,
  namespacedEnv,
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
} from "./state/manifest.js";
export { pullManifest, syncManifest, type SyncOptions } from "./state/sync.js";
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
  const selected = selectChecks(checks, ctx.select);

  // A non-empty check set that narrows to zero (e.g. an `only`/`skip` naming
  // checks that do not exist) must never report a vacuous pass — that would
  // exit 0 having verified nothing. Surface it as a failure instead.
  if (selected.length === 0 && checks.length > 0) {
    const message =
      "No checks matched the selection (ctx.select.only/skip); nothing was verified.";
    return {
      ok: false,
      results: [{ name: "preflight", status: "fail", message }],
      summary: { pass: 0, warn: 0, fail: 1 },
    };
  }

  const results: CheckResult[] = [];
  for (const check of selected) {
    results.push(await check.run(ctx));
  }

  const summary: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const result of results) {
    summary[result.status] += 1;
  }

  return { ok: summary.fail === 0, results, summary };
}

// Re-exported for consumers that only need the auth type name.
export type { PreflightAuth as Auth } from "./types.js";
