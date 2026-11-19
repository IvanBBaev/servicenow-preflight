/**
 * `snpf doctor` (F-X-15): one read-only report on whether this account and
 * transport can run the gate — config sources, reachability, authentication,
 * the basic-auth restriction, the account's exemptions, read access to every
 * table the selected checks query, the CI/CD API, and the runtime.
 *
 * Every row is an ordinary {@link Check}, so the report goes through
 * `runPreflight` and every reporter works unchanged. Rows only read: Table API
 * GETs (the access probe asks for one row and reads `X-Total-Count`) and one
 * GET on the CI/CD API.
 *
 * Rows fail closed (RR-53): the table-access row fails when a table a selected
 * check requires answers HTTP 403, or when read ACLs trim it (no row returned
 * although the instance counts matching rows); a probe it cannot interpret
 * (no rows and no count, a non-2xx, a malformed body) warns. The basic-auth
 * row warns unless it sees both restriction switches, and treats an
 * enforcement date that has passed as enforced. The CI/CD row passes only on an
 * expected status carrying a ServiceNow JSON body. A row that cannot read the
 * account's exemptions warns ("ask an admin to confirm").
 *
 * Unverified against a live instance (card Codability a–d): the basic-auth
 * property names, `sys_user.web_service_access_only`, a non-admin reading
 * `sys_user_has_role`, and how the CI/CD API answers an unknown progress id.
 */

import { lookup as dnsLookup } from "node:dns/promises";

import { connectivityAuth } from "./checks/connectivity-auth.js";
import {
  SnAuthError,
  SnError,
  SnHttpError,
  type SnClient,
  type SnRawResponse,
} from "./http/client.js";
import { ProxyConfigError, redactedProxy, resolveProxy } from "./http/proxy.js";
import { and, assertSysId, eq, eqUserName, inClause } from "./http/query.js";
import type { Check, CheckResult, PreflightContext } from "./types.js";

/** Where the instance URL came from. */
export type InstanceSource = "flag" | "registry" | "config" | "env";

/** Inputs for {@link doctorChecks}. */
export interface DoctorOptions {
  /** The checks a run would select; their `meta.tables` form the access probe. */
  selected: readonly Check[];
  /** Package version, reported by the runtime row. */
  version: string;
  /** Where the instance URL came from (absent when none was resolved). */
  instanceSource?: InstanceSource;
  /** The config file that was loaded, if any. */
  configPath?: string;
  /** Registry instance name, when the target came from the registry. */
  instance?: string;
  /** Credential env namespace (`DEV` → `SNPF_DEV_*` before `SNPF_*`). */
  envPrefix?: string;
  /** Explicit proxy settings (config file / `SNPF_PROXY`). */
  proxy?: string;
  noProxy?: string;
  /** Environment for proxy resolution (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Host name resolver (default `dns.lookup`); for tests. */
  lookup?: (host: string) => Promise<unknown>;
  /** Node version (default `process.versions.node`); for tests. */
  nodeVersion?: string;
  /** The current instant, for the enforcement-date comparison; for tests. */
  now?: () => Date;
}

/** The role that exempts a basic-auth account from the API restriction. */
export const BASIC_AUTH_ROLE = "snc_basic_auth_api_access";

/** Basic-auth restriction properties (names unverified, see the module doc). */
export const BASIC_AUTH_PROPERTIES = {
  active: "glide.authenticate.basic_auth.restriction.active",
  enforce: "glide.authenticate.basic_auth.restriction.enforce",
  enforcementDate: "glide.authenticate.basic_auth.restriction.enforcement_date",
} as const;

/** A progress id no CI/CD run has; the probe only needs the API to answer. */
const CICD_PROBE = "/api/sn_cicd/progress/00000000000000000000000000000000";

/** DNS lookups give up after this long. */
const LOOKUP_TIMEOUT_MS = 5000;

const OAUTH_ADVICE =
  "Move the CI account to OAuth (SNPF_AUTH=oauth-client) or mutual TLS, which the restriction does not cover.";

