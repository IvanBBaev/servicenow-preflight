import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve, dirname } from "node:path";
import { UsageError } from "../config.js";
import { PREFLIGHT_DIR, validateInstanceName } from "../registry.js";

/**
 * Per-instance **state manifest** — the committed snapshot of what ATF metadata
 * actually lives on one instance: its tests and suites, their per-instance
 * `sys_id`s, and the last run seen. Written by `sync` (Table API pull), consumed
 * by `atf-run` (suite `sys_id`s) and the `test-drift` check (logical `id`s).
 *
 * Manifests hold **no secrets** and are committed, so drift shows up as a
 * reviewable diff. Lives at `.preflight/state/<instance>.state.json`.
 *
 * Identity is split (see the design doc): `id` is a **logical** identity
 * (`scope/slug`) stable across instances; `sysId` is **per-instance**. Merge
 * reconciles a freshly-synced snapshot against the committed one so logical
 * `id`s stay stable even when a locally-created test has a different `sys_id`
 * on every instance.
 */

/** Directory under {@link PREFLIGHT_DIR} holding per-instance manifests. */
export const STATE_DIR = "state";

/** What an ATF test covers — used to match tests across instances by meaning. */
export interface AtfCoverage {
  /** e.g. `script_include`, `business_rule`, `client_script`. */
  type: string;
  /** Name of the covered artifact. */
  name: string;
}

/** The last run observed for a test (from `sys_atf_test_result`). */
export interface AtfRunRef {
  /** ISO timestamp of the run. */
  at: string;
  /** Normalised status (`pass` / `fail` / other raw ATF status). */
  status: string;
  /** `sys_atf_test_result` sys_id, for traceability. */
  resultId?: string;
}

/** One ATF test as recorded on an instance. */
export interface AtfTestState {
  /** Logical identity `scope/slug` — stable across instances. */
  id: string;
  /** Per-instance `sys_atf_test.sys_id`. */
  sysId?: string;
  /** Human-readable test name. */
  name: string;
  /** What the test covers (drives cross-instance matching). */
  covers?: AtfCoverage;
  /** Whether the test is active on the instance. */
  active?: boolean;
  /** Last observed run. */
  lastRun?: AtfRunRef;
}

/** One ATF test suite as recorded on an instance. */
export interface AtfSuiteState {
  /** Logical identity `scope/slug` — stable across instances. */
  id: string;
  /** Per-instance `sys_atf_test_suite.sys_id`. */
  sysId?: string;
  /** Human-readable suite name. */
  name: string;
  /** Logical `id`s of the member tests (order preserved). */
  testIds: string[];
}

/**
 * Why an identity property value is missing (OPP-1 part (b)), proven at sync
 * time from the pre-trim `X-Total-Count` metadata:
 *
 * - `"absent"` — the instance proved the property does not exist or holds no
 *   value: zero matching rows pre-trim, or every matching row visible under an
 *   untrimmed counted read with none carrying a value. A blank visible row
 *   alone is NOT proof — a second, valued row could be ACL-hidden beside it.
 * - `"trimmed"` — matching rows exist but were ACL-hidden from the syncing
 *   account (re-syncing with a more privileged account would capture them).
 *
 * An unprovable miss carries NO reason (the field is omitted) — a reason is
 * never fabricated, and drift keeps its generic "unreadable" wording for it.
 */
export type IdentityMissingReason = "absent" | "trimmed";

/**
 * The instance's platform version identity at sync time (OPP-1), read from
 * `sys_properties`. `buildName` is `glide.buildname` (the release family, e.g.
 * `"Xanadu"`); `war` is `glide.war` (the exact build artifact, which moves on
 * every patch). Either field may be absent when the property was unreadable or
 * ACL-hidden at sync time — absence is recorded honestly, never fabricated.
 * When a value is absent, its `*Missing` companion may record WHY (part (b)),
 * so drift can distinguish "not set on the instance" from "ACL-hidden".
 */
