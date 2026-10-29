import type {
  Check,
  CheckResult,
  CheckStatus,
  Finding,
  PreflightContext,
} from "../types.js";
import type { TableQueryResult } from "../http/client.js";
import { resolveScope } from "../http/query.js";
import {
  errorResult,
  rowFinding,
  str,
  triageZeroRead,
  withFindings,
} from "./cert-common.js";

const NAME = "connection-credentials";
const CREDENTIALS = "discovery_credentials";
const REST_MESSAGE = "sys_rest_message";
const REST_FUNCTION = "sys_rest_message_fn";
const ALIAS = "sys_alias";

/**
 * Columns each read asks for. Credential secrets (`password`, `user_name`,
 * `api_key`, …) are never requested, so they never cross the wire.
 */
const FIELDS = {
  [CREDENTIALS]: "sys_id,name,sys_class_name",
  [REST_MESSAGE]:
    "sys_id,name,rest_endpoint,authentication_type,basic_auth_profile,use_mid_server",
  [REST_FUNCTION]:
    "sys_id,rest_message,function_name,rest_endpoint,authentication_type",
  [ALIAS]: "sys_id,name,type",
} as const;

type Table = keyof typeof FIELDS;

const RANK: Record<CheckStatus, number> = { pass: 0, warn: 1, fail: 2 };

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** The worse of two statuses. */
function worst(a: CheckStatus, b: CheckStatus): CheckStatus {
  return RANK[b] > RANK[a] ? b : a;
}

/** A read that could not prove its table: the verdict it forces and why. */
interface BlindSpot {
  status: CheckStatus;
  note: string;
}

/** One table's read: visible rows, or the reason it could not be trusted. */
interface Read {
  rows: Record<string, unknown>[];
  blind?: BlindSpot;
}

/**
 * Read one table in scope. Each read is independent: an error or a
 * trimmed/ambiguous zero-row read becomes a blind spot rather than aborting the
 * other reads. A trimmed read on `trimmedStatus`'s table forces that status
 * (fail for credential records, warn for the REST and alias reads).
 */
async function read(
  ctx: PreflightContext,
  clause: string,
  scope: string,
  table: Table,
  trimmedStatus: CheckStatus,
): Promise<Read> {
  let meta: TableQueryResult;
  try {
    // No `sysparm_limit`: auto-pagination inspects every row in the scope.
    meta = await ctx.http
      .table(table)
      .queryWithMeta({ sysparm_query: clause, sysparm_fields: FIELDS[table] });
  } catch (err) {
    const mapped = errorResult(NAME, `${table} in scope "${scope}"`, err);
    return {
      rows: [],
      blind: { status: mapped.status, note: mapped.message.replace(/\.$/, "") },
    };
  }
  if (meta.rows.length === 0) {
    switch (triageZeroRead(meta)) {
      case "trimmed":
        return {
          rows: [],
          blind: {
            status: trimmedStatus,
            note: `${table}: ${meta.totalCount ?? "some"} match in scope "${scope}" but 0 are visible (security-trimmed)`,
          },
        };
      case "ambiguous":
        return {
          rows: [],
          blind: {
            status: "warn",
            note: `${table}: none visible in scope "${scope}" and no pre-trim count arrived — the app may ship none, or the account cannot read it`,
          },
        };
      case "empty":
        return { rows: [] };
    }
  }
  if (meta.securityTrimmed) {
    return {
      rows: meta.rows,
      blind: {
        status: trimmedStatus,
        note: `${table}: the read was security-trimmed, so some rows were not inspected`,
      },
    };
  }
  return { rows: meta.rows };
}

/** A literal `http(s)://…` endpoint rather than a `${…}` alias placeholder. */
function hardCoded(row: Record<string, unknown>): boolean {
  const endpoint = str(row, "rest_endpoint");
  return endpoint.toLowerCase().startsWith("http") && !endpoint.includes("${");
}

/** `<name> (<sys_class_name>)` — a record name and class, never a value. */
function credentialLabel(row: Record<string, unknown>): string {
  const name = str(row, "name") || str(row, "sys_id") || "(unnamed)";
  const cls = str(row, "sys_class_name");
  return cls ? `${name} (${cls})` : name;
}

/**
 * Certification rule 1.7 (`ci/certification/CHECKLIST.md`): an app must not
 * ship credentials or hard-wire its outbound endpoints — integrations go
 * through Connection & Credential aliases, so each customer supplies their own
 * connection and secret.
 *
 * Three independent reads in the target scope:
 *
 * 1. `discovery_credentials` (children such as `basic_auth_credentials` and
 *    `api_key_credentials` extend it) — any in-scope row **fails**.
 * 2. `sys_rest_message` and `sys_rest_message_fn` — a literal `http…`
 *    endpoint without a `${…}` placeholder **warns**.
 * 3. `sys_alias` — informational; the count goes into the pass message.
 *
 * Only `sys_id`, names and classes are requested: credential values are never
 * read, and endpoint URLs are never echoed. A trimmed credential read fails;
 * any other trimmed or ambiguous read warns; errors map per read (auth fails,
 * network / HTTP warn).
 */