const NAMES = {
  config: "doctor-config",
  reachability: "doctor-reachability",
  basicAuth: "doctor-basic-auth",
  account: "doctor-account",
  tables: "doctor-table-access",
  cicd: "doctor-cicd",
  runtime: "doctor-runtime",
} as const;

/** What the account lookup found; `undefined` fields could not be read. */
interface AccountFacts {
  /** The auth kind carries no user name (token, API key, OAuth client, mTLS). */
  noUser?: string;
  /** Why the facts could not be read (a sentence). */
  unreadable?: string;
  userName?: string;
  webServiceOnly?: boolean;
  hasRole?: boolean;
}

/**
 * The doctor's rows, in report order. `connectivity-auth` is reused as the
 * authentication row. The account lookup is shared by the basic-auth and
 * account rows and made once.
 */
export function doctorChecks(opts: DoctorOptions): Check[] {
  let facts: Promise<AccountFacts> | undefined;
  const accountFacts = (ctx: PreflightContext): Promise<AccountFacts> => {
    facts ??= readAccountFacts(ctx);
    return facts;
  };
  return [
    configRow(opts),
    reachabilityRow(opts),
    authRow,
    basicAuthRow(accountFacts, opts.now ?? (() => new Date())),
    accountRow(accountFacts),
    tableAccessRow(opts.selected),
    cicdRow(opts.selected),
    runtimeRow(opts),
  ];
}

/** `connectivity-auth`, skipped (warn) when there is no instance to ask. */
const authRow: Check = {
  ...connectivityAuth,
  run(ctx) {
    if (!ctx.instanceUrl) return noInstance(connectivityAuth.name);
    return connectivityAuth.run(ctx);
  },
};

/** The union of `meta.tables` over `checks`, each with the checks reading it. */
export function tablesOf(checks: readonly Check[]): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const check of checks) {
    for (const table of check.meta?.tables ?? []) {
      const readers = tables.get(table) ?? [];
      readers.push(check.name);
      tables.set(table, readers);
    }
  }
  return new Map([...tables].sort(([a], [b]) => a.localeCompare(b)));
}

function row(
  name: string,
  status: CheckResult["status"],
  message: string,
): CheckResult {
  return { name, status, message };
}

function noInstance(name: string): CheckResult {
  return row(
    name,
    "warn",
    "Skipped: no instance URL. Pass --instance <url>, set SNPF_INSTANCE, or name a registry instance.",
  );
}

const SOURCE_LABEL: Record<InstanceSource, string> = {
  flag: "--instance",
  registry: "the registry",
  config: "the config file",
  env: "SNPF_INSTANCE",
};

