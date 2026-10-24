import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, isAbsolute } from "node:path";
import type { CheckSelection, PreflightAuth, SnTls } from "./types.js";
import { isSafeIdentifier } from "./http/query.js";
import { limitProblem } from "./http/limiter.js";
import type { SeverityPolicy } from "./policy.js";

/**
 * Configuration loading for the preflight run.
 *
 * A config file (`preflight.config.json` / `.js` / `.mjs`) declares the target
 * instance, which checks to run, and per-check options. Credentials NEVER live
 * in the config file — they come from the environment (or a `.env` file) and
 * are read here into a {@link PreflightAuth}. Secrets are never logged.
 */

/**
 * A user-fixable error: the CLI was invoked incorrectly, or its configuration /
 * registry / manifest inputs are invalid. The CLI maps it to exit code `2`
 * (distinct from exit `1`, which signals that a check `fail`ed). Thrown by the
 * argument parser, the command pre-condition guards, config-file validation,
 * and registry validation.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The parsed, file-based portion of the configuration. */
export interface PreflightConfig {
  /** Base URL of the target instance. */
  instanceUrl?: string;
  /** Target scope (scoped-app sys_id or scope name). */
  scope?: string;
  /** Target update set sys_id. */
  updateSetId?: string;
  /** Check selection: run only these / skip these (by check name). */
  select?: CheckSelection;
  /**
   * Per-check options, keyed by check name: each entry is shallow-merged over
   * {@link options} for that check only (`PreflightContext.checkOptions`).
   * Unknown check names are a usage error.
   */
  checks?: Record<string, Record<string, unknown>>;
  /** Arbitrary options forwarded to checks. */
  options?: Record<string, unknown>;
  /**
   * Outbound HTTP(S) forward proxy URL for reaching the instance (SR-5).
   * Mirrors `SNPF_PROXY` (the config file wins when both are present) and is
   * handed to the client as its explicit proxy, which outranks the standard
   * `HTTPS_PROXY`/`https_proxy` variables. Proxy credentials belong in the
   * URL userinfo of the `SNPF_PROXY` environment variable, not in this file —
   * the config file must stay committable.
   */
  proxy?: string;
  /**
   * Extra `NO_PROXY`-style bypass entries (mirrors `SNPF_NO_PROXY`), merged
   * with `NO_PROXY`/`no_proxy`: comma-separated hostnames or host suffixes,
   * each with an optional `:port`, or `*` to force direct connections.
   */
  noProxy?: string;
  /**
   * Baseline of accepted findings (see `src/baseline.ts`): `true` loads the
   * default `.preflight/baseline.json` (per-instance file first for a registry
   * instance), a string names the file (relative to the working directory).
   * `false` or absent disables it. The `--baseline` flag wins over this key.
   */
  baseline?: string | boolean;
  /**
   * Severity policy (see `src/policy.ts`): per-check `"fail"` / `"warn"` /
   * `"off"` overrides of how a non-pass result is reported. `--severity`
   * entries win over this key for the same check. Unknown check names are a
   * usage error.
   */
  severity?: SeverityPolicy;
}

/** What {@link loadConfig} resolves: the file config plus resolved auth. */
export interface LoadedConfig {
  /** The file-based configuration (empty object when no file is found). */
  config: PreflightConfig;
  /** Auth resolved from the environment, or `undefined` when none is set. */
  auth?: PreflightAuth;
  /**
   * Mutual-TLS client certificate resolved from the environment, or `undefined`
   * when none is configured. Resolves independently of `auth`.
   */
  tls?: SnTls;
  /** Absolute path of the config file that was loaded, if any. */
  configPath?: string;
  /**
   * The environment the config was resolved from: the `env` option (or
   * `process.env`) with `.env` values filled in. Pass it to
   * `createSnClient({ env })` so proxy variables from `.env` apply too.
   */
  env: NodeJS.ProcessEnv;
  /**
   * Request limits from `SNPF_MAX_INFLIGHT` / `SNPF_RPS` (namespaced like the
   * credentials), when set. Pass them to `createSnClient` (F-X-1).
   */
  limits: RequestLimits;
  /**
   * `SNPF_CACHE` as a switch (`0`/`false`/`off`/`no` or `1`/`true`/`on`/`yes`),
   * when set. The CLI caches reads unless this is `false` (F-X-2).
   */
  cache?: boolean;
}

