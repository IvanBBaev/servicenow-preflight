import type {
  Check,
  CheckResult,
  CheckStatus,
  Finding,
  PreflightContext,
} from "../types.js";
import type { SnClient, TableQueryResult } from "../http/client.js";
import {
  and,
  chunk,
  inClause,
  isSafeIdentifier,
  resolveScope,
} from "../http/query.js";
import {
  errorResult,
  rowFinding,
  str,
  triageZeroRead,
  withFindings,
} from "./cert-common.js";

const NAME = "connection-credentials";
const CLASSES = "sys_db_object";
const METADATA = "sys_metadata";
const METADATA_LINK = "sys_metadata_link";
const REST_MESSAGE = "sys_rest_message";
const REST_FUNCTION = "sys_rest_message_fn";
const ALIAS = "sys_alias";

/**
 * The credential-bearing root classes and the verdict a shipped record of any
 * class in their tree forces. Credentials (`basic_auth_credentials`,
 * `api_key_credentials`, … extend `discovery_credentials`), OAuth providers
 * (`oauth_entity` carries the client secret) and basic-auth profiles hold a
 * secret: **fail**. An OAuth 2.0 profile only points at a provider and its
 * scopes, so shipping one **warns** (ACL-13).
 */
const CREDENTIAL_ROOTS: Readonly<Record<string, CheckStatus>> = {
  discovery_credentials: "fail",
  oauth_entity: "fail",
  sys_auth_profile_basic: "fail",
  sys_auth_profile_oauth2: "warn",
};

/** Deepest class tree under a credential root that the walk follows. */
const MAX_CLASS_DEPTH = 10;

/**
 * Columns each read asks for. Credential secrets (`password`, `user_name`,
 * `api_key`, `client_secret`, …) and the metadata `payload` are never
 * requested, so they never cross the wire.
 */
const FIELDS = {
  [METADATA]: "sys_id,sys_name,sys_class_name",
  [METADATA_LINK]: "sys_id,sys_name,tablename,documentkey",
  [REST_MESSAGE]:
    "sys_id,name,rest_endpoint,authentication_type,basic_auth_profile,use_mid_server",
  [REST_FUNCTION]:
    "sys_id,rest_message,function_name,rest_endpoint,authentication_type",
  [ALIAS]: "sys_id,name,type",
} as const;

type Table = keyof typeof FIELDS;

const RANK: Record<CheckStatus, number> = {
  pass: 0,
  warn: 1,
  fail: 2,
  // A read that failed outranks a finding: the row must stay undemotable.
  error: 3,
};

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

/**
 * {@link read} over `values` in IN-clause chunks of `field`: the rows of every
 * chunk, and the worst blind spot any chunk left.
 */
async function readIn(
  ctx: PreflightContext,
  clause: string,
  scope: string,
  table: Table,
  field: string,
  values: readonly string[],
): Promise<Read> {
  const rows: Record<string, unknown>[] = [];
  let blind: BlindSpot | undefined;
  for (const batch of chunk(values)) {
    const r = await read(
      ctx,
      and(clause, inClause(field, batch)),
      scope,
      table,
      "fail",
    );
    rows.push(...r.rows);
    if (r.blind && (!blind || RANK[r.blind.status] > RANK[blind.status])) {
      blind = r.blind;
    }
  }
  return blind ? { rows, blind } : { rows };
}

/** Every class in the credential trees, mapped to its root (lower-cased). */
interface CredentialClasses {
  roots: Map<string, string>;
  blind?: BlindSpot;
}

/**
 * Walk `sys_db_object` down from {@link CREDENTIAL_ROOTS} along `super_class`,
 * so a record of any extending class (`basic_auth_credentials`, a custom
 * credential type) is recognised. A trimmed class read, or a tree deeper than
 * {@link MAX_CLASS_DEPTH}, leaves classes unproven: a **fail** blind spot. The
 * roots themselves always count, whether or not their row is visible.
 */
