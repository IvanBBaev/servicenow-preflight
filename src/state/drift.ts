import type { CheckResult } from "../types.js";
import type {
  InstalledAppState,
  InstanceIdentity,
  StateManifest,
  AtfTestState,
} from "./manifest.js";
import { compareVersions } from "../versions.js";

/**
 * Test drift between two instances — the payoff of committing manifests. Two
 * instances are compared by **logical `id`** (stable across instances), so a
 * test green on `staging` but absent on `prod` is caught *before* the promote.
 *
 * Direction matters: `source` is the upstream instance (what has been validated,
 * e.g. `staging`), `target` is where we are about to promote (e.g. `prod`).
 * A test that is **active on the source but missing on the target** blocks the
 * promote. A test present only on the target is surfaced as informational drift.
 */

/** One test involved in a drift, distilled to what a report shows. */
export interface DriftEntry {
  /** Logical `id` (`scope/slug`). */
  id: string;
  /** Human-readable test name. */
  name: string;
}

/** The outcome of comparing two manifests. */
export interface DriftReport {
  /** Source instance name. */
  source: string;
  /** Target instance name. */
  target: string;
  /**
   * Tests active on the source but absent on the target — these **block** a
   * promote (the target is missing validated coverage).
   */
  missingOnTarget: DriftEntry[];
  /**
   * Tests present on the target but absent on the source — informational: the
   * target carries coverage the source does not.
   */
  extraOnTarget: DriftEntry[];
  /** Count of active tests considered on the source. */
  sourceActiveCount: number;
  /** Count of active tests considered on the target. */
  targetCount: number;
  /** `true` when nothing blocks a promote (`missingOnTarget` is empty). */
  ok: boolean;
}

/** Index a manifest's tests by logical `id`. */
function byId(tests: AtfTestState[]): Map<string, AtfTestState> {
  const map = new Map<string, AtfTestState>();
  for (const t of tests) map.set(t.id, t);
  return map;
}

/** A test counts as "present" for drift when it exists and is not inactive. */
function isActive(test: AtfTestState): boolean {
  return test.active !== false;
}

/**
 * Compare two manifests by logical `id` and report the drift. Only **active**
 * source tests can block a promote — an intentionally deactivated test missing
 * downstream is not a regression.
 */
export function computeDrift(
  source: StateManifest,
  target: StateManifest,
): DriftReport {
  const sourceTests = source.tests.filter(isActive);
  // Apply the same active filter to the TARGET (CC-3): a test deactivated on the
  // target is *absent* for drift purposes, so an active source test whose only
  // target counterpart is inactive must be reported as missing — not silently
  // matched against a dead row. The source index stays UNFILTERED so an
  // inactive-on-source test that still exists on the target is not mis-reported
  // as extra (it is present on the source, just not blocking).
  const targetTests = target.tests.filter(isActive);
  const targetIndex = byId(targetTests);
  const sourceIndex = byId(source.tests);

  const missingOnTarget: DriftEntry[] = [];
  for (const t of sourceTests) {
    if (!targetIndex.has(t.id)) {
      missingOnTarget.push({ id: t.id, name: t.name });
    }
  }

  const extraOnTarget: DriftEntry[] = [];
  for (const t of targetTests) {
    if (!sourceIndex.has(t.id)) {
      extraOnTarget.push({ id: t.id, name: t.name });
    }
  }

  const sort = (a: DriftEntry, b: DriftEntry): number =>
    a.id.localeCompare(b.id);
  missingOnTarget.sort(sort);
  extraOnTarget.sort(sort);

  return {
    source: source.instance,
    target: target.instance,
    missingOnTarget,
    extraOnTarget,
    sourceActiveCount: sourceTests.length,
    targetCount: targetTests.length,
    ok: missingOnTarget.length === 0,
  };
}

/** Check name used for the manifest-freshness results a drift run may emit. */
export const FRESHNESS_CHECK = "manifest-freshness";