/** Client request limits (see `SnClientConfig.maxInFlight` / `rps`). */
export interface RequestLimits {
  maxInFlight?: number;
  rps?: number;
}

/**
 * Parse a request limit from a flag or an env variable. Blank yields
 * `undefined`; anything outside the limiter's range is a {@link UsageError}
 * naming `label` (e.g. `--rps must be a number between 0.5 and 100`).
 */
export function parseRequestLimit(
  name: "maxInFlight" | "rps",
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value.trim());
  const problem = limitProblem(name, n);
  if (problem) {
    throw new UsageError(`${label} ${problem} (got "${value.trim()}").`);
  }
  return n;
}

const SWITCH_VALUES: Record<string, boolean> = {
  "0": false,
  false: false,
  off: false,
  no: false,
  "1": true,
  true: true,
  on: true,
  yes: true,
};

/**
 * Parse an on/off env variable. Blank yields `undefined`; an unknown value is
 * a {@link UsageError} naming `label`.
 */
export function parseSwitch(
  value: string | undefined,
  label: string,
): boolean | undefined {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === "") return undefined;
  const on = SWITCH_VALUES[v];
  if (on === undefined) {
    throw new UsageError(
      `${label} must be one of 0, 1, false, true, off, on, no, yes (got "${value?.trim()}").`,
    );
  }
  return on;
}

/** Config file names probed, in precedence order. */
const CONFIG_BASENAMES = [
  "preflight.config.json",
  "preflight.config.js",
  "preflight.config.mjs",
];

/** Environment variable names for credentials (never hardcoded). */
const ENV = {
  instance: "SNPF_INSTANCE",
  /** Target update set sys_id (mirrors the config file's `updateSetId`). */
  updateSet: "SNPF_UPDATE_SET",
  /** Explicit auth selector (optional); overrides auto-detection. */
  auth: "SNPF_AUTH",
  user: "SNPF_USER",
  pass: "SNPF_PASS",
  token: "SNPF_TOKEN",
  apiKey: "SNPF_API_KEY",
  oauthClientId: "SNPF_OAUTH_CLIENT_ID",
  oauthClientSecret: "SNPF_OAUTH_CLIENT_SECRET",
  oauthRefreshToken: "SNPF_OAUTH_REFRESH_TOKEN",
  oauthTokenUrl: "SNPF_OAUTH_TOKEN_URL",
  jwtKey: "SNPF_OAUTH_JWT_KEY",
  jwtKid: "SNPF_OAUTH_JWT_KID",
  jwtSub: "SNPF_OAUTH_JWT_SUB",
  jwtAud: "SNPF_OAUTH_JWT_AUD",
  jwtIss: "SNPF_OAUTH_JWT_ISS",
  jwtAssertion: "SNPF_OAUTH_JWT_ASSERTION",
  mtlsCert: "SNPF_MTLS_CERT",
  mtlsKey: "SNPF_MTLS_KEY",
  mtlsCa: "SNPF_MTLS_CA",
  mtlsPassphrase: "SNPF_MTLS_PASSPHRASE",
  /** Outbound proxy URL (mirrors the config file's `proxy`) — SR-5. */
  proxy: "SNPF_PROXY",
  /** Extra proxy-bypass entries (mirrors the config file's `noProxy`) — SR-5. */
  noProxy: "SNPF_NO_PROXY",
  /** Client in-flight request cap (F-X-1). */
  maxInFlight: "SNPF_MAX_INFLIGHT",
  /** Client requests-per-second limit (F-X-1). */
  rps: "SNPF_RPS",
  /** Per-run read cache switch (F-X-2). */
  cache: "SNPF_CACHE",
} as const;

/**
 * Resolve an env value that may reference a file. A value beginning with `@` is
 * read from the named path (relative to `cwd`) — the convention for PEM material
 * (certs, keys) or a long pre-signed assertion. Any other non-blank value is
 * returned verbatim; a blank/unset value yields `undefined`. A missing `@`-file
 * is a real misconfiguration and throws (with the path only — never contents).
 */
function readMaybeFile(
  value: string | undefined,
  cwd: string = process.cwd(),
): string | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith("@")) return value.trim() ? value : undefined;
  const path = value.slice(1).trim();
  if (!path) return undefined;
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    return readFileSync(abs, "utf8");
  } catch {
    throw new Error(
      `Could not read the file referenced by an SNPF_* '@' value: ${abs}`,
    );
  }
}