async function credentialClasses(http: SnClient): Promise<CredentialClasses> {
  const roots = new Map<string, string>(
    Object.keys(CREDENTIAL_ROOTS).map((name) => [name, name]),
  );
  const rootOfId = new Map<string, string>();
  try {
    const top = await http.table(CLASSES).queryWithMeta({
      sysparm_query: inClause("name", Object.keys(CREDENTIAL_ROOTS)),
      sysparm_fields: "sys_id,name",
    });
    let trimmed = top.securityTrimmed;
    for (const row of top.rows) {
      const id = str(row, "sys_id");
      const name = str(row, "name").toLowerCase();
      if (id !== "" && roots.has(name)) rootOfId.set(id, name);
    }
    let frontier = [...rootOfId.keys()];
    for (let depth = 0; frontier.length > 0; depth++) {
      if (depth >= MAX_CLASS_DEPTH) {
        return {
          roots,
          blind: {
            status: "fail",
            note: `${CLASSES}: the credential class tree is deeper than ${MAX_CLASS_DEPTH} levels, so some credential classes were not inspected`,
          },
        };
      }
      const next: string[] = [];
      for (const ids of chunk(frontier.filter((id) => isSafeIdentifier(id)))) {
        // No `sysparm_limit`: the client auto-paginates.
        const page = await http.table(CLASSES).queryWithMeta({
          sysparm_query: inClause("super_class", ids),
          sysparm_fields: "sys_id,name,super_class",
        });
        trimmed = trimmed || page.securityTrimmed;
        for (const row of page.rows) {
          const id = str(row, "sys_id");
          const name = str(row, "name").toLowerCase();
          const root = rootOfId.get(str(row, "super_class"));
          if (id === "" || rootOfId.has(id) || !root) continue;
          rootOfId.set(id, root);
          if (name !== "" && isSafeIdentifier(name)) roots.set(name, root);
          next.push(id);
        }
      }
      frontier = next;
    }
    if (trimmed) {
      return {
        roots,
        blind: {
          status: "fail",
          note: `${CLASSES}: the credential class read was security-trimmed, so some credential classes were not inspected`,
        },
      };
    }
  } catch (err) {
    const mapped = errorResult(
      NAME,
      `the credential classes (${CLASSES})`,
      err,
    );
    return {
      roots,
      blind: { status: mapped.status, note: mapped.message.replace(/\.$/, "") },
    };
  }
  return { roots };
}

/**
 * A literal endpoint: an `http(s)` scheme whose host part carries no `${…}`
 * placeholder. A placeholder after the host (`https://api.vendor.example/${path}`)
 * still hard-wires the vendor host, so it counts (ACL-12).
 */
