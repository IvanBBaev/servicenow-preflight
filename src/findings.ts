/**
 * Record-level findings: the stable fingerprint and the helpers checks (and the
 * runner) use to build, validate and cap {@link Finding} lists.
 */
import { createHash } from "node:crypto";

import type {
  CheckResult,
  CheckStatus,
  Finding,
  FindingLocation,
} from "./types.js";

/** Most findings one check result may carry; the overflow is counted, not kept. */
export const MAX_FINDINGS = 500;

const FINDING_ID = /^f1:[0-9a-f]{16}$/;
const STATUSES: readonly CheckStatus[] = ["pass", "warn", "fail"];

/**
 * The stable fingerprint of a finding: `"f1:"` plus the first 16 hex digits of
 * a SHA-256 over the check name, the finding kind and the location's identity
 * (table, sys_id, field, logical id). Line, message and record name are left
 * out on purpose, so an edit above a hit, a rename or a wording change keeps
 * the same id.
 */
export function findingId(
  check: string,
  kind: string,
  location?: FindingLocation,
): string {
  const parts = [
    check,
    kind,
    location?.table ?? "",
    location?.sysId ?? "",
    location?.field ?? "",
    location?.logicalId ?? "",
  ];
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
  return `f1:${digest.slice(0, 16)}`;
}

/** Build a finding with its fingerprint filled in. */
export function makeFinding(
  check: string,
  kind: string,
  message: string,
  location?: FindingLocation,
  status?: CheckStatus,
): Finding {
  const finding: Finding = {
    id: findingId(check, kind, location),
    kind,
    message,
  };
  if (status !== undefined) finding.status = status;
  if (location !== undefined) finding.location = location;
  return finding;
}

/** Kind of the implicit finding {@link effectiveFindings} gives a bare row. */
export const ROW_FINDING_KIND = "row";

/**
 * The findings a reporter or the baseline should key on for one result row.
 * A row that carries findings returns them as-is. A non-pass row without
 * findings (a degraded read, a connectivity failure, an aggregate verdict)
 * stands for exactly one implicit finding with kind `"row"` and the fixed
 * logical id `"row"`, so its id depends only on the check name and survives
 * message rewording. A passing row without findings has none.
 *
 * Consumers call this instead of reading `findings` directly, so no non-pass
 * row is ever lost to a per-finding view.
 */
export function effectiveFindings(result: CheckResult): Finding[] {
  if (result.findings !== undefined && result.findings.length > 0) {
    return result.findings;
  }
  if (result.status === "pass") return [];
  return [
    {
      id: findingId(result.name, ROW_FINDING_KIND, { logicalId: "row" }),
      kind: ROW_FINDING_KIND,
      message: result.message,
    },
  ];
}

/** Keep at most `max` findings and count the rest. */
export function capFindings(
  findings: readonly Finding[],
  max: number = MAX_FINDINGS,
): { findings: Finding[]; truncated: number } {
  return {
    findings: findings.slice(0, max),
    truncated: Math.max(0, findings.length - max),
  };
}

function cleanLocation(raw: unknown): FindingLocation | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  const out: FindingLocation = {};
  for (const key of [
    "table",
    "sysId",
    "recordName",
    "field",
    "logicalId",
  ] as const) {
    const value = source[key];
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  const line = source.line;
  if (typeof line === "number" && Number.isInteger(line) && line >= 1) {
    out.line = line;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate the `findings` a check returned. Findings are third-party input:
 * entries that are not objects with a string `kind` and `message` are dropped,
 * unknown or mistyped location fields are stripped, a missing or malformed `id`
 * is recomputed, an invalid `status` is removed, and the list is capped at
 * {@link MAX_FINDINGS}. A bad value never changes the row's status.
 */
export function sanitizeFindings(
  check: string,
  raw: unknown,
  priorTruncated: unknown,
): { findings: Finding[]; truncated: number } {
  const list = Array.isArray(raw) ? raw : [];
  const clean: Finding[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.kind !== "string" || typeof item.message !== "string") {
      continue;
    }
    const location = cleanLocation(item.location);
    const finding: Finding = {
      id:
        typeof item.id === "string" && FINDING_ID.test(item.id)
          ? item.id
          : findingId(check, item.kind, location),
      kind: item.kind,
      message: item.message,
    };
    if ((STATUSES as readonly unknown[]).includes(item.status)) {
      finding.status = item.status as CheckStatus;
    }
    if (location !== undefined) finding.location = location;
    clean.push(finding);
  }
  const capped = capFindings(clean);
  const prior =
    typeof priorTruncated === "number" &&
    Number.isInteger(priorTruncated) &&
    priorTruncated > 0
      ? priorTruncated
      : 0;
  return {
    findings: capped.findings,
    truncated: capped.truncated + prior,
  };
}
