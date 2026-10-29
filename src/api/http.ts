/**
 * `servicenow-preflight/http` — the ServiceNow REST client, its typed errors,
 * encoded-query helpers and the connection settings resolved from the
 * environment.
 *
 * @packageDocumentation
 */
export type {
  SnClient,
  SnTable,
  SnCicd,
  SnAuth,
  SnMfa,
  SnTls,
  SnRawResponse,
  SnRequestOptions,
  SnCallOptions,
  SnClientConfig,
  CicdTestSuiteResult,
  TableQueryResult,
} from "../http/client.js";
export {
  createSnClient,
  withSignal,
  SnError,
  SnAuthError,
  SnNetworkError,
  SnHttpError,
  SnTruncationError,
  SnResponseError,
} from "../http/client.js";
export {
  EncodedQueryError,
  IN_CHUNK_SIZE,
  isSafeIdentifier,
  isSysId,
  assertIdentifier,
  assertSysId,
  eq,
  inClause,
  and,
  or,
  chunk,
  scopeFilterClause,
  resolveScope,
} from "../http/query.js";
export type { ResolvedScope } from "../http/query.js";
export {
  loadConfig,
  resolveAuthFromEnv,
  resolveTlsFromEnv,
  UsageError,
  type PreflightConfig,
  type LoadedConfig,
  type LoadConfigOptions,
} from "../config.js";