function hardCoded(row: Record<string, unknown>): boolean {
  const match = /^https?:(?:\/\/)?([^/?#]*)/i.exec(str(row, "rest_endpoint"));
  return match !== null && !(match[1] ?? "").includes("${");
}

/** `<name> (<class>)` — a record name and class, never a value. */
function credentialLabel(row: Record<string, unknown>): string {
  const name =
    str(row, "sys_name") ||
    str(row, "documentkey") ||
    str(row, "sys_id") ||
    "(unnamed)";
  const cls = str(row, "sys_class_name") || str(row, "tablename");
  return cls ? `${name} (${cls})` : name;
}

/**
 * Certification rule 1.7 (`ci/certification/CHECKLIST.md`): an app must not
 * ship credentials or hard-wire its outbound endpoints — integrations go
 * through Connection & Credential aliases, so each customer supplies their own
 * connection and secret.
 *
 * Independent reads in the target scope:
 *
 * 1. What ships: credential tables carry no proven `sys_scope` column, so a
 *    scope clause on them is no evidence (ACL-5). Instead the app's own
 *    application files are read — `sys_metadata` rows whose class is in a
 *    credential tree ({@link CREDENTIAL_ROOTS}, walked down `sys_db_object`)
 *    and `sys_metadata_link` rows (a data record added to the app) for those
 *    tables. A credential, OAuth provider or basic-auth profile **fails**; an
 *    OAuth 2.0 profile **warns**.
 * 2. `sys_rest_message` and `sys_rest_message_fn` — an `http(s)` endpoint
 *    whose host is literal **warns**.
 * 3. `sys_alias` — informational; the count goes into the pass message.
 *
 * Only `sys_id`, names and classes are requested: credential values and link
 * payloads are never read, and endpoint URLs are never echoed. A trimmed
 * credential or class read fails;
 * any other trimmed or ambiguous read warns; a failed read (auth, HTTP,
 * network) makes the row `error`, which outranks every other verdict.
 */
export const connectionCredentials: Check = {
  name: NAME,
  description:
    "No credentials, OAuth providers or auth profiles ship in the app, and REST messages do not hard-code their endpoint host.",
  meta: {
    requires: "scope",
    summary:
      "No credential, OAuth provider or auth-profile record ships as an application file of the scope; REST messages and functions do not hard-code their endpoint host.",
    rule: "1.7",
    severity: "blocker",
    tables: [
      CLASSES,
      METADATA,
      METADATA_LINK,
      REST_MESSAGE,
      REST_FUNCTION,
      ALIAS,
    ],
    remediation:
      "Remove credential, OAuth provider and auth-profile records from the app (each customer creates their own). For a hard-coded endpoint, build the URL from a Connection & Credential alias at runtime (sn_cc.ConnectionInfoProvider in script, then setEndpoint) or call the API through an IntegrationHub / Flow Designer action that uses a connection alias.",
    verdicts: {
      pass: "No credential records and no hard-coded REST endpoints in scope.",
      warn: "An OAuth 2.0 profile ships, a REST message or function hard-codes its endpoint host, the scope is unset, or a read was trimmed or ambiguous.",
      fail: "A credential, OAuth provider or basic-auth profile ships in the app, or a credential or class read was security-trimmed.",
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
      const classes = await credentialClasses(ctx.http);
      const classNames = [...classes.roots.keys()];
      const files = await readIn(
        ctx,
        clause,
        scope,
        METADATA,
        "sys_class_name",
        classNames,
      );
      const links = await readIn(
        ctx,
        clause,
        scope,
        METADATA_LINK,
        "tablename",
        classNames,
      );
      const messages = await read(ctx, clause, scope, REST_MESSAGE, "warn");
      const fns = await read(ctx, clause, scope, REST_FUNCTION, "warn");
      const aliases = await read(ctx, clause, scope, ALIAS, "warn");

      let status: CheckStatus = "pass";
      const parts: string[] = [];
      const findings: Finding[] = [];

      const secrets: string[] = [];
      const profiles: string[] = [];
      const seen = new Set<string>();
      for (const [table, rows, classField] of [
        [METADATA, files.rows, "sys_class_name"],
        [METADATA_LINK, links.rows, "tablename"],
      ] as const) {
        for (const row of rows) {
          const root = classes.roots.get(str(row, classField).toLowerCase());
          if (!root) continue;
          // A record both in sys_metadata and linked counts once.
          const recordId =
            table === METADATA ? str(row, "sys_id") : str(row, "documentkey");
          if (recordId !== "" && seen.has(recordId)) continue;
          if (recordId !== "") seen.add(recordId);
          const verdict = CREDENTIAL_ROOTS[root] ?? "fail";
          const location =
            table === METADATA ? str(row, "sys_class_name") || METADATA : table;
          const finding = rowFinding(
            NAME,
            location,
            row,
            verdict === "fail" ? "credential-record" : "oauth2-profile",
            credentialLabel,
          );
          if (verdict === "fail") {
            secrets.push(credentialLabel(row));
          } else {
            profiles.push(credentialLabel(row));
            finding.status = "warn";
          }
          findings.push(finding);
        }
      }
      if (secrets.length > 0) {
        status = "fail";
        parts.push(
          `${secrets.length} credential record(s) ship in the app: ${secrets.join(", ")}.`,
        );
      }
      if (profiles.length > 0) {
        status = worst(status, "warn");
        parts.push(
          `${profiles.length} OAuth 2.0 profile(s) ship in the app — each customer should register their own: ${profiles.join(", ")}.`,
        );
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
          `${endpoints.length} REST message/function(s) hard-code their endpoint host instead of taking it from a Connection & Credential alias: ${endpoints.join(", ")}.`,
        );
      }

      const blind: string[] = [];
      for (const r of [classes, files, links, messages, fns, aliases]) {
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
