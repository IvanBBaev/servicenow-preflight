import { defaultChecks, testDrift } from "../checks/index.js";
import type {
  Check,
  CheckResult,
  CheckStatus,
  Finding,
  PreflightReport,
} from "../types.js";
import {
  messageOf,
  renderedStatus,
  statusOf,
  type ReportFormatOptions,
} from "./verdict.js";

/** SARIF result severity levels we emit (a subset of the spec's enum). */
type SarifLevel = "error" | "warning";

/**
 * The SARIF level of a non-pass rendered status ({@link renderedStatus}):
 * `fail` (which covers an unknown status and a warn that gated the run under
 * `failOn: "warn"`) and `error` -> `"error"`, `warn` -> `"warning"`.
 */
function levelOf(status: Exclude<CheckStatus, "pass">): SarifLevel {
  return status === "warn" ? "warning" : "error";
}

/** The run-anchored physical location every result carries. */
const RUN_LOCATION = {
  physicalLocation: { artifactLocation: { uri: "servicenow-preflight" } },
} as const;

/** One SARIF `result` as this reporter emits it. */
interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  partialFingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
  locations: Record<string, unknown>[];
}

/**
 * The SARIF location of a finding: the run anchor plus, when the finding names
 * a record or subject, a `logicalLocations[]` entry. The fully qualified name
 * is `table/sys_id[.field][:line]` (or the finding's `logicalId`).
 */
function findingLocation(finding: Finding): Record<string, unknown> {
  const loc = finding.location;
  if (!loc) return RUN_LOCATION;
  const target =
    loc.table !== undefined && loc.sysId !== undefined
      ? `${loc.table}/${loc.sysId}`
      : (loc.logicalId ?? loc.sysId ?? loc.table);
  if (target === undefined) return RUN_LOCATION;
  const fq =
    target +
    (loc.field !== undefined ? `.${loc.field}` : "") +
    (loc.line !== undefined ? `:${loc.line}` : "");
  return {
    ...RUN_LOCATION,
    logicalLocations: [
      {
        name: loc.recordName ?? loc.sysId ?? target,
        fullyQualifiedName: fq,
        kind: "resource",
      },
    ],
  };
}

/** The finding fields a SARIF consumer can filter on, as result properties. */
function findingProperties(finding: Finding): Record<string, unknown> {
  const props: Record<string, unknown> = { findingKind: finding.kind };
  const loc = finding.location;
  if (loc) {
    for (const key of ["table", "sysId", "field", "line"] as const) {
      if (loc[key] !== undefined) props[key] = loc[key];
    }
  }
  return props;
}

/**
 * The SARIF results of one non-pass row. A row without findings is one
 * result. A row with findings is one result per non-pass finding, fingerprinted
 * by `finding.id` (RR-70, REL-4); the row's own result is kept as well when no
 * finding carries the row's level (so the verdict that gated is still an
 * alert) or when the runner dropped findings past its cap.
 */
function rowResults(
  result: CheckResult,
  status: Exclude<CheckStatus, "pass">,
  opts: ReportFormatOptions | undefined,
): SarifResult[] {
  const level = levelOf(status);
  const rowProps =
    result.kind !== undefined ? { properties: { kind: result.kind } } : {};
  const row = (text: string): SarifResult => ({
    ruleId: result.name,
    level,
    message: { text },
    ...rowProps,
    // The report is not tied to a source file; anchor every result to the run
    // itself so the required physical location is well-formed rather than fake.
    locations: [RUN_LOCATION],
  });
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const out: SarifResult[] = [];
  const baselined = result.kind === "baseline";
  for (const finding of findings) {
    const own = statusOf(finding.status ?? result.status, baselined, opts);
    if (own === "pass") continue;
    out.push({
      ruleId: result.name,
      level: levelOf(own),
      message: { text: messageOf(finding) },
      ...(typeof finding.id === "string" && finding.id !== ""
        ? { partialFingerprints: { "findingId/v1": finding.id } }
        : {}),
      properties: {
        ...(result.kind !== undefined ? { kind: result.kind } : {}),
        ...findingProperties(finding),
      },
      locations: [findingLocation(finding)],
    });
  }
  const message = messageOf(result);
  const truncated = result.findingsTruncated ?? 0;
  if (truncated > 0) {
    out.push(row(`${message} (${truncated} more finding(s) not listed)`));
  } else if (!out.some((r) => r.level === level)) {
    out.push(row(message));
  }
  return out;
}

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
 * The log contains a single run whose tool driver is `servicenow-preflight`.
 * Every non-pass row yields results (`pass` rows are omitted): one per
 * non-pass finding when the row carries `findings[]` — with
 * `partialFingerprints["findingId/v1"]` from `finding.id` and a
 * `logicalLocations[]` entry for the record — else one for the row. Levels:
 * `fail`, `error` and an unknown status -> `"error"`, `warn` -> `"warning"`;
 * with `opts.failOn: "warn"` a warn no baseline accepted is `"error"` too, so
 * the log agrees with the exit code. Each result carries `ruleId` = check
 * name, `message.text` and a run-anchored `locations[]` entry so consumers
 * that require a physical location accept it. The driver also advertises a
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
  opts?: ReportFormatOptions,
): string {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const nonPass: {
    result: CheckResult;
    status: Exclude<CheckStatus, "pass">;
  }[] = [];
  for (const result of report.results) {
    const status = renderedStatus(result, opts);
    if (status !== "pass") nonPass.push({ result, status });
  }

  const results = nonPass.flatMap(({ result, status }) =>
    rowResults(result, status, opts),
  );

  // One rule descriptor per distinct check name that produced a result, in
  // first-seen order. `results[].ruleId` references these by `id`.
  const seen = new Set<string>();
  const rules: SarifRule[] = [];
  for (const { result } of nonPass) {
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