/**
 * Wrap an environment so that `SNPF_*` lookups resolve per-instance first. With
 * a `prefix` of e.g. `DEV`, reading `SNPF_USER` returns `SNPF_DEV_USER` when it
 * is set, otherwise falls back to the unprefixed `SNPF_USER`. Non-`SNPF_` keys
 * and everything else pass through unchanged. An empty/absent prefix returns the
 * env untouched, so the single-instance path is byte-for-byte unaffected.
 *
 * This lets {@link resolveAuthFromEnv} / {@link resolveTlsFromEnv} stay written
 * against the flat `SNPF_*` names while transparently reading a stage's vars.
 */
export function namespacedEnv(
  env: NodeJS.ProcessEnv,
  prefix?: string,
): NodeJS.ProcessEnv {
  const p = prefix?.trim().toUpperCase();
  if (!p) return env;
  const ns = `SNPF_${p}_`;
  const redirect = (key: string | symbol): string | undefined => {
    if (typeof key !== "string" || !key.startsWith("SNPF_")) return undefined;
    const prefixed = ns + key.slice("SNPF_".length);
    // Redirect only when the namespaced value is actually set to a non-empty
    // string. An empty `SNPF_<ENV>_TOKEN=""` must fall back to the flat
    // `SNPF_TOKEN` rather than shadow it with a blank that reads as "unset".
    const value = env[prefixed];
    return typeof value === "string" && value.length > 0 ? prefixed : undefined;
  };
  return new Proxy(env, {
    get(target, key) {
      return target[redirect(key) ?? (key as string)];
    },
    has(target, key) {
      return redirect(key) !== undefined || Reflect.has(target, key);
    },
  });
}

/** The shared OAuth client credentials + optional token-endpoint override. */
function oauthCommon(env: NodeJS.ProcessEnv): {
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
} {
  return {
    clientId: env[ENV.oauthClientId]?.trim() || undefined,
    clientSecret: env[ENV.oauthClientSecret]?.trim() || undefined,
    tokenUrl: env[ENV.oauthTokenUrl]?.trim() || undefined,
  };
}

/**
 * Parse the right-hand side of a `.env` assignment. A quoted value keeps its
 * contents verbatim, including any `#` (so `SNPF_PASS="a#b"` is `a#b`); an
 * unquoted value has an inline `#` comment (introduced by whitespace) stripped,
 * so `SNPF_TOKEN=abc # note` yields `abc`. A `#` with no leading whitespace is
 * part of the value (`SNPF_TOKEN=ab#cd` stays `ab#cd`).
 */