/** Default age past which a compared manifest is flagged stale (30 days). */
export const DEFAULT_STALE_WARN_MS = 30 * 24 * 60 * 60 * 1000;

/** A compared manifest tagged with its role in the drift (for messages). */
export interface DriftManifestRef {
  /** Which side of the promote this manifest is — `source` or `target`. */
  role: string;
  manifest: StateManifest;
}

/** Thresholds for {@link stalenessResults}. */
export interface StalenessOptions {
  /** Reference time (defaults to `Date.now()`). */
  now?: number;
  /** Age past which a manifest yields a `warn` (default 30 days). */
  warnAfterMs?: number;
  /**
   * Age past which a manifest yields a `fail` (from the CLI's `--max-age`).
   * Unset means no hard age gate — only the soft `warn` applies.
   */
  maxAgeMs?: number;
}

/** Render a millisecond age as a compact human string (e.g. `45d`, `3h`). */
function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const units: [number, string][] = [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  for (const [size, label] of units) {
    if (sec >= size) return `${Math.floor(sec / size)}${label}`;
  }
  return "0s";
}

/**
 * Evaluate the freshness of the manifests a drift compares. A manifest older
 * than `warnAfterMs` yields a `warn`; with `maxAgeMs` set (the CLI's
 * `--max-age`), one older than that yields a `fail` (a hard promote block).
 *
 * A manifest with no usable `syncedAt` is only surfaced under `--max-age`, and
 * then fails closed: freshness that cannot be proven must not pass an explicit
 * age gate. Returns one {@link CheckResult} per flagged manifest (empty when all
 * are fresh), for the CLI to fold into the drift report.
 */
export function stalenessResults(
  refs: DriftManifestRef[],
  opts: StalenessOptions = {},
): CheckResult[] {
  const now = opts.now ?? Date.now();
  const warnAfterMs = opts.warnAfterMs ?? DEFAULT_STALE_WARN_MS;
  const { maxAgeMs } = opts;
  const out: CheckResult[] = [];
  for (const { role, manifest } of refs) {
    const label = `${role} "${manifest.instance}"`;
    const synced = manifest.syncedAt ? Date.parse(manifest.syncedAt) : NaN;
    if (Number.isNaN(synced)) {
      if (maxAgeMs !== undefined) {
        out.push({
          name: FRESHNESS_CHECK,
          status: "fail",
          message: `Manifest for ${label} has no recorded syncedAt; cannot verify it is within --max-age. Re-run sync.`,
        });
      }
      continue;
    }
    const ageMs = Math.max(0, now - synced);
    if (maxAgeMs !== undefined && ageMs > maxAgeMs) {
      out.push({
        name: FRESHNESS_CHECK,
        status: "fail",
        message: `Manifest for ${label} was synced ${formatAge(ageMs)} ago, exceeding --max-age (${formatAge(maxAgeMs)}). Re-run sync before promoting.`,
      });
    } else if (ageMs > warnAfterMs) {
      out.push({
        name: FRESHNESS_CHECK,
        status: "warn",
        message: `Manifest for ${label} was synced ${formatAge(ageMs)} ago (older than ${formatAge(warnAfterMs)}); consider re-running sync.`,
      });
    }
  }
  return out;
}

/** Check name for the platform-version parity result a drift run emits (OPP-1). */
export const INSTANCE_VERSION_CHECK = "instance-version-parity";

/** Check name for the app/plugin version parity results a drift run emits (OPP-5). */
export const APP_VERSION_CHECK = "app-version-parity";

/** How many offending names a parity message spells out before truncating. */
const MAX_NAMED = 3;

/** Join names, truncating past {@link MAX_NAMED} with a `(+N more)` suffix. */
function nameList(names: string[]): string {
  if (names.length <= MAX_NAMED) return names.join(", ");
  return `${names.slice(0, MAX_NAMED).join(", ")} (+${names.length - MAX_NAMED} more)`;
}

