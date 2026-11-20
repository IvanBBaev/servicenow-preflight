import type { CheckResult, CheckStatus, Finding } from "../types.js";
import { capFindings, makeFinding } from "../findings.js";
import {
  rejectDuplicateIds,
  type IdentityMissingReason,
  type InstalledAppState,
  type InstanceIdentity,
  type StateManifest,
  type AtfTestState,
} from "./manifest.js";
import { compareVersions } from "../versions.js";
import { promotionChain, type InstanceRegistry } from "../registry.js";

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
  /**
   * `true` when nothing blocks a promote: `missingOnTarget` is empty AND the
   * source has at least one active test. Zero active source tests means
   * nothing was compared, which is never a pass (RR-48, ST-2).
   */
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
 *
 * Throws when either manifest holds two tests with one logical `id` (RR-48,
 * ST-4): indexing by id would collapse them and hide one from the gate.
 */
export function computeDrift(
  source: StateManifest,
  target: StateManifest,
): DriftReport {
  for (const [role, m] of [
    ["source", source],
    ["target", target],
  ] as const) {
    rejectDuplicateIds(
      m.tests,
      "tests",
      `Drift ${role} manifest "${m.instance}"`,
      (message) => new Error(message),
    );
  }
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
    ok: missingOnTarget.length === 0 && sourceTests.length > 0,
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

/**
 * A freshness row with its single `logicalId: "instance"` finding. The kind
 * carries the condition and the manifest's role (`stale:source`,
 * `max-age-exceeded:target`, ...), so the source and target rows of one drift
 * run never share an id, and the id survives the age in the message changing.
 */
function freshnessRow(
  status: CheckStatus,
  message: string,
  kind: string,
): CheckResult {
  return {
    name: FRESHNESS_CHECK,
    status,
    message,
    findings: [
      makeFinding(FRESHNESS_CHECK, kind, message, { logicalId: INSTANCE_ID }),
    ],
  };
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
 * How far a manifest's `syncedAt` may lie in the future before drift refuses
 * it (RR-54, ST-9): enough for clock skew between the machine that ran `sync`
 * and the one running `drift`, far less than any real age gate.
 */
export const FUTURE_SYNC_SKEW_MS = 5 * 60 * 1000;

/**
 * Evaluate the freshness of the manifests a drift compares. A manifest older
 * than `warnAfterMs` yields a `warn`; with `maxAgeMs` set (the CLI's
 * `--max-age`), one older than that yields a `fail` (a hard promote block).
 *
 * Freshness that cannot be proven never passes (RR-54, ST-9): a manifest with
 * no usable `syncedAt` warns, and fails under `--max-age`; a `syncedAt` more
 * than {@link FUTURE_SYNC_SKEW_MS} in the future fails — its age is unknown,
 * and clamping it to zero would let any manifest look fresh. Returns one
 * {@link CheckResult} per flagged manifest (empty when all are fresh), for the
 * CLI to fold into the drift report.
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
    const synced =
      typeof manifest.syncedAt === "string" && manifest.syncedAt !== ""
        ? Date.parse(manifest.syncedAt)
        : NaN;
    if (Number.isNaN(synced)) {
      out.push(
        maxAgeMs !== undefined
          ? freshnessRow(
              "fail",
              `Manifest for ${label} has no recorded syncedAt; cannot verify it is within --max-age. Re-run sync.`,
              `no-synced-at:${role}`,
            )
          : freshnessRow(
              "warn",
              `Manifest for ${label} has no readable syncedAt, so its age is unknown; re-run sync.`,
              `no-synced-at:${role}`,
            ),
      );
      continue;
    }
    if (synced - now > FUTURE_SYNC_SKEW_MS) {
      out.push(
        freshnessRow(
          "fail",
          `Manifest for ${label} claims a sync ${formatAge(synced - now)} in the future (syncedAt "${manifest.syncedAt}"), so its age cannot be proven. Fix the clock or the file and re-run sync.`,
          `future-synced-at:${role}`,
        ),
      );
      continue;
    }
    const ageMs = Math.max(0, now - synced);
    if (maxAgeMs !== undefined && ageMs > maxAgeMs) {
      out.push(
        freshnessRow(
          "fail",
          `Manifest for ${label} was synced ${formatAge(ageMs)} ago, exceeding --max-age (${formatAge(maxAgeMs)}). Re-run sync before promoting.`,
          `max-age-exceeded:${role}`,
        ),
      );
    } else if (ageMs > warnAfterMs) {
      out.push(
        freshnessRow(
          "warn",
          `Manifest for ${label} was synced ${formatAge(ageMs)} ago (older than ${formatAge(warnAfterMs)}); consider re-running sync.`,
          `stale:${role}`,
        ),
      );
    }
  }
  return out;
}

/** Check name for the platform-version parity result a drift run emits (OPP-1). */
export const INSTANCE_VERSION_CHECK = "instance-version-parity";

/** Check name for the app/plugin version parity results a drift run emits (OPP-5). */
export const APP_VERSION_CHECK = "app-version-parity";

/** Logical id of the findings about a whole instance (parity, freshness). */
const INSTANCE_ID = "instance";

/**
 * A non-pass platform-parity row with its single `logicalId: "instance"`
 * finding. `kind` names the condition (`build-mismatch`, `patch-mismatch`,
 * `unverified`, `no-capture`), so a reworded message keeps the same id.
 */
function instanceRow(
  status: CheckStatus,
  message: string,
  kind: string,
): CheckResult {
  return {
    name: INSTANCE_VERSION_CHECK,
    status,
    message,
    findings: [
      makeFinding(INSTANCE_VERSION_CHECK, kind, message, {
        logicalId: INSTANCE_ID,
      }),
    ],
  };
}

/** The `findings` / `findingsTruncated` fields of a row, capped and omitted when empty. */
function cappedFindings(
  list: readonly Finding[],
): Pick<CheckResult, "findings" | "findingsTruncated"> {
  const { findings, truncated } = capFindings(list);
  return {
    ...(findings.length > 0 ? { findings } : {}),
    ...(truncated > 0 ? { findingsTruncated: truncated } : {}),
  };
}

/** Logical id of an app/plugin in parity findings: `app:<scope>`. */
function appId(app: InstalledAppState): string {
  return `app:${app.id}`;
}

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

/** The re-run hint, appended only when re-syncing could actually fix the miss. */
const RERUN_HINT =
  " — re-run sync with an account that can read sys_properties.";

/** One drift side whose identity property is missing, for message composition. */
interface MissingSide {
  /** e.g. `source "staging"`. */
  label: string;
  /** Sync-time classification; `undefined` = unknown (OPP-1 part (b)). */
  reason?: IdentityMissingReason;
}

/**
 * Reason-specific phrasing for a missing identity property (OPP-1 part (b)):
 * `"absent"` is proven not-set (an ACL hint would mislead), `"trimmed"` is
 * proven ACL-hiding (the hint IS the fix), and unknown keeps the pre-(b)
 * wording so manifests without a recorded reason produce byte-identical
 * messages.
 */
function missingPhrase(
  property: string,
  reason: IdentityMissingReason | undefined,
): string {
  if (reason === "absent") return `${property} is not set`;
  if (reason === "trimmed") return `${property} was ACL-hidden at sync time`;
  return `${property} was unreadable at sync time`;
}

/**
 * Compose the clause naming each missing-property side with its
 * reason-specific phrase, folding same-reason sides into one phrase (so the
 * all-unknown case reads exactly as it did before part (b)). `trimmed` flags
 * whether any side proved ACL-trimming, which is what warrants
 * {@link RERUN_HINT}.
 */
function missingClause(
  property: string,
  sides: MissingSide[],
): {
  clause: string;
  trimmed: boolean;
} {
  const groups: { phrase: string; labels: string[] }[] = [];
  for (const side of sides) {
    const phrase = missingPhrase(property, side.reason);
    const last = groups[groups.length - 1];
    if (last && last.phrase === phrase) last.labels.push(side.label);
    else groups.push({ phrase, labels: [side.label] });
  }
  return {
    clause: groups
      .map((g) => `${g.phrase} on ${g.labels.join(" and ")}`)
      .join(" and "),
    trimmed: sides.some((s) => s.reason === "trimmed"),
  };
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
 *   property missing → `warn` with explicit "unverified" wording (fail-closed:
 *   no silent pass on unknown data). Part (b): the wording follows the
 *   sync-time classification of the miss ({@link IdentityMissingReason}) —
 *   proven-absent says "not set" with no ACL hint, proven-trimmed names the
 *   ACL cause and keeps the re-run-sync instruction, unknown keeps the
 *   pre-(b) wording byte-identical. Statuses never change with the reason.
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
    return instanceRow(
      "warn",
      `Manifest for ${noCapture.join(" and ")} predates version capture (no platform identity recorded) — re-run sync to enable instance-version parity.`,
      "no-capture",
    );
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
  // comparable at the release-family level. Fail closed, with wording driven
  // by the sync-time classification (OPP-1 part (b)): a proven-absent property
  // must not send the user chasing sys_properties ACLs, a proven-trimmed one
  // must, and an unknown miss keeps the pre-(b) wording byte-identical.
  if (srcNoBuild || tgtNoBuild) {
    const which = srcNoBuild
      ? `source "${source.instance}"`
      : `target "${target.instance}"`;
    const reason = srcNoBuild ? src.buildNameMissing : tgt.buildNameMissing;
    if (reason === "absent") {
      return instanceRow(
        "warn",
        `glide.buildname is not set on ${which}; instance-version parity is unverified at the release-family level.`,
        "unverified",
      );
    }
    if (reason === "trimmed") {
      return instanceRow(
        "warn",
        `glide.buildname was ACL-hidden at sync time on ${which}; instance-version parity is unverified${RERUN_HINT}`,
        "unverified",
      );
    }
    return instanceRow(
      "warn",
      `glide.buildname was unreadable at sync time on ${which}; instance-version parity is unverified${RERUN_HINT}`,
      "unverified",
    );
  }

  if (src.buildName !== tgt.buildName) {
    return instanceRow(
      "fail",
      `Platform version mismatch: source "${source.instance}" is on ${src.buildName} but target "${target.instance}" is on ${tgt.buildName}. Align instance versions before promoting.`,
      "build-mismatch",
    );
  }

  const noWar: MissingSide[] = [];
  if (src.war === undefined) {
    noWar.push({
      label: `source "${source.instance}"`,
      reason: src.warMissing,
    });
  }
  if (tgt.war === undefined) {
    noWar.push({
      label: `target "${target.instance}"`,
      reason: tgt.warMissing,
    });
  }
  if (noWar.length > 0) {
    const { clause, trimmed } = missingClause("glide.war", noWar);
    return instanceRow(
      "warn",
      `Build names match (${src.buildName}), but ${clause}; patch-level parity is unverified${trimmed ? RERUN_HINT : "."}`,
      "unverified",
    );
  }

  if (src.war !== tgt.war) {
    return instanceRow(
      "warn",
      `Build names match (${src.buildName}), but patch levels differ: source glide.war is "${src.war}" while target is "${tgt.war}".`,
      "patch-mismatch",
    );
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
 * → `pass` (verified at patch level), differing → `warn`, missing on either
 * side → `warn` (fail-closed), worded per the sync-time classification of the
 * miss (OPP-1 part (b), see {@link missingClause}). Never a `fail`: with no
 * build family to compare, a differing patch is an eyeball, not a proven
 * cross-release promote.
 *
 * Part (b) lead clause: the shipped "not set on either instance" claim is
 * provably false when a side recorded `buildNameMissing: "trimmed"`, so a
 * trimmed proof on ANY side replaces the lead with per-side reason wording
 * (and justifies {@link RERUN_HINT} on the warn variants — the pass variant
 * stays a pass with no hint). With no trimmed proof the shipped wording is
 * kept byte-identical, statuses never change either way.
 */
function warOnlyParityResult(
  source: StateManifest,
  target: StateManifest,
  src: InstanceIdentity,
  tgt: InstanceIdentity,
): CheckResult {
  const buildSides: MissingSide[] = [
    { label: `source "${source.instance}"`, reason: src.buildNameMissing },
    { label: `target "${target.instance}"`, reason: tgt.buildNameMissing },
  ];
  const buildTrimmed = buildSides.some((s) => s.reason === "trimmed");
  const lead = buildTrimmed
    ? missingClause("glide.buildname", buildSides).clause
    : "glide.buildname is not set on either instance";

  const noWar: MissingSide[] = [];
  if (src.war === undefined) {
    noWar.push({
      label: `source "${source.instance}"`,
      reason: src.warMissing,
    });
  }
  if (tgt.war === undefined) {
    noWar.push({
      label: `target "${target.instance}"`,
      reason: tgt.warMissing,
    });
  }
  if (noWar.length > 0) {
    const { clause, trimmed } = missingClause("glide.war", noWar);
    return instanceRow(
      "warn",
      `${lead} and ${clause}; instance-version parity is unverified${trimmed || buildTrimmed ? RERUN_HINT : "."}`,
      "unverified",
    );
  }

  if (src.war !== tgt.war) {
    return instanceRow(
      "warn",
      `${lead}; patch levels differ: source glide.war is "${src.war}" while target is "${tgt.war}". Confirm both instances are on the same release before promoting${buildTrimmed ? RERUN_HINT : "."}`,
      "patch-mismatch",
    );
  }

  return {
    name: INSTANCE_VERSION_CHECK,
    status: "pass",
    message: `${lead}; platform patch levels match (verified via glide.war "${src.war}").`,
  };
}

/**
 * An app version as recorded: an optional leading `v`, a dotted numeric core,
 * an optional semver pre-release and an optional build suffix (RR-54, ST-10).
 */
const APP_VERSION =
  /^[vV]?(\d+(?:\s*\.\s*\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Compare two semver pre-release tags; `undefined` (a release) sorts above any
 * pre-release, numeric identifiers below alphanumeric ones.
 */
function comparePrerelease(a?: string, b?: string): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  const xa = a.split(".");
  const xb = b.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const pa = xa[i];
    const pb = xb[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    if (pa === pb) continue;
    const na = /^\d+$/.test(pa);
    const nb = /^\d+$/.test(pb);
    if (na && nb) return Number(pa) - Number(pb);
    if (na !== nb) return na ? -1 : 1;
    return pa < pb ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two app versions for parity: {@link compareVersions} on the numeric
 * core (shared semantics with `scoped-app-deps`, CC-43), then the pre-release
 * tag. `null` when either side is not a version this can read.
 */
function compareAppVersions(a: string, b: string): number | null {
  const ma = APP_VERSION.exec(a.trim());
  const mb = APP_VERSION.exec(b.trim());
  if (!ma || !mb) return null;
  const core = compareVersions(ma[1] as string, mb[1] as string);
  if (core === null) return null;
  return core !== 0 ? core : comparePrerelease(ma[2], mb[2]);
}

/**
 * Compare the recorded app/plugin inventory of the two manifests (OPP-5).
 *
 * - Either manifest lacking an `apps` list (pre-capture manifest, or the
 *   capture was ACL-trimmed and dropped whole) → single ADVISORY `warn`.
 * - An empty source `apps` list → `warn` (nothing compared, RR-48).
 * - App recorded on the source but absent on the target → `fail` (RR-54,
 *   ST-10): the target lacks what the source validated, the same contract as
 *   a test missing downstream.
 * - Target's installed version LOWER than the source's → `fail` (downgrade).
 * - A source app with no recorded version, unparseable versions, or a source
 *   version the target cannot confirm → `warn` naming the app (unverified,
 *   never a silent pass, and never counted in the pass message).
 *   Versions may carry a leading `v` and a semver pre-release (`-beta.1`, which
 *   sorts below the release) or build (`+42`, ignored) suffix.
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

  // RR-48 (ST-11): a real instance always has apps and plugins, and `sync`
  // never writes an empty inventory — an empty list is unproven, not "nothing
  // to gate", so it is never a pass.
  if (sourceApps.length === 0) {
    return [
      {
        name: APP_VERSION_CHECK,
        status: "warn",
        message: `Manifest for source "${source.instance}" records zero installed apps, so app-version parity compared nothing — a real instance always has apps; re-run sync on "${source.instance}".`,
      },
    ];
  }

  const targetById = new Map(targetApps.map((a) => [a.id, a]));
  const missingOnTarget: string[] = [];
  const downgraded: string[] = [];
  const advisories: string[] = [];
  // One finding per app, keyed on `app:<scope>`, collected beside the labels
  // so the aggregate messages stay byte-identical.
  const failFindings: Finding[] = [];
  const advisoryFindings: Finding[] = [];
  const appFinding = (
    app: InstalledAppState,
    kind: string,
    message: string,
    status: CheckStatus,
  ): Finding =>
    makeFinding(
      APP_VERSION_CHECK,
      kind,
      message,
      { logicalId: appId(app) },
      status,
    );
  for (const app of sourceApps) {
    const label = describeApp(app);
    const counterpart = targetById.get(app.id);
    if (!counterpart) {
      missingOnTarget.push(label);
      failFindings.push(
        appFinding(
          app,
          "missing-on-target",
          `App ${label} is recorded on source "${source.instance}" but not installed on target "${target.instance}".`,
          "fail",
        ),
      );
      continue;
    }
    // RR-54 (ST-10): no version on the source proves nothing about the
    // target's version, so the app is unverified, not "matching".
    if (app.version === undefined) {
      const advisory = `${label}: source "${source.instance}" recorded no version — unverified`;
      advisories.push(advisory);
      advisoryFindings.push(appFinding(app, "unverified", advisory, "warn"));
      continue;
    }
    if (counterpart.version === undefined) {
      const advisory = `${label}: source has ${app.version} but the target's installed version is unknown — unverified`;
      advisories.push(advisory);
      advisoryFindings.push(appFinding(app, "unverified", advisory, "warn"));
      continue;
    }
    const order = compareAppVersions(counterpart.version, app.version);
    if (order === null) {
      const advisory = `${label}: versions "${app.version}" (source) and "${counterpart.version}" (target) cannot be compared (non-numeric segment) — unverified`;
      advisories.push(advisory);
      advisoryFindings.push(appFinding(app, "unverified", advisory, "warn"));
      continue;
    }
    if (order < 0) {
      const downgrade = `${label}: target has ${counterpart.version}, below the source's ${app.version}`;
      downgraded.push(downgrade);
      failFindings.push(appFinding(app, "downgraded", downgrade, "fail"));
    }
  }

  const out: CheckResult[] = [];
  // A downgrade (the target runs an OLDER version of an app both carry) and an
  // app the target lacks altogether (RR-54, ST-10 — the documented contract;
  // the earlier advisory let a promote drop a validated app) both block.
  const failParts: string[] = [];
  if (downgraded.length > 0) {
    failParts.push(
      `${downgraded.length} app(s) at a lower version on target "${target.instance}": ${nameList(downgraded)}`,
    );
  }
  if (missingOnTarget.length > 0) {
    failParts.push(
      `${missingOnTarget.length} app(s) recorded on source "${source.instance}" not installed on target "${target.instance}": ${nameList(missingOnTarget)}`,
    );
  }
  if (failParts.length > 0) {
    out.push({
      name: APP_VERSION_CHECK,
      status: "fail",
      message: `App version drift blocks the promote: ${failParts.join("; ")}.`,
      ...cappedFindings(failFindings),
    });
  }
  if (advisories.length > 0) {
    out.push({
      name: APP_VERSION_CHECK,
      status: "warn",
      message: `App version parity has advisories: ${nameList(advisories)}.`,
      ...cappedFindings(advisoryFindings),
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

/** Check name for the promotion-order result a drift run emits. */
export const PROMOTION_ORDER_CHECK = "promotion-order";

/** Options for {@link promotionOrderResult}. */
export interface PromotionOrderOptions {
  /**
   * Downgrade a skipped stage from `fail` to `warn` (the CLI's
   * `--allow-stage-skip`), e.g. for an emergency fix. Never softens a reverse
   * or unrelated pair.
   */
  allowStageSkip?: boolean;
}

/**
 * Promotion order between the two instances a drift run compares, enforced
 * from the registry's `promotesTo` edges. Direction follows
 * {@link computeDrift}: `source` is the validated upstream, `target` the
 * promote destination.
 *
 * - `target` is `source`'s declared next stage → `pass`.
 * - `target` is further downstream, skipping stages → `fail` naming them
 *   (`warn` under `allowStageSkip`): the skipped stage never validated what is
 *   being promoted.
 * - `target` is upstream of `source`, or on no shared chain → `fail`: that is
 *   not a promote the pipeline declares.
 * - An instance the registry does not declare → `fail`: a typo or a stray
 *   manifest must not slip past the promote gate as "unverified".
 * - No registry, or a registry that declares no `promotesTo` at all →
 *   advisory `warn`: the order cannot be verified, and the pipeline is opt-in.
 */
export function promotionOrderResult(
  registry: InstanceRegistry | undefined,
  source: string,
  target: string,
  opts: PromotionOrderOptions = {},
): CheckResult {
  const pair = `"${source}" → "${target}"`;
  const unverified = (why: string): CheckResult => ({
    name: PROMOTION_ORDER_CHECK,
    status: "warn",
    message: `Promotion order of ${pair} not verified: ${why}.`,
  });
  if (!registry) {
    return unverified("no instance registry was found");
  }
  const missing = [source, target].filter(
    (n) => !Object.hasOwn(registry.instances, n),
  );
  if (missing.length > 0) {
    return {
      name: PROMOTION_ORDER_CHECK,
      status: "fail",
      message: `Promotion order of ${pair} cannot be verified: ${missing
        .map((n) => `"${n}"`)
        .join(" and ")} ${
        missing.length === 1 ? "is" : "are"
      } not declared in the instance registry. Declare ${
        missing.length === 1 ? "it" : "them"
      } in the registry or fix the name.`,
    };
  }
  const declaresPipeline = Object.values(registry.instances).some(
    (d) => typeof d.promotesTo === "string",
  );
  if (!declaresPipeline) {
    return unverified(
      "the registry declares no promotesTo pipeline (set promotesTo on each stage to enforce it)",
    );
  }
  const chain = promotionChain(registry, source, target);
  if (chain && chain.length === 2) {
    return {
      name: PROMOTION_ORDER_CHECK,
      status: "pass",
      message: `${pair} is a declared promotion step.`,
    };
  }
  if (chain) {
    const skipped = chain.slice(1, -1).map((n) => `"${n}"`);
    const hops = chain
      .slice(0, -1)
      .map((n, i) => `drift ${n} ${chain[i + 1]}`)
      .join(", ");
    return opts.allowStageSkip
      ? {
          name: PROMOTION_ORDER_CHECK,
          status: "warn",
          message: `${pair} skips ${skipped.join(", ")} (allowed by --allow-stage-skip); the skipped stage(s) never validated this promote.`,
        }
      : {
          name: PROMOTION_ORDER_CHECK,
          status: "fail",
          message: `${pair} skips ${skipped.join(", ")} in the declared pipeline (${chain.join(" → ")}). Gate each hop instead (${hops}), or pass --allow-stage-skip for a deliberate skip.`,
        };
  }
  if (promotionChain(registry, target, source)) {
    return {
      name: PROMOTION_ORDER_CHECK,
      status: "fail",
      message: `${pair} runs against the declared pipeline: "${target}" promotes toward "${source}", not the other way round. Swap the arguments if you meant to gate "${target}" → "${source}".`,
    };
  }
  return {
    name: PROMOTION_ORDER_CHECK,
    status: "fail",
    message: `${pair} is not a declared promotion: "${target}" is not downstream of "${source}" in the registry's promotesTo pipeline.`,
  };
}

/** Check name for the manifest identity / scope results a drift run emits (ST-7, ST-8). */
export const IDENTITY_CHECK = "manifest-identity";

/** One compared manifest for {@link identityResults}: its role, registry name and manifest. */
export interface IdentitySide {
  /** Which side of the promote this is — `source` or `target`. */
  role: string;
  /** The registry instance name the manifest was loaded for. */
  name: string;
  manifest: StateManifest;
}

/**
 * A URL reduced to what identifies an instance: scheme, host (with a
 * non-default port) and path without trailing slashes. `undefined` when the
 * value is absent or not an absolute http(s) URL.
 */
function normalizeInstanceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** A manifest's scope for comparison: trimmed, with absent and `""` both unscoped. */
function scopeOf(manifest: StateManifest): string {
  return typeof manifest.scope === "string" ? manifest.scope.trim() : "";
}

/**
 * Whether the two manifests a drift run compares are what they claim to be
 * (ST-7, ST-8). Each problem is its own row with one `logicalId: "instance"`
 * finding; with none, a single `pass` row.
 *
 * - A manifest whose `instance` is not the name it was loaded for → `fail`
 *   (`instance-mismatch:<role>`): a copied or renamed manifest.
 * - A manifest `url` that differs from the registry's URL for that name →
 *   `fail` (`url-mismatch:<role>`): the manifest was synced from another
 *   instance.
 * - A manifest with no readable `url` → `warn` (`url-unverified:<role>`): its
 *   origin cannot be checked.
 * - Source and target resolving to the same instance URL (or name) → `fail`
 *   (`same-instance`): a self-compare proves nothing about the promote.
 * - Source and target synced for different scopes → `fail`
 *   (`scope-mismatch`): their test sets are not comparable.
 *
 * URLs compare after normalisation (case of scheme/host, default port,
 * trailing slashes).
 */
export function identityResults(
  sides: readonly IdentitySide[],
  registry?: InstanceRegistry,
): CheckResult[] {
  const rows: CheckResult[] = [];
  const row = (status: CheckStatus, kind: string, message: string): void => {
    rows.push({
      name: IDENTITY_CHECK,
      status,
      message,
      findings: [
        makeFinding(
          IDENTITY_CHECK,
          kind,
          message,
          { logicalId: INSTANCE_ID },
          status,
        ),
      ],
    });
  };
  const effective: (string | undefined)[] = [];
  for (const side of sides) {
    const label = `${side.role} "${side.name}"`;
    const recorded = side.manifest.instance as unknown;
    if (recorded !== side.name) {
      row(
        "fail",
        `instance-mismatch:${side.role}`,
        `Manifest loaded for ${label} records instance ${
          typeof recorded === "string" ? `"${recorded}"` : String(recorded)
        }; it belongs to another instance. Re-run sync for "${side.name}".`,
      );
    }
    const def =
      registry && Object.hasOwn(registry.instances, side.name)
        ? registry.instances[side.name]
        : undefined;
    const declared = normalizeInstanceUrl(def?.url);
    const manifestUrl = normalizeInstanceUrl(side.manifest.url);
    if (manifestUrl === undefined) {
      row(
        "warn",
        `url-unverified:${side.role}`,
        `Manifest for ${label} has no readable url, so the instance it was synced from cannot be verified; re-run sync.`,
      );
    } else if (declared !== undefined && manifestUrl !== declared) {
      row(
        "fail",
        `url-mismatch:${side.role}`,
        `Manifest for ${label} was synced from ${manifestUrl}, but the registry declares ${declared} for "${side.name}". Re-run sync for "${side.name}".`,
      );
    }
    effective.push(manifestUrl ?? declared);
  }
  const [source, target] = sides;
  if (source && target) {
    const [sourceUrl, targetUrl] = effective;
    if (source.name === target.name) {
      row(
        "fail",
        "same-instance",
        `Source and target are both "${source.name}"; a drift needs two different instances.`,
      );
    } else if (sourceUrl !== undefined && sourceUrl === targetUrl) {
      row(
        "fail",
        "same-instance",
        `Source "${source.name}" and target "${target.name}" are the same instance (${sourceUrl}); the compare proves nothing about the promote.`,
      );
    }
    const sourceScope = scopeOf(source.manifest);
    const targetScope = scopeOf(target.manifest);
    if (sourceScope !== targetScope) {
      const show = (s: string): string => (s === "" ? "no scope" : `"${s}"`);
      row(
        "fail",
        "scope-mismatch",
        `Source "${source.name}" was synced for ${show(sourceScope)} but target "${target.name}" for ${show(targetScope)}; their tests are not comparable. Re-sync both for the same scope.`,
      );
    }
  }
  if (rows.length === 0) {
    rows.push({
      name: IDENTITY_CHECK,
      status: "pass",
      message: `Manifests match their instances${
        source && target ? ` ("${source.name}" → "${target.name}")` : ""
      } and share one scope.`,
    });
  }
  return rows;
}