export const connectionCredentials: Check = {
  name: NAME,
  description:
    "No credential records ship in the app and REST messages use Connection & Credential aliases instead of hard-coded endpoints.",
  meta: {
    requires: "scope",
    summary:
      "No credential records ship in the scope; REST messages and functions reach their endpoints through Connection & Credential aliases rather than a hard-coded URL.",
    rule: "1.7",
    severity: "blocker",
    tables: [CREDENTIALS, REST_MESSAGE, REST_FUNCTION, ALIAS],
    remediation:
      "Remove credential records from the app (each customer creates their own), and point REST messages at a Connection & Credential alias instead of a literal endpoint.",
    verdicts: {
      pass: "No credential records and no hard-coded REST endpoints in scope.",
      warn: "A REST message or function uses a hard-coded endpoint, the scope is unset, or a REST/alias read was trimmed, ambiguous or unreachable.",
      fail: "A credential record ships in the app, the credential read was security-trimmed, or authentication failed.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the connection & credential check (pass a scope to enable it).",
      );
    }

    try {
      const { clause } = await resolveScope(ctx, scope);
      const creds = await read(ctx, clause, scope, CREDENTIALS, "fail");
      const messages = await read(ctx, clause, scope, REST_MESSAGE, "warn");
      const fns = await read(ctx, clause, scope, REST_FUNCTION, "warn");
      const aliases = await read(ctx, clause, scope, ALIAS, "warn");

      let status: CheckStatus = "pass";
      const parts: string[] = [];
      const findings: Finding[] = [];

      if (creds.rows.length > 0) {
        status = "fail";
        const labels = creds.rows.map(credentialLabel);
        parts.push(
          `${labels.length} credential record(s) ship in the app: ${labels.join(", ")}.`,
        );
        for (const row of creds.rows) {
          findings.push(
            rowFinding(
              NAME,
              CREDENTIALS,
              row,
              "credential-record",
              credentialLabel,
            ),
          );
        }
      }

      const messageNames = new Map<string, string>();
      for (const row of messages.rows) {
        const id = str(row, "sys_id");
        if (id) messageNames.set(id, str(row, "name") || id);
      }
      const fnLabel = (row: Record<string, unknown>): string => {
        const fn = str(row, "function_name") || str(row, "sys_id");
        const parentId = str(row, "rest_message");
        const parent = messageNames.get(parentId) ?? parentId;
        return parent ? `${parent} (${fn || "(unnamed)"})` : fn || "(unnamed)";
      };
      const messageLabel = (row: Record<string, unknown>): string =>
        str(row, "name") || str(row, "sys_id") || "(unnamed)";

      const endpoints: string[] = [];
      for (const [table, rows, label] of [
        [REST_MESSAGE, messages.rows, messageLabel],
        [REST_FUNCTION, fns.rows, fnLabel],
      ] as const) {
        for (const row of rows) {
          if (!hardCoded(row)) continue;
          endpoints.push(label(row));
          const finding = rowFinding(
            NAME,
            table,
            row,
            "hard-coded-endpoint",
            label,
          );
          finding.status = "warn";
          findings.push(finding);
        }
      }
      if (endpoints.length > 0) {
        status = worst(status, "warn");
        parts.push(
          `${endpoints.length} REST message/function(s) use a hard-coded endpoint instead of a Connection & Credential alias: ${endpoints.join(", ")}.`,
        );
      }

      const blind: string[] = [];
      for (const r of [creds, messages, fns, aliases]) {
        if (!r.blind) continue;
        status = worst(status, r.blind.status);
        blind.push(r.blind.note);
      }

      if (status === "pass") {
        const aliasNote =
          aliases.rows.length > 0
            ? ` ${aliases.rows.length} connection alias(es) in scope.`
            : "";
        return result(
          "pass",
          `No credential records and no hard-coded REST endpoints in scope.${aliasNote}`,
        );
      }

      if (parts.length === 0) {
        return result(
          status,
          `Cannot fully confirm connections and credentials in scope "${scope}": ${blind.join("; ")}.`,
        );
      }
      return withFindings(
        result(
          status,
          parts.join(" ") +
            (blind.length > 0
              ? ` (Not fully inspected: ${blind.join("; ")}.)`
              : ""),
        ),
        findings,
      );
    } catch (err) {
      return errorResult(NAME, "connections and credentials", err);
    }
  },
};