/** Label an app for messages: `id` plus its human name when distinct. */
function describeApp(app: InstalledAppState): string {
  return app.name && app.name !== app.id ? `${app.id} (${app.name})` : app.id;
}

/**
 * Compare the platform version identity of the two manifests (OPP-1).
 *
 * - Either manifest lacking an `identity` block (written before version
 *   capture, or the properties were unreadable at sync time) → ADVISORY
 *   `warn` — never a crash, never a `fail` purely for absence.
 * - `glide.buildname` differing → `fail`: promoting between release families
 *   is the exact regression this gate exists to block.
 * - Build names matching but `glide.war` differing → `warn`: patch-level skew
 *   is worth an eyeball, not a hard block.
 * - `glide.buildname` absent on BOTH sides (some instances genuinely do not set
 *   the property) → fall back to `glide.war` alone: identical → `pass` (verified
 *   at patch level), differing → `warn`. See {@link warOnlyParityResult}.
 * - `glide.buildname` present on one side but not the other, or any single
 *   property unreadable → `warn` with explicit "unverified" wording (fail-closed:
 *   no silent pass on unknown data).
 */
function instanceParityResult(
  source: StateManifest,
  target: StateManifest,
): CheckResult {
  const src = source.identity;
  const tgt = target.identity;
  if (!src || !tgt) {
    const noCapture: string[] = [];
    if (!src) noCapture.push(`source "${source.instance}"`);
    if (!tgt) noCapture.push(`target "${target.instance}"`);
    return {
      name: INSTANCE_VERSION_CHECK,
      status: "warn",
      message: `Manifest for ${noCapture.join(" and ")} predates version capture (no platform identity recorded) — re-run sync to enable instance-version parity.`,
    };
  }

  const srcNoBuild = src.buildName === undefined;
  const tgtNoBuild = tgt.buildName === undefined;

  // Neither instance recorded glide.buildname. Rather than warn forever with no
  // route to a pass, fall back to glide.war — which still pins the patch level —
  // for a narrower but legitimate parity signal (surfaced by live validation
  // against a PDI where the property is genuinely unset).
  if (srcNoBuild && tgtNoBuild) {
    return warOnlyParityResult(source, target, src, tgt);
  }

  // Exactly one side is missing glide.buildname: the manifests are not
  // comparable at the release-family level. Fail closed with explicit wording
  // rather than guess from glide.war across an asymmetric pair.
  if (srcNoBuild || tgtNoBuild) {
    const which = srcNoBuild
      ? `source "${source.instance}"`
      : `target "${target.instance}"`;
    return {
      name: INSTANCE_VERSION_CHECK,
      status: "warn",
      message: `glide.buildname was unreadable at sync time on ${which}; instance-version parity is unverified — re-run sync with an account that can read sys_properties.`,
    };
  }

  if (src.buildName !== tgt.buildName) {
    return {
      name: INSTANCE_VERSION_CHECK,
      status: "fail",
      message: `Platform version mismatch: source "${source.instance}" is on ${src.buildName} but target "${target.instance}" is on ${tgt.buildName}. Align instance versions before promoting.`,
    };
  }

  const noWar: string[] = [];
  if (src.war === undefined) noWar.push(`source "${source.instance}"`);
  if (tgt.war === undefined) noWar.push(`target "${target.instance}"`);
  if (noWar.length > 0) {
    return {
      name: INSTANCE_VERSION_CHECK,
      status: "warn",
      message: `Build names match (${src.buildName}), but glide.war was unreadable at sync time on ${noWar.join(" and ")}; patch-level parity is unverified.`,
    };
  }

  if (src.war !== tgt.war) {
    return {
      name: INSTANCE_VERSION_CHECK,
      status: "warn",
      message: `Build names match (${src.buildName}), but patch levels differ: source glide.war is "${src.war}" while target is "${tgt.war}".`,
    };
  }

  return {
    name: INSTANCE_VERSION_CHECK,
    status: "pass",
    message: `Platform versions match: ${src.buildName} (glide.war "${src.war}").`,
  };
}

