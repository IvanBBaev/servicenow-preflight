import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, isAbsolute } from "node:path";
import type { CheckSelection, PreflightAuth, SnTls } from "./types.js";

/**
 * Configuration loading for the preflight run.
 *
 * A config file (`preflight.config.json` / `.js` / `.mjs`) declares the target
 * instance, which checks to run, and per-check options. Credentials NEVER live
 * in the config file — they come from the environment (or a `.env` file) and
 * are read here into a {@link PreflightAuth}. Secrets are never logged.
 */

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
  /** Per-check options, keyed by check name. */
  checks?: Record<string, Record<string, unknown>>;
  /** Arbitrary options forwarded to checks. */
  options?: Record<string, unknown>;
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
    return Reflect.has(env, prefixed) ? prefixed : undefined;
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
 * Parse a minimal `.env` file into `process.env` (only keys not already set,
 * so real environment variables win). Supports `KEY=value`, `#` comments, and
 * optional surrounding quotes. No dependency — a tiny hand-rolled parser.
 */
async function loadDotEnv(cwd: string): Promise<void> {
  const envPath = resolve(cwd, ".env");
  if (!existsSync(envPath)) return;
  let text: string;
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
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
    return existsSync(abs) ? abs : undefined;
  }
  for (const name of CONFIG_BASENAMES) {
    const abs = resolve(cwd, name);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

/** Read and parse a config file (JSON, or a JS/MJS module's default export). */
async function readConfigFile(path: string): Promise<PreflightConfig> {
  if (path.endsWith(".json")) {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as PreflightConfig;
  }
  // `.js` / `.mjs` — dynamic import; accept a default or a named `config`.
  const mod: unknown = await import(pathToFileURL(path).href);
  const record = (mod ?? {}) as Record<string, unknown>;
  const value = (record.default ?? record.config ?? record) as PreflightConfig;
  return value;
}

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /** Explicit config file path (overrides auto-discovery). */
  configPath?: string;
  /** Skip reading a `.env` file (env vars only). */
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
  if (!opts.skipDotEnv) {
    await loadDotEnv(cwd);
  }

  const configPath = findConfigFile(cwd, opts.configPath);
  const config = configPath ? await readConfigFile(configPath) : {};

  const env = namespacedEnv(process.env, opts.envPrefix);

  // The instance URL may come from the config file or the environment.
  if (!config.instanceUrl) {
    const envInstance = env[ENV.instance]?.trim();
    if (envInstance) config.instanceUrl = envInstance;
  }

  const auth = resolveAuthFromEnv(process.env, opts.envPrefix);
  const tls = resolveTlsFromEnv(process.env, opts.envPrefix);

  return { config, auth, tls, configPath };
}