function parseDotEnvValue(raw: string): string {
  const quote = raw[0];
  if ((quote === '"' || quote === "'") && raw.indexOf(quote, 1) >= 0) {
    return raw.slice(1, raw.indexOf(quote, 1));
  }
  const hash = raw.search(/\s#/);
  return (hash >= 0 ? raw.slice(0, hash) : raw).trimEnd();
}

/**
 * Read a minimal `.env` file from `cwd` into a fresh key → value map (empty
 * when there is no `.env`). Pure: it never touches `process.env` (F-X-9) — the
 * caller decides how the values merge with the real environment. Supports
 * `KEY=value`, a leading `export ` on the key, whole-line and inline `#`
 * comments, and optional surrounding quotes. No dependency — a tiny
 * hand-rolled parser.
 */
export async function readDotEnv(cwd: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const envPath = resolve(cwd, ".env");
  let text: string;
  try {
    text = await readFile(envPath, "utf8");
  } catch (err) {
    // No `.env` at all is the normal case. A `.env` that exists but cannot be
    // read is a real misconfiguration (wrong permissions, or a directory of that
    // name), and swallowing it drops every credential the file carries: the run
    // would continue unauthenticated, report warns rather than failures, and
    // exit 0 — a green build that verified nothing. Same rule as a missing
    // `@`-file, which already throws.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return values;
    const detail = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Could not read ${envPath}: ${detail}`);
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    // A leading `export ` (the shell convention for a sourceable `.env`) is not
    // part of the variable name — strip it so `export SNPF_USER=…` sets
    // `SNPF_USER`, not `export SNPF_USER`.
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    values[key] = parseDotEnvValue(line.slice(eq + 1).trim());
  }
  return values;
}

/**
 * Overlay `.env` values onto a COPY of `env`, only for keys `env` leaves
 * unset, so real environment variables always win. Neither input is written.
 */
function mergeDotEnv(
  env: NodeJS.ProcessEnv,
  dotenv: Record<string, string>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(dotenv)) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Build a specific auth {@link PreflightAuth} kind from the environment, or
 * `undefined` when the inputs that kind requires are not all present.
 */
function buildAuthByKind(
  kind: string,
  env: NodeJS.ProcessEnv,
): PreflightAuth | undefined {
  switch (kind) {
    case "basic": {
      const user = env[ENV.user]?.trim();
      const pass = env[ENV.pass];
      return user && pass ? { kind: "basic", user, pass } : undefined;
    }
    case "token":
    case "oauth": {
      const token = env[ENV.token]?.trim();
      return token ? { kind: "oauth", token } : undefined;
    }
    case "apikey": {
      const apiKey = env[ENV.apiKey]?.trim();
      return apiKey ? { kind: "apikey", apiKey } : undefined;
    }
    case "oauth-password": {
      const { clientId, clientSecret, tokenUrl } = oauthCommon(env);
      const user = env[ENV.user]?.trim();
      const pass = env[ENV.pass];
      if (!clientId || !clientSecret || !user || !pass) return undefined;
      return {
        kind: "oauth-password",
        clientId,
        clientSecret,
        user,
        pass,
        ...(tokenUrl ? { tokenUrl } : {}),
      };
    }
    case "oauth-client": {
      const { clientId, clientSecret, tokenUrl } = oauthCommon(env);
      if (!clientId || !clientSecret) return undefined;
      return {
        kind: "oauth-client",
        clientId,
        clientSecret,
        ...(tokenUrl ? { tokenUrl } : {}),
      };
    }
    case "oauth-refresh": {
      const { clientId, clientSecret, tokenUrl } = oauthCommon(env);
      const refreshToken = env[ENV.oauthRefreshToken]?.trim();
      if (!clientId || !clientSecret || !refreshToken) return undefined;
      return {
        kind: "oauth-refresh",
        clientId,
        clientSecret,
        refreshToken,
        ...(tokenUrl ? { tokenUrl } : {}),
      };
    }
    case "oauth-jwt": {
      const { clientId, clientSecret, tokenUrl } = oauthCommon(env);
      if (!clientId) return undefined;
      // The signing key and the (optional) pre-signed assertion support `@path`.
      const assertion = readMaybeFile(env[ENV.jwtAssertion]);
      const privateKey = readMaybeFile(env[ENV.jwtKey]);
      if (!assertion && !privateKey) return undefined;
      const keyId = env[ENV.jwtKid]?.trim();
      const subject = env[ENV.jwtSub]?.trim();
      const audience = env[ENV.jwtAud]?.trim();
      const issuer = env[ENV.jwtIss]?.trim();
      return {
        kind: "oauth-jwt",
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
        ...(assertion ? { assertion } : {}),
        ...(privateKey ? { privateKey } : {}),
        ...(keyId ? { keyId } : {}),
        ...(subject ? { subject } : {}),
        ...(audience ? { audience } : {}),
        ...(issuer ? { issuer } : {}),
        ...(tokenUrl ? { tokenUrl } : {}),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Resolve {@link PreflightAuth} from the environment. An explicit `SNPF_AUTH`
 * selector picks the method; otherwise the method is auto-detected, first match
 * winning:
 *
 * 1. `SNPF_OAUTH_CLIENT_ID` + `_SECRET` → an OAuth grant flow — `oauth-refresh`
 *    (refresh token present), else `oauth-jwt` (JWT key/assertion present), else
 *    `oauth-password` (user+pass present), else `oauth-client`.
 * 2. `SNPF_TOKEN` → a static `oauth` bearer.
 * 3. `SNPF_API_KEY` → `apikey`.
 * 4. `SNPF_USER` + `SNPF_PASS` → `basic`.
 * 5. otherwise no header auth (mutual TLS may still identify the caller).
 */
export function resolveAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  prefix?: string,
): PreflightAuth | undefined {
  const src = namespacedEnv(env, prefix);
  const selector = src[ENV.auth]?.trim();
  if (selector) return buildAuthByKind(selector, src);

  const { clientId, clientSecret } = oauthCommon(src);
  if (clientId && clientSecret) {
    if (src[ENV.oauthRefreshToken]?.trim())
      return buildAuthByKind("oauth-refresh", src);
    if (src[ENV.jwtKey]?.trim() || src[ENV.jwtAssertion]?.trim())
      return buildAuthByKind("oauth-jwt", src);
    if (src[ENV.user]?.trim() && src[ENV.pass])
      return buildAuthByKind("oauth-password", src);
    return buildAuthByKind("oauth-client", src);
  }
  const token = src[ENV.token]?.trim();
  if (token) return { kind: "oauth", token };
  const apiKey = src[ENV.apiKey]?.trim();
  if (apiKey) return { kind: "apikey", apiKey };
  const user = src[ENV.user]?.trim();
  const pass = src[ENV.pass];
  if (user && pass) return { kind: "basic", user, pass };
  return undefined;
}

/**
 * Resolve a mutual-TLS client certificate from the environment. Requires both
 * `SNPF_MTLS_CERT` and `SNPF_MTLS_KEY` (each a PEM value or an `@path`); the CA
 * bundle and key passphrase are optional. Resolves independently of the header
 * auth — a client cert may accompany any method or stand alone.
 */
export function resolveTlsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  prefix?: string,
): SnTls | undefined {
  const src = namespacedEnv(env, prefix);
  const cert = readMaybeFile(src[ENV.mtlsCert]);
  const key = readMaybeFile(src[ENV.mtlsKey]);
  if (!cert || !key) return undefined;
  const tls: SnTls = { cert, key };
  const ca = readMaybeFile(src[ENV.mtlsCa]);
  if (ca) tls.ca = ca;
  const passphrase = src[ENV.mtlsPassphrase];
  if (passphrase) tls.passphrase = passphrase;
  return tls;
}

/** Locate the config file to load: an explicit path, or the first probed name. */
function findConfigFile(
  cwd: string,
  explicitPath?: string,
): string | undefined {
  if (explicitPath) {
    const abs = isAbsolute(explicitPath)
      ? explicitPath
      : resolve(cwd, explicitPath);
    if (!existsSync(abs)) {
      throw new UsageError(`Config file not found: ${abs}`);
    }
    return abs;
  }
  for (const name of CONFIG_BASENAMES) {
    const abs = resolve(cwd, name);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

/** A short human name for a JSON value's type, for error messages. */
function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** Read and parse a config file (JSON, or a JS/MJS module's default export). */
async function readConfigFile(path: string): Promise<PreflightConfig> {
  let value: unknown;
  if (path.endsWith(".json")) {
    const text = await readFile(path, "utf8");
    try {
      value = JSON.parse(text);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new UsageError(`Config file ${path} is not valid JSON: ${detail}`);
    }
  } else {
    // `.js` / `.mjs` — dynamic import; accept a default or a named `config`.
    const mod: unknown = await import(pathToFileURL(path).href);
    const record = (mod ?? {}) as Record<string, unknown>;
    value = record.default ?? record.config ?? record;
  }
  // A config that parses but is not an object (array, number, string, null)
  // would silently read as "no settings" and later crash on a field access;
  // reject it with a clear, path-naming error instead.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageError(
      `Config file ${path} must contain a JSON object, got ${describeJson(value)}.`,
    );
  }
  return value;
}

/**
 * Reject config values that would break out of a ServiceNow encoded query.
 * `scope`, `updateSetId`, and each `options.languages` / `options.baseLanguage`
 * code are interpolated into `sysparm_query` downstream, so a value carrying an
 * operator character (`^`, `^OR`, `^NQ`, or the percent-encoded `%5E`) could
 * inject extra query clauses (SR-1). Each must be a plain ServiceNow identifier
 * (`[A-Za-z0-9_.-]`). This is the first, load-time line of defence — a
 * {@link UsageError} (CLI exit 2) — ahead of the query builder's own runtime
 * guard. Blank/absent values are skipped; a comma-separated languages string is
 * split and each code validated (matching how the i18n check reads them).
 */
function assertSafeQueryInputs(config: PreflightConfig): void {
  const check = (value: unknown, label: string): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed === "") return;
    if (!isSafeIdentifier(trimmed)) {
      throw new UsageError(
        `${label} "${value}" contains characters outside [A-Za-z0-9_.-]. It is ` +
          `interpolated into a ServiceNow encoded query, so operator characters ` +
          `(e.g. "^", "^OR", "%5E") are rejected to prevent query injection.`,
      );
    }
  };
  check(config.scope, "Config scope");
  check(config.updateSetId, "Config updateSetId");
  // Per-check entries override `options` for their check, so they carry the
  // same query-bound keys and get the same load-time guard.
  const optionSets: Array<[Record<string, unknown> | undefined, string]> = [
    [config.options, "Config"],
    ...Object.entries(config.checks ?? {}).map(
      ([name, opts]): [Record<string, unknown>, string] => [
        opts,
        `Config checks["${name}"]`,
      ],
    ),
  ];
  for (const [opts, prefix] of optionSets) {
    const langs = opts?.languages;
    const codes = Array.isArray(langs)
      ? langs
      : typeof langs === "string"
        ? langs.split(",")
        : [];
    for (const code of codes) check(code, `${prefix} language`);
    check(opts?.baseLanguage, `${prefix} baseLanguage`);
  }
}

/**
 * Reject a `checks` config value that is not an object of objects: a JSON
 * config file is untyped at runtime, and a non-object entry would otherwise be
 * spread into a check's options as nonsense (a string spreads to indexed
 * characters) instead of surfacing as the config mistake it is.
 */
function assertCheckOptionsConfigType(config: PreflightConfig): void {
  const value: unknown = config.checks;
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new UsageError(
      `Config checks must be an object mapping check names to option objects, got ${describeJson(value)}.`,
    );
  }
  for (const [name, opts] of Object.entries(value)) {
    if (!isPlainObject(opts)) {
      throw new UsageError(
        `Config checks["${name}"] must be an object of options, got ${describeJson(opts)}.`,
      );
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reject non-string `proxy` / `noProxy` config-file values (SR-5). Both are
 * declared `string`, but a JSON config file is untyped at runtime: a `noProxy`
 * array (a natural guess for a list-valued field) would otherwise reach
 * {@link resolveProxy}, whose `.split(",")` throws mid-request and surfaces as a
 * misleading "cannot reach ServiceNow" network error rather than a config
 * mistake; a non-string `proxy` (e.g. a bare port number) is worse — the
 * client's `typeof === "string"` guards silently skip it, bypassing the
 * configured proxy and violating the "a configured proxy is never silently
 * bypassed" invariant. Fail closed at load time with an actionable
 * {@link UsageError} instead. Env fallbacks are always strings, so only
 * config-FILE values can trip this.
 */
function assertProxyConfigTypes(config: PreflightConfig): void {
  const check = (value: unknown, label: string, expected: string): void => {
    if (value === undefined || typeof value === "string") return;
    throw new UsageError(
      `Config ${label} must be ${expected}, got ${describeJson(value)}.`,
    );
  };
  check(config.proxy, "proxy", 'a proxy URL string (e.g. "http://proxy:3128")');
  check(
    config.noProxy,
    "noProxy",
    'a comma-separated host string (e.g. "localhost,*.internal"), not a JSON array',
  );
}

/**
 * Fail closed on a mistyped `baseline` config value: anything other than a
 * path string or a boolean is a {@link UsageError}, so a typo never silently
 * disables the accepted-findings file (or enables a bogus one).
 */
function assertBaselineConfigType(config: PreflightConfig): void {
  const value: unknown = config.baseline;
  if (
    value === undefined ||
    typeof value === "boolean" ||
    (typeof value === "string" && value.trim().length > 0)
  ) {
    return;
  }
  throw new UsageError(
    `Config baseline must be true, false or a non-empty path string, got ${describeJson(value)}.`,
  );
}

/**
 * Fail closed on a malformed `severity` policy: it must be an object whose
 * values are `"fail"`, `"warn"` or `"off"`. Check names are validated later,
 * against the loaded check set (`validatePolicy`).
 */
function assertSeverityConfigType(config: PreflightConfig): void {
  const value: unknown = config.severity;
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageError(
      `Config severity must be an object mapping check names to "fail", "warn" or "off", got ${describeJson(value)}.`,
    );
  }
  for (const [name, level] of Object.entries(value)) {
    if (level !== "fail" && level !== "warn" && level !== "off") {
      throw new UsageError(
        `Config severity["${name}"] must be "fail", "warn" or "off", got ${
          typeof level === "string" ? `"${level}"` : describeJson(level)
        }.`,
      );
    }
  }
}

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Explicit config file path (overrides auto-discovery). */
  configPath?: string;
  /**
   * Environment to resolve `SNPF_*` (and proxy) variables from. Defaults to
   * `process.env`; it is never written — `.env` values merge into a copy.
   */
  env?: NodeJS.ProcessEnv;
  /** Read a `.env` file from `cwd` (default `true`). */
  dotenv?: boolean;
  /** @deprecated Use `dotenv: false`. Skip reading a `.env` file. */
  skipDotEnv?: boolean;
  /**
   * Credential env namespace for a selected instance (e.g. `DEV`). When set,
   * `SNPF_<ENV>_*` is consulted before the unprefixed `SNPF_*` (see
   * {@link namespacedEnv}). Absent → the flat single-instance behaviour.
   */
  envPrefix?: string;
}

/**
 * Load configuration from `cwd`: resolve a `preflight.config.*` file (if any)
 * and read credentials from the environment (after loading an optional `.env`).
 * Returns the file config and the resolved auth; credentials are never read
 * from the config file and never logged.
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  opts: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  // F-X-9: `.env` values merge into a private copy of the environment and
  // never into `process.env`, so several loads in one process (library
  // embedders, MCP hosts) cannot leak credentials into each other.
  const useDotEnv = opts.dotenv ?? !opts.skipDotEnv;
  const baseEnv = opts.env ?? process.env;
  const fullEnv = useDotEnv
    ? mergeDotEnv(baseEnv, await readDotEnv(cwd))
    : { ...baseEnv };

  const configPath = findConfigFile(cwd, opts.configPath);
  const config = configPath ? await readConfigFile(configPath) : {};

  const env = namespacedEnv(fullEnv, opts.envPrefix);

  // The instance URL may come from the config file or the environment.
  if (!config.instanceUrl) {
    const envInstance = env[ENV.instance]?.trim();
    if (envInstance) config.instanceUrl = envInstance;
  }

  // The update set may likewise be supplied via the environment (the config
  // file's `updateSetId` wins when both are present).
  if (!config.updateSetId) {
    const envUpdateSet = env[ENV.updateSet]?.trim();
    if (envUpdateSet) config.updateSetId = envUpdateSet;
  }

  // The proxy settings may likewise come from the environment (SR-5); the
  // config file wins when both are present. Within the client's proxy
  // precedence these count as "explicit configuration" and outrank the
  // standard HTTPS_PROXY/https_proxy variables (OPP-2).
  if (!config.proxy) {
    const envProxy = env[ENV.proxy]?.trim();
    if (envProxy) config.proxy = envProxy;
  }
  if (!config.noProxy) {
    const envNoProxy = env[ENV.noProxy]?.trim();
    if (envNoProxy) config.noProxy = envNoProxy;
  }

  // Fail closed at load time on a mistyped proxy/noProxy config value (SR-5)
  // before it can reach the client as a silent bypass or a mid-request crash.
  assertProxyConfigTypes(config);
  assertBaselineConfigType(config);
  assertSeverityConfigType(config);
  assertCheckOptionsConfigType(config);

  // Fail closed at load time on config values that would inject into an encoded
  // query (SR-1), after env fallbacks so env-supplied values are covered too.
  assertSafeQueryInputs(config);

  const auth = resolveAuthFromEnv(fullEnv, opts.envPrefix);
  const tls = resolveTlsFromEnv(fullEnv, opts.envPrefix);

  const limits: RequestLimits = {};
  const maxInFlight = parseRequestLimit(
    "maxInFlight",
    env[ENV.maxInFlight],
    ENV.maxInFlight,
  );
  if (maxInFlight !== undefined) limits.maxInFlight = maxInFlight;
  const rps = parseRequestLimit("rps", env[ENV.rps], ENV.rps);
  if (rps !== undefined) limits.rps = rps;

  const cache = parseSwitch(env[ENV.cache], ENV.cache);

  return {
    config,
    auth,
    tls,
    configPath,
    env: fullEnv,
    limits,
    ...(cache !== undefined ? { cache } : {}),
  };
}