export interface InstanceIdentity {
  /** Value of `glide.buildname` (release family). */
  buildName?: string;
  /**
   * Why `buildName` is missing ({@link IdentityMissingReason}). Present only
   * when `buildName` is absent AND the cause was proven at sync time.
   */
  buildNameMissing?: IdentityMissingReason;
  /** Value of `glide.war` (exact build / patch level). */
  war?: string;
  /**
   * Why `war` is missing ({@link IdentityMissingReason}). Present only when
   * `war` is absent AND the cause was proven at sync time.
   */
  warMissing?: IdentityMissingReason;
}

/**
 * One installed application or versioned plugin as recorded at sync time
 * (OPP-5). `id` is the cross-instance identity: the app scope for
 * `sys_store_app` / `sys_app` rows, or the plugin id/source for `sys_plugins`
 * rows. `version` is the INSTALLED version only — never `latest_version`
 * (SN-5) — and is absent when the instance did not report one.
 */
export interface InstalledAppState {
  /** Cross-instance identity (app scope, or plugin id/source). */
  id: string;
  /** Human-readable name (informational, for messages). */
  name?: string;
  /** Installed version (dot-separated); absent when not reported (SN-5). */
  version?: string;
}

/** The manifest format version this build reads and writes. */
export const MANIFEST_VERSION = 1;

/** The parsed `<instance>.state.json`. */
export interface StateManifest {
  /**
   * Format version. `sync` always writes {@link MANIFEST_VERSION}; an absent
   * value reads as 1 (manifests written before versioning), any other value is
   * refused.
   */
  version?: 1;
  /** Registry instance name this manifest belongs to. */
  instance: string;
  /** Instance base URL at sync time (informational). */
  url?: string;
  /** Scope the manifest was synced for. */
  scope?: string;
  /** ISO timestamp of the last successful sync. */
  syncedAt?: string;
  /**
   * Platform version identity captured at sync time (OPP-1). Absent on
   * manifests written before version capture existed, or when the properties
   * were unreadable — drift then reports an advisory, never a hard failure.
   */
  identity?: InstanceIdentity;
  /**
   * Installed apps/plugins captured at sync time (OPP-5). Absent on manifests
   * written before version capture existed, or when the reads were ACL-trimmed
   * (a partial inventory would mis-gate, so it is dropped whole).
   */
  apps?: InstalledAppState[];
  /** Tests present on the instance. */
  tests: AtfTestState[];
  /** Suites present on the instance. */
  suites: AtfSuiteState[];
}

/** Absolute path of one instance's manifest for a working directory. */
export function manifestPath(
  instance: string,
  cwd: string = process.cwd(),
): string {
  // CC-14/CC-16: the instance name becomes a filesystem path segment here, so a
  // separator, `..`, or surrounding whitespace could escape the state directory
  // or silently mis-target another instance's manifest. Validate before use.
  validateInstanceName(instance, "manifestPath");
  return resolve(cwd, PREFLIGHT_DIR, STATE_DIR, `${instance}.state.json`);
}

/** A `slug` fragment from a free-text name (lowercase, non-word → `-`). */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build a logical `id` (`scope/slug`) from a scope and an artifact name. */
export function logicalId(scope: string | undefined, name: string): string {
  const slug = slugify(name) || "unnamed";
  return scope ? `${scope}/${slug}` : slug;
}

/** An empty manifest for an instance (used before the first sync). */
export function emptyManifest(
  instance: string,
  url?: string,
  scope?: string,
): StateManifest {
  return { instance, url, scope, tests: [], suites: [] };
}

/**
 * Load one instance's manifest, or `undefined` when it has never been synced.
 * Throws a {@link UsageError} (CLI exit 2) on a present-but-malformed file.
 */
