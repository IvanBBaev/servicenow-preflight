import { defaultChecks, testDrift } from "./checks/index.js";
import type { Check, CheckMeta } from "./types.js";

/** A check's catalogue entry: its identity plus the metadata it declares. */
export interface CheckDescriptor {
  name: string;
  description: string;
  /** Always present; `{}` when the check declared no metadata. */
  meta: CheckMeta;
  /** `true` when the check is part of the default suite. */
  inDefaultSuite: boolean;
}

/**
 * Describe `checks` for a catalogue (CLI `list`, docs, SARIF), in the order
 * given. Never throws on a check that declares no `meta`.
 */
export function describeChecks(
  checks: readonly Check[],
  defaults: readonly Check[] = defaultChecks,
): CheckDescriptor[] {
  const inDefaults = new Set(defaults.map((check) => check.name));
  return checks.map((check) => ({
    name: check.name,
    description: check.description,
    meta: check.meta ?? {},
    inDefaultSuite: inDefaults.has(check.name),
  }));
}

/**
 * Find a check by exact name. The default search list is the default suite
 * plus `test-drift`, which only runs as a promote gate.
 */
export function findCheck(
  name: string,
  checks: readonly Check[] = [...defaultChecks, testDrift],
): Check | undefined {
  return checks.find((check) => check.name === name);
}

/**
 * Titles of the certification rules the checks map to, keyed by rule id —
 * the `### ` headings of `ci/certification/CHECKLIST.md` (without the
 * severity/frequency suffix).
 */
export const RULE_TITLES: Readonly<Record<string, string>> = {
  "1.1": "Every custom table has CRUD ACLs bound to roles",
  "1.2": "Client-callable Script Includes are ACL-protected",
  "1.3": "Scripted REST resources require Authentication + REST_Endpoint ACLs",
  "1.4": "No script-type columns exposed to non-admins",
  "1.6": "No ACLs shipped onto out-of-scope / OOB tables",
  "2.1": "UI Actions are gated by a condition and/or Required Roles",
  "2.2": "UI Pages have read ACLs",
  "2.6": "Service Portal widgets & pages have roles",
  "2.8": "No client-side eval(); validate GlideScopedEvaluator sources",
  "4.5": "No hard-coded URLs/constants",
  "4.10":
    "Remove empty/commented Fix Scripts & duplicate-named Script Includes",
  "5.1": "Remove mobile Application Menus & Modules from non-mobile apps",
  "5.5": "Modules have roles",
  "6.1": "All tables namespaced",
  "6.2": 'Scheduled Jobs have empty "Run as"',
};

/** Levenshtein edit distance between two strings. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * Up to `max` candidates close to `name`: those it is a prefix of (at least
 * three characters), or within edit distance 2. Closest first, then by name.
 */
export function closestNames(
  name: string,
  candidates: readonly string[],
  max = 3,
): string[] {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return [];
  return candidates
    .map((c) => ({ c, d: editDistance(needle, c.toLowerCase()) }))
    .filter(
      ({ c, d }) =>
        d <= 2 || (needle.length >= 3 && c.toLowerCase().startsWith(needle)),
    )
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c))
    .slice(0, max)
    .map(({ c }) => c);
}