/**
 * Parity fallback when NEITHER manifest recorded `glide.buildname`. Some
 * instances genuinely do not set the property, so `glide.war` — which still
 * pins the exact build/patch — is the only version signal available: identical
 * → `pass` (verified at patch level), differing → `warn`, unreadable on either
 * side → `warn` (fail-closed). Never a `fail`: with no build family to compare,
 * a differing patch is an eyeball, not a proven cross-release promote.
 */
function warOnlyParityResult(
  source: StateManifest,
  target: StateManifest,
  src: InstanceIdentity,
  tgt: InstanceIdentity,
): CheckResult {
  const noWar: string[] = [];
  if (src.war === undefined) noWar.push(`source "${source.instance}"`);
  if (tgt.war === undefined) noWar.push(`target "${target.instance}"`);
  if (noWar.length > 0) {
    return {
      name: INSTANCE_VERSION_CHECK,
      status: "warn",
      message: `glide.buildname is not set on either instance and glide.war was unreadable at sync time on ${noWar.join(" and ")}; instance-version parity is unverified.`,
    };
  }

  if (src.war !== tgt.war) {
    return {
      name: INSTANCE_VERSION_CHECK,
      status: "warn",
      message: `glide.buildname is not set on either instance; patch levels differ: source glide.war is "${src.war}" while target is "${tgt.war}". Confirm both instances are on the same release before promoting.`,
    };
  }

  return {
    name: INSTANCE_VERSION_CHECK,
    status: "pass",
    message: `glide.buildname is not set on either instance; platform patch levels match (verified via glide.war "${src.war}").`,
  };
}

/**
 * Compare the recorded app/plugin inventory of the two manifests (OPP-5).
 *
 * - Either manifest lacking an `apps` list (pre-capture manifest, or the
 *   capture was ACL-trimmed and dropped whole) → single ADVISORY `warn`.
 * - App recorded on the source but absent on the target → advisory `warn`
 *   (expected on a first-ever deploy or when the source carries in-development
 *   apps; confirm each is intended — presence alone is not a regression).
 * - Target's installed version LOWER than the source's → `fail` (downgrade).
 * - Unparseable versions, or a source version the target cannot confirm →
 *   `warn` naming the app (unverified, never a silent pass).
 * - Apps present only on the target are not a finding — at most a count in
 *   the pass message (extra coverage never blocks a promote).
 *
 * Versions compare with the same semantics as the `scoped-app-deps` check
 * ({@link compareVersions}, CC-43); only the INSTALLED version was captured
 * (SN-5). Returns one `fail` and/or one `warn` aggregate, or a single `pass`.
 */
