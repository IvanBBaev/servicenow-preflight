import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve, dirname } from "node:path";
import { PREFLIGHT_DIR } from "../registry.js";

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

/** The parsed `<instance>.state.json`. */
export interface StateManifest {
  /** Registry instance name this manifest belongs to. */
  instance: string;
  /** Instance base URL at sync time (informational). */
  url?: string;
  /** Scope the manifest was synced for. */
  scope?: string;
  /** ISO timestamp of the last successful sync. */
  syncedAt?: string;
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
 * Throws on a present-but-malformed file.
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
    throw new Error(`Manifest ${path} is not valid JSON.`);
  }
  const m = parsed as Partial<StateManifest> | null;
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    throw new Error(`Manifest ${path} is not a JSON object.`);
  }
  return {
    instance: m.instance ?? instance,
    url: m.url,
    scope: m.scope,
    syncedAt: m.syncedAt,
    tests: Array.isArray(m.tests) ? m.tests : [],
    suites: Array.isArray(m.suites) ? m.suites : [],
  };
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
  const out = {
    instance: m.instance,
    ...(m.url ? { url: m.url } : {}),
    ...(m.scope ? { scope: m.scope } : {}),
    ...(m.syncedAt ? { syncedAt: m.syncedAt } : {}),
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialize(manifest), "utf8");
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

  return {
    instance: incoming.instance,
    url: incoming.url ?? existing?.url,
    scope: incoming.scope ?? existing?.scope,
    syncedAt: incoming.syncedAt,
    tests,
    suites,
  };
}
