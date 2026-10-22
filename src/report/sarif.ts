import { defaultChecks, testDrift } from "../checks/index.js";
import type { Check, CheckStatus, PreflightReport } from "../types.js";

/** SARIF result severity levels we emit (a subset of the spec's enum). */
type SarifLevel = "error" | "warning";

/**
 * Map a non-pass {@link CheckStatus} to its SARIF result level.
 *
 * `fail` -> `"error"`, `warn` -> `"warning"`. `pass` has no SARIF result
 * (passing checks are omitted from `results[]`), so it is not mappable here.
 */
const LEVEL_BY_STATUS: Record<Exclude<CheckStatus, "pass">, SarifLevel> = {
  fail: "error",
  warn: "warning",
};

/** A SARIF `reportingDescriptor` as this reporter emits it. */
interface SarifRule {
  id: string;
  shortDescription?: { text: string };
  fullDescription?: { text: string };
  properties?: { rule?: string; severity?: string; tables?: string[] };
}

/** Build the rule descriptor for `id`, enriched when the check is known. */
function ruleFor(id: string, check: Check | undefined): SarifRule {
  if (!check) return { id };
  const rule: SarifRule = {
    id,
    shortDescription: { text: check.description },
  };
  const meta = check.meta;
  if (meta?.remediation) rule.fullDescription = { text: meta.remediation };
  const properties: NonNullable<SarifRule["properties"]> = {};
  if (meta?.rule !== undefined) properties.rule = meta.rule;
  if (meta?.severity !== undefined) properties.severity = meta.severity;
  if (meta?.tables !== undefined) properties.tables = [...meta.tables];
  if (Object.keys(properties).length > 0) rule.properties = properties;
  return rule;
}

/**
 * Format a {@link PreflightReport} as a SARIF 2.1.0 JSON string (for
 * code-scanning / GitHub Advanced Security ingestion).
 *
 * The log contains a single run whose tool driver is `servicenow-preflight`,
 * with one `results[]` entry per non-pass check: `fail` maps to level
 * `"error"`, `warn` to `"warning"`, and `pass` checks are omitted. Each result
 * carries `ruleId` = check name, `message.text` = the check message, and a
 * `locations[]` entry so consumers that require a physical location (some
 * code-scanning ingesters do) accept the result. The driver also advertises a
 * `rules[]` entry per distinct `ruleId`, which strict SARIF viewers expect.
 *
 * When a result's check is found in `checks` (by name), its rule descriptor is
 * enriched from the check: `shortDescription` (the check description),
 * `fullDescription` (its `meta.remediation`, when declared) and `properties`
 * (`rule`, `severity`, `tables`, when declared). An unknown name keeps the
 * bare `{ id }` descriptor.
 */
export function formatSarif(
  report: PreflightReport,
  checks: readonly Check[] = [...defaultChecks, testDrift],
): string {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const nonPass = report.results.filter((result) => result.status !== "pass");

  const results = nonPass.map((result) => ({
    ruleId: result.name,
    level: LEVEL_BY_STATUS[result.status as Exclude<CheckStatus, "pass">],
    message: { text: result.message },
    // The report is not tied to a source file; anchor every result to the run
    // itself so the required physical location is well-formed rather than fake.
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: "servicenow-preflight" },
        },
      },
    ],
  }));

  // One rule descriptor per distinct check name that produced a result, in
  // first-seen order. `results[].ruleId` references these by `id`.
  const seen = new Set<string>();
  const rules: SarifRule[] = [];
  for (const result of nonPass) {
    if (!seen.has(result.name)) {
      seen.add(result.name);
      rules.push(ruleFor(result.name, byName.get(result.name)));
    }
  }

  const log = {
    version: "2.1.0",
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "servicenow-preflight",
            rules,
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(log, null, 2);
}
