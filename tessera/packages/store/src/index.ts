// @tessera/store public surface. The module bodies are vendored from
// github.com/IvanBBaev/syncrona @ 73cae76 under ADR-002 option 4 — see
// VENDORED.md for the per-file provenance and adaptation notes.
export type { SN, Sync } from "./types.js";
export {
  ENDPOINT_NOT_FOUND_STATUSES,
  FLAT_FIELD_SEPARATOR,
  PATH_DELIMITER,
  escapeQueryValue,
  getErrorResponseStatus,
  isEndpointNotFoundStatus,
  isFlatEncoded,
  isSafePathComponent,
} from "./support.js";
export type { SNClient, StoreLogger } from "./support.js";
export {
  DEFAULT_FILE_EXTENSION,
  SN_TYPE_MAP,
  SN_TYPE_QUERY,
  TABLE_DISPLAY_FIELD,
  getDisplayField,
  getFileTypeForInternalType,
} from "./fieldMap.js";
export {
  COLLABORATION_EVICT_MAX_AGE_MS,
  COLLABORATION_EVICT_MAX_GENERATIONS,
  COLLABORATION_EVICT_PREFIX,
  COLLABORATION_EVICT_SUFFIX,
  COLLABORATION_LOCK_ACQUIRE_ATTEMPTS,
  COLLABORATION_LOCK_FILE,
  COLLABORATION_LOCK_FUTURE_SKEW_MS,
  COLLABORATION_LOCK_MAX_AGE_MS,
  COLLABORATION_LOCK_RELEASE_ATTEMPTS,
  COLLABORATION_LOCK_RETRY_MS,
  COLLABORATION_STAGING_PREFIX,
  createCollaborationLock,
  createExclusiveWithContent,
  describeCollaborationLockTimeAnomaly,
  isCollaborationLockStale,
  isEvictionClaimAbandoned,
  isProcessAlive,
  isRawLockStale,
  parseCollaborationLock,
} from "./collaborationLock.js";
export type {
  CollaborationLock,
  CollaborationLockHandle,
  CollaborationLockOptions,
} from "./collaborationLock.js";
export {
  SNFileExists,
  appendToPath,
  createDirRecursively,
  createFileUtils,
  isDirectory,
  isUnderPath,
  isValidPath,
  pathExists,
  splitEncodedPaths,
  summarizeFile,
  toAbsolutePath,
  withRetry,
  writeBuildFile,
  writeFileForce,
} from "./FileUtils.js";
export type { FileUtilsHandle, FileUtilsOptions } from "./FileUtils.js";
export {
  buildRecordFieldList,
  buildRecordName,
  createManifestBuilder,
  fieldText,
  isNotFoundError,
  isScopedEndpointUnavailableError,
  QueryIdentifierError,
  queryIdentifier,
  TABLE_API_MAX_PAGES,
  TableAPIPagingError,
} from "./manifestBuilder.js";
export type {
  ManifestBuilderHandle,
  ManifestBuilderOptions,
  ManifestRecordNames,
  QueryIdentifierKind,
} from "./manifestBuilder.js";
export {
  createSnClientAdapter,
  createSnClientManifestBuilder,
  SnClientHttpError,
  SnClientReadError,
  STORE_FIXED_TABLES,
} from "./snClientAdapter.js";
export type {
  SnClientAdapterOptions,
  SnClientQueryOptions,
  SnClientQueryTable,
} from "./snClientAdapter.js";
