// @tessera/config — the one config source (PLAN Phase 1 §Configuration).
//
// Resolves flags, environment and an optional `tessera.config.json` into a
// single value set with per-field provenance, once at startup, and renders it
// redacted for the log. Everything downstream — `resolvePipeline(config)`
// (ARCH-1), the DEV-5 CLI, the MCP tool surface — consumes that result rather
// than reading its own inputs.
//
// Precedence is flag > env > file > default, per field. Secrets never come from
// a config file or from argv; the environment (and behind it the ARCH-7
// canonical credential store) is the only sanctioned channel.

export { ConfigError, ConfigSecretError } from "./errors.js";
export {
  CONFIG_FILE_NAME,
  discoverConfigFile,
  readTextFileSync,
} from "./file.js";
export type { DiscoveredFile, ReadTextFile } from "./file.js";
export { formatOptionsHelp, formatResolvedConfig } from "./format.js";
export { describeJson, isJsonArray, isJsonRecord } from "./json.js";
export {
  CONFIG_OPTION_KEY,
  INSTANCE_ALIAS_KEY,
  MAX_TIMER_MS,
  PREFLIGHT_OPTIONS,
  TOPOLOGY_ROLE_KEYS,
  allowsSource,
  findByFlag,
  findByKey,
} from "./options.js";
export { resolveConfig } from "./resolve.js";
export type { ResolveInput, ResolvedValues } from "./resolve.js";
export {
  REDACTED,
  SECRET_KEY_PHRASES,
  SECRET_KEY_WORDS,
  findSecret,
  hasUrlUserinfo,
  isSecretKey,
  keyWords,
  secretValueShape,
} from "./secrets.js";
export type { SecretFinding } from "./secrets.js";
export { CONFIG_SOURCES } from "./types.js";
export type {
  ConfigSource,
  ConfigValues,
  OptionSpec,
  OptionType,
  OptionValue,
  ResolvedConfig,
  ValuesOf,
} from "./types.js";
