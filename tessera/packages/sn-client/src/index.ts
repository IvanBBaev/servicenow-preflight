/**
 * @tessera/sn-client — the ServiceNow REST surface Tessera runs against.
 *
 * The module bodies are vendored from github.com/IvanBBaev/servicenow-mcp
 * @ 5acdcc7 (MIT, vendored by the sole author/copyright owner — ADR-002); see
 * VENDORED.md for per-file provenance and the two behavioural adaptations
 * (DEV-24 write gate, DEV-15 write journal) woven into the transport.
 *
 * Core modules are re-exported flat because their names are already global
 * (`snRequest`, `ServiceNowError`, `getCredentials`). The api modules are
 * exported as namespaces: they are per-domain wrappers whose helper names only
 * make sense next to their domain, and several of them re-export core symbols.
 */

// --- core ---------------------------------------------------------------
export { ServiceNowError } from "./core/errors.js";
export {
  _buildBaseUrl,
  instanceBaseUrl,
  resolveHost,
  resolveHostWithPolicy,
} from "./core/host.js";
export type { HostPolicy } from "./core/host.js";
export { logger, setLogSink } from "./core/logging.js";
export type { LogLevel, LogSink } from "./core/logging.js";
export {
  currentRequestProfile,
  runWithProfile,
} from "./core/request-context.js";
export {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_SCHEMA_CACHE_TTL_SEC,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOOL_PACKAGES,
  MAX_PAGE_SIZE,
  getDeniedPackages,
  getDocsDir,
  getHttpHost,
  getHttpPort,
  getHttpToken,
  getMaxConcurrent,
  getMaxRecords,
  getMaxResultChars,
  getMaxRetries,
  getReadOnlyPackages,
  getRedactFields,
  getRequestedPackages,
  getSchemaCacheTtlMs,
  getTimeoutMs,
  getTransport,
  getWriteMode,
  includeReferenceLinks,
  redactPII,
  resultPretty,
  useCodeSearch,
} from "./core/settings.js";
export {
  activeProfile,
  assertValidProfileName,
  formatEnvValue,
  getCredentials,
  getEnvPath,
  hasCredentials,
  listProfiles,
  loadEnv,
  persistEnv,
  reloadCredentialsFromEnv,
  saveCredentials,
  useProfile,
} from "./core/config.js";
export type { ServiceNowCredentials } from "./core/config.js";
export { applyEnv, parseEnvContent } from "./core/env-file.js";
export {
  assertPackageAllowed,
  assertPackageWriteAllowed,
  assertTableAllowed,
  assertTableWritable,
  assertUnclassifiedWriteAllowed,
  assertWriteAllowed,
  getAllowedTables,
  NEVER_WRITE_TABLES,
  getDeniedTables,
  isReadOnly,
} from "./core/policy.js";
export { appendWriteJournal } from "./core/write-journal.js";
export type { JournalEntry, WriteAction } from "./core/write-journal.js";
export {
  authEnv,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  getAuthMode,
  getAuthProvider,
  invalidateToken,
  invalidateTokens,
} from "./core/auth.js";
export type {
  AuthMode,
  AuthProvider,
  AuthorizeUrlParams,
  TokenSet,
} from "./core/auth.js";
// http.ts also re-exports the telemetry surface from http-util.ts.
export {
  _resetTelemetry,
  getTelemetry,
  snRequest,
  tableTargetFor,
  writeTargetFor,
} from "./core/http.js";
export type {
  SnRequestArgs,
  SnResponse,
  Telemetry,
  TelemetrySnapshot,
} from "./core/http.js";

// --- api ----------------------------------------------------------------
export * as tableApi from "./api/table.js";
export * as metaApi from "./api/meta.js";
export * as scriptsApi from "./api/scripts.js";
export * as whereUsedApi from "./api/whereused.js";
export * as flowsApi from "./api/flows.js";
export * as atfApi from "./api/atf.js";
export * as compareApi from "./api/compare.js";
export * as snapshotApi from "./api/snapshot.js";
export * as capabilitiesApi from "./api/capabilities.js";
export * as aggregateApi from "./api/aggregate.js";
export * as pluginApi from "./api/plugin.js";
export * as docsApi from "./api/docs.js";
export * as sharedApi from "./api/shared.js";
