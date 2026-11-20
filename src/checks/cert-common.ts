/**
 * Helpers shared by the ServiceNow Store **certification checks** — the checks
 * derived from the recurring ServiceNow scoped-app certification findings, gated
 * by `ci/certification/CHECKLIST.md`. Each check queries live instance metadata
 * (the rules the text scanner `ci/certification/scan.sh` explicitly cannot
 * cover), so they all share the same read-triage and error-mapping semantics
 * rather than re-deriving them per file.
 */

import type {
  CheckResult,
  CheckStatus,
  Finding,
  FindingLocation,
} from "../types.js";
import { makeFinding } from "../findings.js";
import {
  SnAuthError,
  SnHttpError,
  SnNetworkError,
  type SnClient,
  type TableQueryResult,
} from "../http/client.js";
import { and, chunk, eq, inClause, type ResolvedScope } from "../http/query.js";

/** Read a string-ish field from an arbitrary record, trimmed; "" when absent. */
export function str(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // ServiceNow reference fields may arrive as { value, link, display_value }.
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") return inner.trim();
  }
  return "";
}

/** ServiceNow encodes booleans as "true"/"false" strings or real booleans. */
export function isTruthy(row: Record<string, unknown>, field: string): boolean {
  const value = row[field];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

/**
 * What a **zero-row** metadata read actually proved. A zero-row read is not
 * proof of a clean app (SN-1): the account may simply be unable to see the
 * rows. `queryWithMeta`'s pre-trim `X-Total-Count` disambiguates:
 *
 * - `"trimmed"` — rows match but none are visible: the account is
 *   security-trimmed and the gate cannot see what it must inspect.
 * - `"empty"` — the instance itself reports 0 matching rows: genuinely none.
 * - `"ambiguous"` — no pre-trim count arrived, so "none shipped" and "no read
 *   access" are indistinguishable; the verdict must not be a plain pass.
 */
export type ZeroReadTriage = "trimmed" | "empty" | "ambiguous";

/** Triage a zero-row {@link TableQueryResult} — see {@link ZeroReadTriage}. */
export function triageZeroRead(meta: TableQueryResult): ZeroReadTriage {
  if (meta.securityTrimmed) return "trimmed";
  if (meta.totalCount === 0) return "empty";
  return "ambiguous";
}

/**
 * One finding for one offending record: location `{table, sysId, recordName}`
 * and a check-local `kind` (`"no-role"`, `"acl-missing:create"`, …). The label
 * is `str(row, labelField) || str(row, "sys_id")` — the same string the row
 * message lists; pass a function when the check builds its label from several
 * fields — and `message` defaults to `"<label> (<table>): <kind>"`. The
 * id rests on the sys_id, so a rename keeps it; a row without a sys_id falls
 * back to `logicalId: "name:<label>"`.
 */
export function rowFinding(
  check: string,
  table: string,
  row: Record<string, unknown>,
  kind: string,
  labelField: string | ((row: Record<string, unknown>) => string) = "name",
  message?: string,
): Finding {
  const sysId = str(row, "sys_id");
  const label =
    (typeof labelField === "function"
      ? labelField(row)
      : str(row, labelField)) ||
    sysId ||
    "(unnamed)";
  const location: FindingLocation = { table };
  if (sysId !== "") location.sysId = sysId;
  else location.logicalId = `name:${label}`;
  location.recordName = label;
  return makeFinding(
    check,
    kind,
    message ?? `${label} (${table}): ${kind}`,
    location,
  );
}

/**
 * One finding for a subject that is not one record (a table, a property name):
 * location `{logicalId, recordName}`, message `"<label>: <kind>"` by default.
 */
export function subjectFinding(
  check: string,
  logicalId: string,
  label: string,
  kind: string,
  message?: string,
): Finding {
  return makeFinding(check, kind, message ?? `${label}: ${kind}`, {
    logicalId,
    recordName: label,
  });
}

/** `result` with `findings` attached when there are any (a pass carries none). */
export function withFindings(
  result: CheckResult,
  findings: readonly Finding[],
): CheckResult {
  return findings.length > 0 ? { ...result, findings: [...findings] } : result;
}

/**
 * Whether `body` is the ServiceNow REST error envelope —
 * `{ "error": { "message": "…" }, … }` with a non-empty message. A reverse
 * proxy, a load balancer or a wrong base path answers with HTML, plain text or
 * nothing, which the client keeps as `{ raw }` or `undefined` (RR-39).
 */
function isSnErrorEnvelope(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() !== "";
}

/**
 * Whether a failed read means the table (or API) does not exist on the
 * instance — HTTP 404, or the Table API's HTTP 400 "Invalid table" — as
 * opposed to a read that exists but failed. A missing table is almost always
 * a plugin that is not installed, so there is nothing to verify.
 *
 * RR-39: only an answer from ServiceNow itself counts — the body must be its
 * JSON error envelope. A 404 from a proxy, a gateway or a wrong instance path
 * (HTML, plain text or an empty body) proves nothing about the table and stays
 * an `error` row.
 */
export function isMissingTable(err: unknown): err is SnHttpError {
  if (!(err instanceof SnHttpError)) return false;
  if (!isSnErrorEnvelope(err.body)) return false;
  if (err.status === 404) return true;
  return err.status === 400 && /invalid table/i.test(err.message);
}

/**
 * The skip verdict for a read whose table does not exist (see
 * {@link isMissingTable}): `warn` with a plain reason, never `error` — a plugin
 * that is not installed is not a read failure (RR-3 follow-up). Every other
 * HTTP, auth or network failure stays `error`.
 */
export function missingTableResult(
  name: string,
  subject: string,
  err: SnHttpError,
): CheckResult {
  return {
    name,
    status: "warn",
    message: `Skipped ${subject}: a table it reads was not found (HTTP ${err.status}) — the plugin that provides it is likely not installed. ${err.message}`,
  };
}

/**
 * Map a thrown error to the shared certification-check verdict. A failed read
 * — an auth failure (401/403), any other HTTP 4xx/5xx or a network error — is
 * `error`: the check verified nothing, so the run fails, the row is counted in
 * its own bucket and no baseline or severity policy can demote it (OD-12). A
 * missing table is the exception — see {@link missingTableResult}.
 * Anything else — including an {@link EncodedQueryError} from the
 * injection-safe query builders — fails closed as `fail`. `subject` names
 * what was being inspected so the message stays actionable per check.
 */
export function errorResult(
  name: string,
  subject: string,
  err: unknown,
): CheckResult {
  const result = (status: CheckStatus, message: string): CheckResult => ({
    name,
    status,
    message,
  });
  if (err instanceof SnAuthError) {
    return result(
      "error",
      `Authentication failed while checking ${subject}${err.status ? ` (${err.status})` : ""}: ${err.message}`,
    );
  }
  if (err instanceof SnNetworkError) {
    return result(
      "error",
      `Could not reach the instance to check ${subject}: ${err.message}`,
    );
  }
  if (isMissingTable(err)) return missingTableResult(name, subject, err);
  if (err instanceof SnHttpError) {
    return result(
      "error",
      `Could not read the tables behind ${subject} (HTTP ${err.status}): ${err.message}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return result(
    "fail",
    `Unexpected error while checking ${subject}: ${message}`,
  );
}

/**
 * The operation an ACL row gates, lowercased. `operation` references
 * `sys_security_operation`: out-of-box records carry readable sys_ids
 * (`read`, `write`, …), but a custom or plugin operation's reference value can
 * be a GUID, so the dot-walked `operation.name` is preferred whenever the read
 * requested and returned it (ACL-6). Comparing the raw reference alone would
 * make a GUID-valued write ACL look like no known operation. The final form of
 * this mapping is pending a live read of `sys_security_operation` (audit
 * 2026-11-12 §4 query 4); until then an unrecognised value is never treated as
 * a harmless read.
 */
export function aclOperation(row: Record<string, unknown>): string {
  return (str(row, "operation.name") || str(row, "operation")).toLowerCase();
}

/**
 * The `sysparm_fields` an ACL read must carry for {@link aclInScope} to tell
 * an ACL the app ships from one that only lives in another scope (ACL-2).
 */
export const ACL_SCOPE_FIELDS = "sys_scope,sys_scope.scope";

/**
 * Whether an ACL row belongs to the target scope — i.e. ships with the app.
 * A row matches when its `sys_scope` reference equals the resolved scope
 * sys_id (or the configured input), or its dot-walked `sys_scope.scope` equals
 * the scope name (or the input). A row whose scope could not be read at all is
 * NOT in scope: an ACL that cannot be shown to ship never clears a gate.
 */
export function aclInScope(
  row: Record<string, unknown>,
  scope: ResolvedScope,
): boolean {
  const id = str(row, "sys_scope");
  const name = str(row, "sys_scope.scope").toLowerCase();
  const ids = [scope.sysId, scope.input].filter((v): v is string => !!v);
  const names = [scope.name, scope.input]
    .filter((v): v is string => !!v)
    .map((v) => v.toLowerCase());
  return (
    (id !== "" && ids.includes(id)) || (name !== "" && names.includes(name))
  );
}

/**
 * The ACLs of one `type` gating one `operation` whose `name` is among
 * `candidateNames`, fetched in batches. `names` holds every matching ACTIVE
 * ACL's lowercased name that ships in `scope`; `foreignNames` the active ones
 * that exist only in another scope (a global ACL made on the dev instance
 * does not travel with the app, so it gates nothing on the target — ACL-2);
 * `inactiveNames` the ones that exist but are switched off (an off gate is no
 * gate); `trimmed` is true when any batch was security-trimmed
 * (`sys_security_acl` is admin-read out-of-box, so a partially readable ACL
 * table must never clear a gate). Names are matched exactly
 * (case-insensitive); every one is charset-validated by `inClause`.
 */
export async function fetchNamedAcls(
  http: SnClient,
  type: string,
  operation: string,
  candidateNames: readonly string[],
  scope: ResolvedScope,
): Promise<{
  names: Set<string>;
  foreignNames: Set<string>;
  inactiveNames: Set<string>;
  trimmed: boolean;
}> {
  const names = new Set<string>();
  const foreignNames = new Set<string>();
  const inactiveNames = new Set<string>();
  let trimmed = false;
  for (const batch of chunk(candidateNames)) {
    // No `sysparm_limit`: the client auto-paginates, so every matching ACL in
    // the batch is seen (a cap could hide the one ACL that gates an artifact).
    const { rows, securityTrimmed } = await http
      .table("sys_security_acl")
      .queryWithMeta({
        sysparm_query: and(eq("type", type), inClause("name", batch)),
        sysparm_fields: `sys_id,name,operation,operation.name,active,${ACL_SCOPE_FIELDS}`,
      });
    trimmed = trimmed || securityTrimmed;
    for (const row of rows) {
      const name = str(row, "name").toLowerCase();
      if (name === "" || aclOperation(row) !== operation) continue;
      if (!isTruthy(row, "active")) inactiveNames.add(name);
      else if (aclInScope(row, scope)) names.add(name);
      else foreignNames.add(name);
    }
  }
  return { names, foreignNames, inactiveNames, trimmed };
}

/** A role that grants everyone: an ACL gated only by it is not gated (ACL-3). */
export const PUBLIC_ROLE = "public";

/**
 * Whether an ACL script actually decides anything. Comments and whitespace are
 * stripped first, so a script that is only `// TODO` is no script; a script
 * that only ever answers true (`answer = true;`, `true`, `answer = !0;`, …)
 * gates nothing either (ACL-3).
 */
export function scriptGates(script: string): boolean {
  const code = script
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "")
    .replace(/;+$/, "");
  if (code === "") return false;
  return !/^(answer=)?\(*(true|!0|!false|!!1|1==1|1===1)\)*$/.test(code);
}

/**
 * Whether an ACL condition actually filters anything: an encoded query that
 * is empty once the `^EQ` terminator and whitespace are removed matches every
 * record, so it gates nothing (ACL-3).
 */
export function conditionGates(condition: string): boolean {
  return condition.replace(/\^EQ$/, "").replace(/\s+/g, "") !== "";
}

/**
 * Batch-fetch the ACL→role links (`sys_security_acl_role` m2m) for every ACL in
 * one go, grouped by ACL sys_id. Replaces the per-ACL N+1 read (SN-6): the ids
 * are packed into `sys_security_aclIN…` clauses of at most `IN_CHUNK_SIZE`, so N
 * ACLs cost `⌈N / IN_CHUNK_SIZE⌉` queries instead of N. Every id is charset-
 * validated by {@link inClause}, so the batched query cannot be injected into.
 *
 * Read with `queryWithMeta`: `trimmed` is true when any batch was
 * security-trimmed. An unreadable m2m would otherwise make every role-gated ACL
 * look role-less — and fail as "public access", the wrong diagnosis (ACL-8).
 */
export async function fetchAclRolesByAcl(
  http: SnClient,
  aclSysIds: readonly string[],
): Promise<{
  byAcl: Map<string, Record<string, unknown>[]>;
  trimmed: boolean;
}> {
  const byAcl = new Map<string, Record<string, unknown>[]>();
  for (const id of aclSysIds) byAcl.set(id, []);
  let trimmed = false;
  for (const ids of chunk(aclSysIds)) {
    // No `sysparm_limit`: the client auto-paginates so an ACL gated by more
    // roles than a single page is never seen as ungated through truncation.
    const { rows, securityTrimmed } = await http
      .table("sys_security_acl_role")
      .queryWithMeta({
        sysparm_query: inClause("sys_security_acl", ids),
        sysparm_fields: "sys_security_acl,sys_user_role,sys_user_role.name",
      });
    trimmed = trimmed || securityTrimmed;
    for (const row of rows) {
      const list = byAcl.get(str(row, "sys_security_acl"));
      if (list) list.push(row);
    }
  }
  return { byAcl, trimmed };
}