function configRow(opts: DoctorOptions): Check {
  return {
    name: NAMES.config,
    description:
      "Where the instance URL, config file and credentials come from.",
    meta: { severity: "blocker", requires: "ALWAYS" },
    run(ctx) {
      const prefix = opts.envPrefix
        ? `SNPF_${opts.envPrefix}_* then SNPF_*`
        : "SNPF_*";
      const credentials = ctx.auth
        ? `${ctx.auth.kind} credentials from the environment (${prefix})`
        : `no header credentials in the environment (${prefix})`;
      const parts = [
        opts.instance ? `registry instance "${opts.instance}"` : undefined,
        opts.configPath
          ? `config file ${opts.configPath}`
          : "no config file (defaults apply)",
        credentials,
        ctx.tls ? "a client certificate (mTLS)" : undefined,
      ].filter((p): p is string => p !== undefined);
      if (!ctx.instanceUrl) {
        return row(
          NAMES.config,
          "fail",
          `No instance URL: pass --instance <url>, set SNPF_INSTANCE, set "instanceUrl" in the config file, or name a registry instance. Found ${parts.join("; ")}.`,
        );
      }
      const source = opts.instanceSource
        ? ` from ${SOURCE_LABEL[opts.instanceSource]}`
        : "";
      return row(
        NAMES.config,
        "pass",
        `Instance ${origin(ctx.instanceUrl)}${source}; ${parts.join("; ")}.`,
      );
    },
  };
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function reachabilityRow(opts: DoctorOptions): Check {
  return {
    name: NAMES.reachability,
    description: "The instance host resolves and the proxy settings are valid.",
    meta: { severity: "blocker", requires: "ALWAYS" },
    async run(ctx) {
      if (!ctx.instanceUrl) return noInstance(NAMES.reachability);
      let target: URL;
      try {
        target = new URL(ctx.instanceUrl);
      } catch {
        return row(
          NAMES.reachability,
          "fail",
          "The instance URL is not a valid URL; use https://<instance>.service-now.com.",
        );
      }
      let proxy: URL | undefined;
      try {
        proxy = resolveProxy(target, {
          ...(opts.proxy !== undefined ? { proxy: opts.proxy } : {}),
          ...(opts.noProxy !== undefined ? { noProxy: opts.noProxy } : {}),
          ...(opts.env !== undefined ? { env: opts.env } : {}),
        });
      } catch (err) {
        if (err instanceof ProxyConfigError) {
          return row(NAMES.reachability, "fail", err.message);
        }
        throw err;
      }
      // Through a proxy the proxy resolves the instance; check the proxy host.
      const host = (proxy ?? target).hostname.replace(/^\[|\]$/g, "");
      const via = proxy
        ? `via the proxy ${redactedProxy(proxy)}`
        : "direct connection (no proxy)";
      try {
        await withTimeout(
          (opts.lookup ?? dnsLookup)(host),
          LOOKUP_TIMEOUT_MS,
          `DNS lookup of ${host} timed out`,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return row(
          NAMES.reachability,
          "fail",
          `Cannot resolve ${host} (${detail}); ${via}. Check the instance URL, DNS and, behind a firewall, SNPF_PROXY or HTTPS_PROXY.`,
        );
      }
      if (target.protocol !== "https:") {
        return row(
          NAMES.reachability,
          "warn",
          `${host} resolves, but the instance URL is not https: credentials travel unencrypted and no proxy is used. Use https://.`,
        );
      }
      return row(
        NAMES.reachability,
        "pass",
        `${host} resolves; ${via}. TLS is verified by the connectivity-auth request.`,
      );
    },
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One short reason for a failed read, never a credential. */
function reason(err: unknown): string {
  if (err instanceof SnAuthError) {
    return err.status ? `HTTP ${err.status}` : "not authenticated";
  }
  if (err instanceof SnError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** An HTTP 403 (the client raises it as an auth error). */
function forbidden(err: unknown): boolean {
  return (
    (err instanceof SnAuthError || err instanceof SnHttpError) &&
    err.status === 403
  );
}

function truthy(value: unknown): boolean {
  return typeof value === "string"
    ? value.trim().toLowerCase() === "true"
    : value === true;
}

/** The value of a reference field (`{ value }`) or a plain string. */
function refValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = value.value;
    return typeof inner === "string" ? inner : "";
  }
  return "";
}

async function readAccountFacts(ctx: PreflightContext): Promise<AccountFacts> {
  const auth = ctx.auth;
  if (!auth || (auth.kind !== "basic" && auth.kind !== "oauth-password")) {
    return { noUser: auth ? auth.kind : ctx.tls ? "mtls" : "none" };
  }
  const userName = auth.user.trim();
  let userClause: string;
  try {
    // Built by the injection-safe builder: a name carrying `^`, `=` or `%`
    // never reaches sysparm_query (RR-40).
    userClause = eqUserName("user_name", userName);
  } catch {
    return {
      userName,
      unreadable:
        "the user name holds characters the lookup does not query with",
    };
  }
  let user: Record<string, unknown> | undefined;
  try {
    [user] = await ctx.http.table("sys_user").query({
      sysparm_query: userClause,
      sysparm_fields: "sys_id,user_name,web_service_access_only",
      sysparm_limit: "1",
    });
  } catch (err) {
    return { userName, unreadable: `cannot read sys_user (${reason(err)})` };
  }
  if (!user) {
    return {
      userName,
      unreadable: `sys_user shows no record for "${userName}" (ACL-trimmed or another user name)`,
    };
  }
  const facts: AccountFacts = {
    userName,
    webServiceOnly: truthy(user.web_service_access_only),
  };
  let sysId: string;
  try {
    sysId = assertSysId(refValue(user.sys_id));
  } catch {
    return { ...facts, unreadable: "sys_user returned no usable sys_id" };
  }
  try {
    const roles = await ctx.http.table("sys_user_has_role").query({
      sysparm_query: and(eq("user", sysId), eq("role.name", BASIC_AUTH_ROLE)),
      sysparm_fields: "sys_id",
      sysparm_limit: "1",
    });
    return { ...facts, hasRole: roles.length > 0 };
  } catch (err) {
    return {
      ...facts,
      unreadable: `cannot read sys_user_has_role (${reason(err)})`,
    };
  }
}

/** The exempt paths the account has, as a phrase; `undefined` when none. */
function exemption(facts: AccountFacts): string | undefined {
  const paths = [
    facts.webServiceOnly ? "is Web Service Access Only" : undefined,
    facts.hasRole ? `has ${BASIC_AUTH_ROLE}` : undefined,
  ].filter((p): p is string => p !== undefined);
  return paths.length > 0 ? paths.join(" and ") : undefined;
}

const GRANT_EXEMPTION = `Grant the account the ${BASIC_AUTH_ROLE} role or mark it Web Service Access Only, or ${OAUTH_ADVICE.charAt(0).toLowerCase()}${OAUTH_ADVICE.slice(1)}`;

/**
 * Whether a `YYYY-MM-DD…` enforcement date is today or earlier (UTC). An
 * unparseable date proves nothing and counts as not passed.
 */
function enforcementPassed(date: string | undefined, now: Date): boolean {
  const day = /^(\d{4}-\d{2}-\d{2})(?:$|[ T])/.exec(date ?? "")?.[1];
  if (day === undefined || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    return false;
  }
  return day <= now.toISOString().slice(0, 10);
}

function basicAuthRow(
  accountFacts: (ctx: PreflightContext) => Promise<AccountFacts>,
  now: () => Date,
): Check {
  return {
    name: NAMES.basicAuth,
    description:
      "The instance's basic-auth API restriction will keep accepting this account.",
    meta: {
      severity: "advisory",
      requires: "ALWAYS",
      tables: ["sys_properties"],
    },
    async run(ctx) {
      if (!ctx.instanceUrl) return noInstance(NAMES.basicAuth);
      if (ctx.auth?.kind !== "basic") {
        return row(
          NAMES.basicAuth,
          "pass",
          `Not using basic auth (${ctx.auth?.kind ?? (ctx.tls ? "mtls" : "none")}); the basic-auth restriction does not apply.`,
        );
      }
      let props: Map<string, string>;
      let trimmed: boolean;
      try {
        const res = await ctx.http.table("sys_properties").queryWithMeta({
          sysparm_query: inClause("name", Object.values(BASIC_AUTH_PROPERTIES)),
          sysparm_fields: "name,value",
        });
        props = new Map(
          res.rows.map((r) => [refValue(r.name), refValue(r.value)] as const),
        );
        trimmed = res.securityTrimmed;
      } catch (err) {
        return row(
          NAMES.basicAuth,
          "warn",
          `Cannot read sys_properties (${reason(err)}); ask an admin to confirm whether the basic-auth API restriction is active and when it is enforced. ${GRANT_EXEMPTION}`,
        );
      }
      const active = truthy(props.get(BASIC_AUTH_PROPERTIES.active));
      const enforce = truthy(props.get(BASIC_AUTH_PROPERTIES.enforce));
      const date = props.get(BASIC_AUTH_PROPERTIES.enforcementDate)?.trim();
      // RR-53 (ST-16): a passed enforcement date means enforced, whatever the
      // switches say.
      const passed = enforcementPassed(date, now());
      if (!active && !enforce && !passed) {
        // "Not active" needs proof: both switches visible and the read not
        // security-trimmed. An absent row is unknown, not false.
        const hidden = [
          BASIC_AUTH_PROPERTIES.active,
          BASIC_AUTH_PROPERTIES.enforce,
        ].filter((name) => !props.has(name));
        if (trimmed || hidden.length > 0) {
          const why = trimmed
            ? "read ACLs hide some sys_properties rows from this account"
            : `the account sees no ${hidden.join(" or ")} property`;
          return row(
            NAMES.basicAuth,
            "warn",
            `Cannot confirm whether the basic-auth API restriction is active: ${why}; ask an admin to confirm whether it is active and when it is enforced. ${GRANT_EXEMPTION}`,
          );
        }
        return row(
          NAMES.basicAuth,
          "pass",
          `The basic-auth API restriction is not active on this instance${date ? ` (enforcement date ${date})` : ""}.`,
        );
      }
      const state = enforce
        ? "is enforced"
        : passed
          ? `is enforced (the enforcement date ${date ?? ""} has passed)`
          : `is active and will be enforced${date ? ` on ${date}` : ""}`;
      const facts = await accountFacts(ctx);
      const exempt = exemption(facts);
      if (exempt) {
        return row(
          NAMES.basicAuth,
          "pass",
          `The basic-auth API restriction ${state}; the account ${exempt}, so it stays allowed.`,
        );
      }
      if (facts.unreadable) {
        return row(
          NAMES.basicAuth,
          "warn",
          `The basic-auth API restriction ${state}, and the account's exemption cannot be confirmed: ${facts.unreadable}; ask an admin to confirm. ${GRANT_EXEMPTION}`,
        );
      }
      return row(
        NAMES.basicAuth,
        "warn",
        `The basic-auth API restriction ${state}, and the account is neither Web Service Access Only nor has ${BASIC_AUTH_ROLE}: basic-auth API calls will be refused. ${GRANT_EXEMPTION}`,
      );
    },
  };
}

function accountRow(
  accountFacts: (ctx: PreflightContext) => Promise<AccountFacts>,
): Check {
  return {
    name: NAMES.account,
    description:
      "The account is exempt from the basic-auth API restriction (role or Web Service Access Only).",
    meta: {
      severity: "advisory",
      requires: "ALWAYS",
      tables: ["sys_user", "sys_user_has_role"],
    },
    async run(ctx) {
      if (!ctx.instanceUrl) return noInstance(NAMES.account);
      const facts = await accountFacts(ctx);
      if (facts.noUser !== undefined) {
        return row(
          NAMES.account,
          "pass",
          `Not applicable: ${facts.noUser} authentication names no user to look up.`,
        );
      }
      const who = `"${facts.userName ?? ""}"`;
      const exempt = exemption(facts);
      if (exempt) {
        return row(NAMES.account, "pass", `The account ${who} ${exempt}.`);
      }
      if (facts.unreadable) {
        return row(
          NAMES.account,
          "warn",
          `Cannot confirm the account ${who}: ${facts.unreadable}; ask an admin to confirm it has ${BASIC_AUTH_ROLE} or is Web Service Access Only.`,
        );
      }
      if (ctx.auth?.kind !== "basic") {
        return row(
          NAMES.account,
          "pass",
          `The account ${who} has no basic-auth exemption; not needed for ${ctx.auth?.kind ?? "this"} authentication.`,
        );
      }
      return row(
        NAMES.account,
        "warn",
        `The account ${who} is neither Web Service Access Only nor has ${BASIC_AUTH_ROLE}; once the basic-auth API restriction is enforced its calls will be refused. ${GRANT_EXEMPTION}`,
      );
    },
  };
}

/**
 * The tables some selected check needs: a table every reader lists in
 * `meta.optionalTables` (a plugin table that may be absent) is not one.
 */
function requiredTables(selected: readonly Check[]): Set<string> {
  const required = new Set<string>();
  for (const check of selected) {
    const optional = new Set(check.meta?.optionalTables ?? []);
    for (const table of check.meta?.tables ?? []) {
      if (!optional.has(table)) required.add(table);
    }
  }
  return required;
}

/** What one access probe proved about a table. */
type Probe =
  | { kind: "readable" }
  | { kind: "denied" }
  | { kind: "trimmed"; total: number }
  | { kind: "unconfirmed" }
  | { kind: "unreadable"; why: string };

function tableAccessRow(selected: readonly Check[]): Check {
  return {
    name: NAMES.tables,
    description: "The account can read every table the selected checks query.",
    meta: { severity: "blocker", requires: "ALWAYS" },
    async run(ctx) {
      if (!ctx.instanceUrl) return noInstance(NAMES.tables);
      const tables = tablesOf(selected);
      if (tables.size === 0) {
        return row(
          NAMES.tables,
          "pass",
          "The selected checks declare no tables to read.",
        );
      }
      const required = requiredTables(selected);
      const denied: string[] = [];
      const deniedOptional: string[] = [];
      const trimmed: string[] = [];
      const unconfirmed: string[] = [];
      const unreadable: string[] = [];
      await Promise.all(
        [...tables].map(async ([table, readers]) => {
          const probe = await probeTable(ctx.http, table);
          const line = `${table} (${readers.join(", ")})`;
          switch (probe.kind) {
            case "readable":
              return;
            case "denied":
              (required.has(table) ? denied : deniedOptional).push(line);
              return;
            case "trimmed":
              trimmed.push(
                `${table} (${readers.join(", ")}; ${probe.total} matching rows)`,
              );
              return;
            case "unconfirmed":
              unconfirmed.push(line);
              return;
            case "unreadable":
              unreadable.push(`${line}: ${probe.why}`);
              return;
          }
        }),
      );
      const fails = denied.length + trimmed.length;
      const warns =
        deniedOptional.length + unconfirmed.length + unreadable.length;
      if (fails === 0 && warns === 0) {
        return row(
          NAMES.tables,
          "pass",
          `The account reads all ${tables.size} tables the selected checks query.`,
        );
      }
      const parts: string[] = [];
      if (denied.length > 0) {
        parts.push(
          `Read access refused (HTTP 403) to ${denied.sort().join("; ")} — those checks cannot verify anything.`,
        );
      }
      if (trimmed.length > 0) {
        parts.push(
          `Read ACLs trim ${trimmed.sort().join("; ")}: the instance counts matching rows but returned none, so those checks would judge a trimmed view.`,
        );
      }
      if (deniedOptional.length > 0) {
        parts.push(
          `Read access refused (HTTP 403) to the optional tables ${deniedOptional.sort().join("; ")}.`,
        );
      }
      if (unconfirmed.length > 0) {
        parts.push(
          `${unconfirmed.sort().join("; ")} returned no rows and no X-Total-Count, so read access cannot be confirmed (empty, or trimmed by read ACLs); ask an admin to confirm.`,
        );
      }
      if (unreadable.length > 0) {
        parts.push(`Could not probe ${unreadable.sort().join("; ")}.`);
      }
      parts.push(
        "Grant the CI account read access (a role whose read ACLs cover these tables), or skip the affected checks with --skip.",
      );
      return row(NAMES.tables, fails > 0 ? "fail" : "warn", parts.join(" "));
    },
  };
}

/**
 * Read one row of `table` and its `X-Total-Count` (the match count before
 * read ACLs trim the rows). A raw request, because the table client's
 * count-aware read refuses a row limit.
 */
async function probeTable(http: SnClient, table: string): Promise<Probe> {
  let res: SnRawResponse;
  try {
    res = await http.request(
      "GET",
      `/api/now/table/${encodeURIComponent(table)}`,
      { query: { sysparm_limit: "1", sysparm_fields: "sys_id" } },
    );
  } catch (err) {
    return forbidden(err)
      ? { kind: "denied" }
      : { kind: "unreadable", why: reason(err) };
  }
  if (res.status === 403) return { kind: "denied" };
  if (res.status < 200 || res.status >= 300) {
    return { kind: "unreadable", why: `HTTP ${res.status}` };
  }
  const body = res.body;
  const result =
    body !== null && typeof body === "object" && "result" in body
      ? body.result
      : undefined;
  if (!Array.isArray(result)) {
    return {
      kind: "unreadable",
      why: `HTTP ${res.status} without a result array`,
    };
  }
  if (result.length > 0) return { kind: "readable" };
  const total = totalCount(res.headers);
  if (total === undefined) return { kind: "unconfirmed" };
  return total === 0 ? { kind: "readable" } : { kind: "trimmed", total };
}

/** `X-Total-Count` as a count, or `undefined` when absent or not digits. */
function totalCount(
  headers: Record<string, string> | undefined,
): number | undefined {
  const raw = headers?.["x-total-count"]?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

function cicdRow(selected: readonly Check[]): Check {
  return {
    name: NAMES.cicd,
    description: "The CI/CD API answers when atf-run is selected.",
    meta: { severity: "advisory", requires: "ALWAYS" },
    async run(ctx) {
      if (!selected.some((c) => c.name === "atf-run")) {
        return row(NAMES.cicd, "pass", "Not needed: atf-run is not selected.");
      }
      if (!ctx.instanceUrl) return noInstance(NAMES.cicd);
      const plugin =
        "Activate the CI/CD REST API (plugin com.glide.continuousdelivery) and grant the account sn_cicd.sys_ci_automation, or skip atf-run.";
      let status: number;
      let body: unknown;
      try {
        ({ status, body } = await ctx.http.request("GET", CICD_PROBE));
      } catch (err) {
        return row(
          NAMES.cicd,
          "warn",
          `Cannot reach the CI/CD API (${reason(err)}). ${plugin}`,
        );
      }
      if (status === 401 || status === 403) {
        return row(
          NAMES.cicd,
          "warn",
          `The CI/CD API refused the account (HTTP ${status}). ${plugin}`,
        );
      }
      // RR-53 (ST-17): only an expected status with a ServiceNow JSON body is
      // an answer; a login page, a redirect, a 429 or a gateway error is not.
      if (!CICD_ANSWER_STATUSES.has(status) || !cicdAnswered(body)) {
        return row(
          NAMES.cicd,
          "warn",
          `The CI/CD API did not answer (HTTP ${status}${isJsonObject(body) ? "" : ", no ServiceNow JSON body"}); it may not be installed, or something else answered. ${plugin}`,
        );
      }
      return row(
        NAMES.cicd,
        "pass",
        `The CI/CD API answers (HTTP ${status} for an unknown progress id).`,
      );
    },
  };
}

/** The statuses the CI/CD API can give an unknown progress id. */
const CICD_ANSWER_STATUSES = new Set([200, 400, 404]);

function isJsonObject(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body);
}

/**
 * The CI/CD API itself answers with a ServiceNow envelope: a `result`, or an
 * `error` object. A 404 for a missing API says the URI is not a resource.
 */
function cicdAnswered(body: unknown): boolean {
  if (!isJsonObject(body)) return false;
  const error = body.error;
  const envelope =
    "result" in body ||
    (error !== null && typeof error === "object" && !Array.isArray(error));
  if (!envelope) return false;
  return !/does not represent any resource/i.test(JSON.stringify(body));
}

function runtimeRow(opts: DoctorOptions): Check {
  return {
    name: NAMES.runtime,
    description: "The Node.js runtime and servicenow-preflight version.",
    meta: { severity: "advisory", requires: "ALWAYS" },
    run() {
      const node = opts.nodeVersion ?? process.versions.node;
      const major = Number(node.split(".")[0]);
      if (!Number.isInteger(major) || major < 20) {
        return row(
          NAMES.runtime,
          "warn",
          `Node ${node} is not supported; servicenow-preflight ${opts.version} needs Node 20 or newer. Upgrade Node.`,
        );
      }
      return row(
        NAMES.runtime,
        "pass",
        `Node ${node}; servicenow-preflight ${opts.version}.`,
      );
    },
  };
}