export async function loadManifest(
  instance: string,
  cwd: string = process.cwd(),
  explicitPath?: string,
): Promise<StateManifest | undefined> {
  const path = explicitPath
    ? isAbsolute(explicitPath)
      ? explicitPath
      : resolve(cwd, explicitPath)
    : manifestPath(instance, cwd);
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`Manifest ${path} is not valid JSON.`);
  }
  const m = parsed as Partial<StateManifest> | null;
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    throw new UsageError(`Manifest ${path} is not a JSON object.`);
  }
  // F-R-13: only version 1 is understood. A newer format could carry fields
  // this build would silently drop or mis-read, so refuse it outright; an
  // ABSENT version is a pre-versioning manifest and reads as 1.
  const version: unknown = m.version;
  if (version !== undefined && version !== MANIFEST_VERSION) {
    throw new UsageError(
      `State manifest ${path} has version ${JSON.stringify(version)}; ` +
        `this servicenow-preflight supports version ${MANIFEST_VERSION} — ` +
        `upgrade the tool.`,
    );
  }
  // CC-36: a manifest that declares a *different* instance than the one it is
  // being loaded as was almost certainly copied or renamed — trusting it would
  // let one instance's coverage masquerade as another's. Reject the mismatch;
  // an ABSENT instance field is fine and falls back to the requested name.
  if (typeof m.instance === "string" && m.instance !== instance) {
    throw new UsageError(
      `Manifest ${path} declares instance "${m.instance}" but was loaded as ` +
        `"${instance}". The file was likely copied or renamed; re-sync ` +
        `"${instance}" or load the correct file.`,
    );
  }
  // RR-48 (ST-3): `sync` always writes both lists. A missing or non-array
  // `tests`/`suites` is a truncated or hand-edited file, not "no tests" —
  // reading it as `[]` let drift pass with nothing compared.
  const tests = requireArray(m.tests, "tests", path);
  const suites = requireArray(m.suites, "suites", path);
  // CC-18: every test/suite must carry a non-empty string `id` — it is the
  // logical key drift compares on and merge reconciles by. A missing/blank id
  // would silently corrupt both, so fail with the file and element index named.
  validateElements(tests, "tests", path);
  validateElements(suites, "suites", path);
  // RR-48 (ST-4): two entries sharing one logical id collapse into one when
  // drift indexes by id, so a test could vanish from the gate unseen.
  rejectDuplicateIds(
    tests,
    "tests",
    `Manifest ${path}`,
    (d) => new UsageError(d),
  );
  rejectDuplicateIds(
    suites,
    "suites",
    `Manifest ${path}`,
    (d) => new UsageError(d),
  );
  const loaded: StateManifest = {
    instance: m.instance ?? instance,
    url: m.url,
    scope: m.scope,
    syncedAt: m.syncedAt,
    tests,
    suites,
  };
  // The version-capture keys are added only when present so a manifest written
  // BEFORE this feature loads into an object indistinguishable from what the
  // pre-capture loader produced (round-trip compatibility, OPP-1/OPP-5).
  const identity = sanitizeIdentity(m.identity);
  if (identity) loaded.identity = identity;
  const apps = readApps(m.apps, path);
  if (apps) loaded.apps = apps;
  return loaded;
}

/** The value of a required list key, or a {@link UsageError} naming the file. */
function requireArray<T>(
  raw: T[] | undefined,
  kind: "tests" | "suites",
  path: string,
): T[] {
  if (Array.isArray(raw)) return raw;
  const found = raw === undefined ? "is missing" : `is ${describeJson(raw)}`;
  throw new UsageError(
    `Manifest ${path}: "${kind}" ${found}; expected an array. The file is ` +
      `truncated or hand-edited — re-run sync to rewrite it.`,
  );
}

/** A short JSON type label for error messages. */
function describeJson(raw: unknown): string {
  if (raw === null) return "null";
  if (Array.isArray(raw)) return "an array";
  return typeof raw === "object" ? "an object" : `a ${typeof raw}`;
}

/**
 * Throw (via `make`) when two entries share one logical `id` (RR-48, ST-4).
 * The message names the id and the entries' names and `sysId`s so the
 * duplicate can be found in the file.
 */
export function rejectDuplicateIds(
  items: readonly unknown[],
  kind: string,
  where: string,
  make: (message: string) => Error,
): void {
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    const id = (item as { id: string }).id;
    const prior = seen.get(id);
    if (prior === undefined) {
      seen.set(id, index);
      return;
    }
    throw make(
      `${where}: ${kind}[${prior}] (${entryLabel(items[prior])}) and ` +
        `${kind}[${index}] (${entryLabel(item)}) share the logical id "${id}". ` +
        `Drift indexes by id, so one of them would vanish from the gate. Give ` +
        `one entry its own id (or remove the stale one) and re-run sync.`,
    );
  });
}

