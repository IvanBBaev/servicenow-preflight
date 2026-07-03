import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, isAbsolute } from "node:path";
import type { CheckSelection, PreflightAuth } from "./types.js";

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
  user: "SNPF_USER",
  pass: "SNPF_PASS",
  token: "SNPF_TOKEN",
} as const;

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

/** Resolve {@link PreflightAuth} from the environment (OAuth token wins over Basic). */
export function resolveAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PreflightAuth | undefined {
  const token = env[ENV.token]?.trim();
  if (token) {
    return { kind: "oauth", token };
  }
  const user = env[ENV.user]?.trim();
  const pass = env[ENV.pass];
  if (user && pass) {
    return { kind: "basic", user, pass };
  }
  return undefined;
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

  // The instance URL may come from the config file or the environment.
  if (!config.instanceUrl) {
    const envInstance = process.env[ENV.instance]?.trim();
    if (envInstance) config.instanceUrl = envInstance;
  }

  const auth = resolveAuthFromEnv();

  return { config, auth, configPath };
}
