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
