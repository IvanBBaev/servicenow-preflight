/**
 * `servicenow-preflight/state` — the multi-instance registry, per-instance
 * state manifests, `sync` and the drift / promotion gate.
 *
 * @packageDocumentation
 */
export {
  loadRegistry,
  resolveInstance,
  instanceNames,
  registryPath,
  promotionChain,
  RegistryNotFoundError,
  PREFLIGHT_DIR,
  REGISTRY_BASENAME,
  type InstanceDef,
  type InstanceRegistry,
  type ResolvedInstance,
} from "../registry.js";
export {
  loadManifest,
  writeManifest,
  mergeManifest,
  emptyManifest,
  manifestPath,
  logicalId,
  STATE_DIR,
  MANIFEST_VERSION,
  type StateManifest,
  type AtfTestState,
  type AtfSuiteState,
  type AtfCoverage,
  type AtfRunRef,
  type InstanceIdentity,
  type InstalledAppState,
} from "../state/manifest.js";
export {
  pullManifest,
  syncManifest,
  EmptySnapshotError,
  type SyncOptions,
} from "../state/sync.js";
export {
  computeDrift,
  stalenessResults,
  versionParityResults,
  promotionOrderResult,
  FRESHNESS_CHECK,
  INSTANCE_VERSION_CHECK,
  APP_VERSION_CHECK,
  PROMOTION_ORDER_CHECK,
  DEFAULT_STALE_WARN_MS,
  type DriftReport,
  type DriftEntry,
  type DriftManifestRef,
  type StalenessOptions,
  type PromotionOrderOptions,
} from "../state/drift.js";