/** `"name", sysId …` for a duplicate-id message. */
function entryLabel(item: unknown): string {
  const o = item as { name?: unknown; sysId?: unknown };
  const name = typeof o.name === "string" ? `"${o.name}"` : "no name";
  return typeof o.sysId === "string" && o.sysId !== ""
    ? `${name}, sysId ${o.sysId}`
    : name;
}

/**
 * Tolerantly read the optional `identity` block (OPP-1). Manifests written
 * before version capture have none; a hand-edited or malformed block must not
 * crash the load — drift downgrades absence to an advisory. Only string fields
 * survive; anything else reads as absent. A `*Missing` reason (part (b)) is
 * kept only when it is one of the two known literals AND its value is truly
 * missing — anything else fails safe to unknown (field dropped).
 */
function sanitizeIdentity(raw: unknown): InstanceIdentity | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as {
    buildName?: unknown;
    buildNameMissing?: unknown;
    war?: unknown;
    warMissing?: unknown;
  };
  const identity: InstanceIdentity = {};
  if (typeof o.buildName === "string" && o.buildName !== "") {
    identity.buildName = o.buildName;
  }
  if (typeof o.war === "string" && o.war !== "") identity.war = o.war;
  if (identity.buildName === undefined) {
    const reason = sanitizeMissingReason(o.buildNameMissing);
    if (reason) identity.buildNameMissing = reason;
  }
  if (identity.war === undefined) {
    const reason = sanitizeMissingReason(o.warMissing);
    if (reason) identity.warMissing = reason;
  }
  return identity.buildName !== undefined || identity.war !== undefined
    ? identity
    : undefined;
}

/** Accept only the two {@link IdentityMissingReason} literals; else unknown. */
function sanitizeMissingReason(
  raw: unknown,
): IdentityMissingReason | undefined {
  return raw === "absent" || raw === "trimmed" ? raw : undefined;
}

/**
 * Read the optional `apps` list (OPP-5). An ABSENT key is a manifest written
 * before version capture (or a trimmed capture `sync` dropped whole) and reads
 * as never-captured. A PRESENT key must be well-formed (RR-48, ST-11): a
 * non-array value, or an entry that is not an object, lacks a non-empty string
 * `id`, or carries a `name`/`version` that is not a non-empty string, is a
 * {@link UsageError}. Dropping such entries used to leave an empty or partial
 * inventory that drift read as "nothing to gate".
 */
function readApps(raw: unknown, path: string): InstalledAppState[] | undefined {
  if (raw === undefined) return undefined;
  const bad = (detail: string): UsageError =>
    new UsageError(
      `Manifest ${path}: ${detail}. The file is truncated or hand-edited — ` +
        `re-run sync to rewrite it.`,
    );
  if (!Array.isArray(raw)) {
    throw bad(`"apps" is ${describeJson(raw)}; expected an array`);
  }
  return (raw as unknown[]).map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw bad(`apps[${index}] is ${describeJson(entry)}; expected an object`);
    }
    const o = entry as { id?: unknown; name?: unknown; version?: unknown };
    if (typeof o.id !== "string" || o.id === "") {
      throw bad(`apps[${index}] is missing a non-empty string "id"`);
    }
    const app: InstalledAppState = { id: o.id };
    for (const key of ["name", "version"] as const) {
      const value = o[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || value === "") {
        throw bad(
          `apps[${index}] ("${o.id}") has a "${key}" that is not a non-empty string`,
        );
      }
      app[key] = value;
    }
    return app;
  });
}

/** Assert every manifest element carries a non-empty string `id` (CC-18). */
function validateElements(
  items: unknown[],
  kind: "tests" | "suites",
  path: string,
): void {
  items.forEach((item, index) => {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new UsageError(
        `Manifest ${path}: ${kind}[${index}] is missing a non-empty string "id".`,
      );
    }
  });
}