function appParityResults(
  source: StateManifest,
  target: StateManifest,
): CheckResult[] {
  const sourceApps = source.apps;
  const targetApps = target.apps;
  if (!sourceApps || !targetApps) {
    const noCapture: string[] = [];
    if (!sourceApps) noCapture.push(`source "${source.instance}"`);
    if (!targetApps) noCapture.push(`target "${target.instance}"`);
    return [
      {
        name: APP_VERSION_CHECK,
        status: "warn",
        message: `Manifest for ${noCapture.join(" and ")} predates version capture (no installed-app inventory recorded, or the capture was ACL-trimmed) — re-run sync to enable app-version parity.`,
      },
    ];
  }

  if (sourceApps.length === 0) {
    return [
      {
        name: APP_VERSION_CHECK,
        status: "pass",
        message: `No apps recorded on source "${source.instance}" to compare; app-version parity has nothing to gate.`,
      },
    ];
  }

  const targetById = new Map(targetApps.map((a) => [a.id, a]));
  const missingOnTarget: string[] = [];
  const downgraded: string[] = [];
  const advisories: string[] = [];
  for (const app of sourceApps) {
    const label = describeApp(app);
    const counterpart = targetById.get(app.id);
    if (!counterpart) {
      missingOnTarget.push(label);
      continue;
    }
    // No version recorded on the source → presence is the only expectation the
    // manifest carries for this app, and it is satisfied.
    if (app.version === undefined) continue;
    if (counterpart.version === undefined) {
      advisories.push(
        `${label}: source has ${app.version} but the target's installed version is unknown — unverified`,
      );
      continue;
    }
    const order = compareVersions(counterpart.version, app.version);
    if (order === null) {
      advisories.push(
        `${label}: versions "${app.version}" (source) and "${counterpart.version}" (target) cannot be compared (non-numeric segment) — unverified`,
      );
      continue;
    }
    if (order < 0) {
      downgraded.push(
        `${label}: target has ${counterpart.version}, below the source's ${app.version}`,
      );
    }
  }

  const out: CheckResult[] = [];
  // Only a *downgrade* — the target running an OLDER version of an app both
  // instances carry — is a genuine regression that must block the promote. An
  // app recorded on the source but absent on the target is expected on a
  // first-ever deploy or when the source carries in-development apps, so it
  // degrades to an advisory warn instead of failing every fresh target (OPP-5
  // false-fail fix). Downgrade stays fail-closed.
  if (downgraded.length > 0) {
    out.push({
      name: APP_VERSION_CHECK,
      status: "fail",
      message: `App version drift blocks the promote: ${downgraded.length} app(s) at a lower version on target "${target.instance}": ${nameList(downgraded)}.`,
    });
  }
  const advisoryParts: string[] = [];
  if (missingOnTarget.length > 0) {
    advisoryParts.push(
      `${missingOnTarget.length} app(s) recorded on source "${source.instance}" not installed on target "${target.instance}": ${nameList(missingOnTarget)} — expected on a first deploy or for in-development apps; confirm each is intended before promoting`,
    );
  }
  if (advisories.length > 0) {
    advisoryParts.push(nameList(advisories));
  }
  if (advisoryParts.length > 0) {
    out.push({
      name: APP_VERSION_CHECK,
      status: "warn",
      message: `App version parity has advisories: ${advisoryParts.join("; ")}.`,
    });
  }
  if (out.length === 0) {
    const extraCount = targetApps.filter(
      (a) => !sourceApps.some((s) => s.id === a.id),
    ).length;
    out.push({
      name: APP_VERSION_CHECK,
      status: "pass",
      message:
        `All ${sourceApps.length} recorded app(s) present on target "${target.instance}" at matching-or-newer versions` +
        (extraCount > 0
          ? ` (${extraCount} app(s) present only on the target).`
          : "."),
    });
  }
  return out;
}

/**
 * Version parity between the two manifests a drift run compares: platform
 * identity (OPP-1) and installed app/plugin versions (OPP-5). Direction
 * follows {@link computeDrift}: `source` is the validated upstream, `target`
 * the promote destination.
 *
 * A sibling of {@link stalenessResults} on the same CLI drift path — folded
 * into the report via `mergeResults`, NOT bolted onto the `test-drift` check,
 * whose single result would otherwise conflate ATF coverage drift with
 * platform/app parity. Unlike staleness (silent when fresh), each dimension
 * also emits an explicit `pass` result when it verifies clean, so a promote
 * gate's output positively records that version parity WAS checked.
 *
 * Manifests written before version capture yield ADVISORY warns ("predates
 * version capture — re-run sync"), never a crash or a fail purely for absence.
 */
export function versionParityResults(
  source: StateManifest,
  target: StateManifest,
): CheckResult[] {
  return [
    instanceParityResult(source, target),
    ...appParityResults(source, target),
  ];
}