/** Serialize a manifest with a stable field order for clean diffs. */
function serialize(m: StateManifest): string {
  const tests = [...m.tests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => ({
      id: t.id,
      ...(t.sysId ? { sysId: t.sysId } : {}),
      name: t.name,
      ...(t.covers
        ? { covers: { type: t.covers.type, name: t.covers.name } }
        : {}),
      ...(t.active !== undefined ? { active: t.active } : {}),
      ...(t.lastRun
        ? {
            lastRun: {
              at: t.lastRun.at,
              status: t.lastRun.status,
              ...(t.lastRun.resultId ? { resultId: t.lastRun.resultId } : {}),
            },
          }
        : {}),
    }));
  const suites = [...m.suites]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({
      id: s.id,
      ...(s.sysId ? { sysId: s.sysId } : {}),
      name: s.name,
      testIds: [...s.testIds].sort((a, b) => a.localeCompare(b)),
    }));
  // Identity is omitted entirely when absent or empty — the omit-when-absent
  // discipline IS the schema-compat mechanism, so a manifest without version
  // capture (OPP-1) serializes byte-identically to the pre-capture format. A
  // `*Missing` reason (part (b)) is emitted only for a value that is genuinely
  // missing, mirroring the loader, so a contradictory pair cannot round-trip.
  const identity =
    m.identity && (m.identity.buildName ?? m.identity.war) !== undefined
      ? {
          identity: {
            ...(m.identity.buildName
              ? { buildName: m.identity.buildName }
              : {}),
            ...(!m.identity.buildName && m.identity.buildNameMissing
              ? { buildNameMissing: m.identity.buildNameMissing }
              : {}),
            ...(m.identity.war ? { war: m.identity.war } : {}),
            ...(!m.identity.war && m.identity.warMissing
              ? { warMissing: m.identity.warMissing }
              : {}),
          },
        }
      : {};
  // Apps are sorted by id for stable diffs; omitted when never captured
  // (OPP-5). An empty-but-present array is preserved — it means "captured,
  // nothing installed", which drift treats differently from "never captured".
  const apps = m.apps
    ? {
        apps: [...m.apps]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((a) => ({
            id: a.id,
            ...(a.name ? { name: a.name } : {}),
            ...(a.version ? { version: a.version } : {}),
          })),
      }
    : {};
  const out = {
    version: MANIFEST_VERSION,
    instance: m.instance,
    ...(m.url ? { url: m.url } : {}),
    ...(m.scope ? { scope: m.scope } : {}),
    ...(m.syncedAt ? { syncedAt: m.syncedAt } : {}),
    ...identity,
    ...apps,
    tests,
    suites,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Write an instance's manifest to `.preflight/state/<instance>.state.json`,
 * creating the directory if needed. Fields are emitted in a stable order (and
 * tests/suites sorted by `id`) so a re-sync produces a minimal, reviewable diff.
 * Returns the path written.
 */
export async function writeManifest(
  manifest: StateManifest,
  cwd: string = process.cwd(),
  explicitPath?: string,
): Promise<string> {
  const path = explicitPath
    ? isAbsolute(explicitPath)
      ? explicitPath
      : resolve(cwd, explicitPath)
    : manifestPath(manifest.instance, cwd);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  // CC-17: write atomically. A committed manifest is a gate input, so a crash or
  // concurrent read mid-write must never observe a truncated/partial file. Write
  // to a unique temp sibling in the SAME directory (so `rename` stays on one
  // filesystem and is atomic), then swap it into place.
  const tmp = resolve(dir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, serialize(manifest), "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return path;
}

/** Whether two coverage descriptors refer to the same artifact. */
function sameCoverage(a?: AtfCoverage, b?: AtfCoverage): boolean {
  if (!a || !b) return false;
  return a.type === b.type && a.name === b.name;
}

/**
 * Find the committed test that a freshly-synced one corresponds to. Matches by
 * `sysId` first (an update-set/scoped-app delivery keeps its `sys_id` across
 * instances), then by `name` — with coverage used only to disambiguate when two
 * committed tests share a name (a locally-created test has a per-instance
 * `sys_id`, so `name` is the reliable cross-instance key).
 */
function matchTest(
  incoming: AtfTestState,
  existing: AtfTestState[],
): AtfTestState | undefined {
  if (incoming.sysId) {
    const bySysId = existing.find((e) => e.sysId && e.sysId === incoming.sysId);
    if (bySysId) return bySysId;
  }
  const sameName = existing.filter((e) => e.name === incoming.name);
  if (sameName.length <= 1) return sameName[0];
  if (incoming.covers) {
    const byCover = sameName.find((e) =>
      sameCoverage(e.covers, incoming.covers),
    );
    if (byCover) return byCover;
  }
  return sameName[0];
}

/** Reconcile synced tests against the committed ones, preserving logical `id`s. */
function reconcileTests(
  existing: AtfTestState[],
  incoming: AtfTestState[],
): AtfTestState[] {
  return incoming.map((t) => {
    const match = matchTest(t, existing);
    return { ...t, id: match?.id ?? t.id };
  });
}

/** Reconcile synced suites against the committed ones, preserving logical `id`s. */
function reconcileSuites(
  existing: AtfSuiteState[],
  incoming: AtfSuiteState[],
): AtfSuiteState[] {
  return incoming.map((s) => {
    const match =
      (s.sysId && existing.find((e) => e.sysId === s.sysId)) ||
      existing.find((e) => e.name === s.name);
    return { ...s, id: match ? match.id : s.id };
  });
}

/**
 * Merge a freshly-synced snapshot into the committed manifest. The **set** of
 * tests/suites and their volatile fields (`sysId`, `name`, `covers`, `active`,
 * `lastRun`) come from `incoming` — it reflects the instance's current reality —
 * while logical `id`s are preserved from `existing` wherever a match is found
 * (by `sysId`, else name/coverage). Never blind-overwrites `id`s, so a committed
 * manifest evolves as a clean diff instead of churning every sync.
 *
 * Throws when the merged result would hold two tests (or two suites) with one
 * logical `id` (RR-48); nothing is returned to write.
 */
export function mergeManifest(
  existing: StateManifest | undefined,
  incoming: StateManifest,
): StateManifest {
  const tests = reconcileTests(existing?.tests ?? [], incoming.tests);

  // A reconciled test may have kept a committed logical `id` that differs from
  // the freshly-synced one. Suite membership (`testIds`) is pulled with the
  // fresh ids, so remap it through the same reconciliation to keep the manifest
  // internally consistent (no suite pointing at a non-existent test `id`).
  const idRemap = new Map<string, string>();
  incoming.tests.forEach((t, i) => {
    const finalId = tests[i]?.id;
    if (finalId && finalId !== t.id) idRemap.set(t.id, finalId);
  });
  const suites = reconcileSuites(existing?.suites ?? [], incoming.suites).map(
    (s) => ({ ...s, testIds: s.testIds.map((id) => idRemap.get(id) ?? id) }),
  );

  // RR-48 (ST-4): sync checks the fresh snapshot for id collisions, but the
  // reconciliation above can still give two entries one id — e.g. a test
  // renamed on the instance keeps its committed id by `sysId` while a NEW test
  // with the old name takes the same id by name. Refuse the merged result.
  const where = `Merging the synced snapshot for "${incoming.instance}"`;
  const mergeError = (message: string): Error => new Error(message);
  rejectDuplicateIds(tests, "tests", where, mergeError);
  rejectDuplicateIds(suites, "suites", where, mergeError);

  return {
    instance: incoming.instance,
    url: incoming.url ?? existing?.url,
    scope: incoming.scope ?? existing?.scope,
    // CC-38: preserve the committed `syncedAt` when the incoming snapshot omits
    // one. A library caller that pulls without `opts.now` produces a snapshot
    // with no `syncedAt`; taking it verbatim would erase the last-known sync
    // time and make the manifest read as never-synced (failing the freshness
    // gate). A fresh sync that DOES set `syncedAt` still wins.
    syncedAt: incoming.syncedAt ?? existing?.syncedAt,
    // OPP-1/OPP-5: the incoming snapshot wins verbatim, INCLUDING absence — the
    // deliberate opposite of the CC-38 fallback above. Version capture reflects
    // the instance NOW; falling back to a stale committed identity/app list
    // when the fresh pull could not read them would let outdated versions gate
    // a promote. Honest absence (→ advisory warn in drift) beats stale data.
    identity: incoming.identity,
    apps: incoming.apps,
    tests,
    suites,
  };
}
