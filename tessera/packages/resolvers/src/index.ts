/**
 * @tessera/resolvers — ARCH-5's answer to "what changed?" (PLAN Phase 2).
 *
 * Three adapters over one port. `StoryResolver` reads an `rm_story` and the
 * update sets linked to it; `ScopeResolver` enumerates the testable artifacts
 * of an application scope; `CompositeResolver` runs them in ARCH-5 order and
 * unions the results de-duplicated by sys_id — order sets which `resolvedBy`
 * label survives a tie, not which adapter gets to run. `UpdateSetResolver` is
 * deliberately absent: DESIGN §12.3 row 2 defers it past the MVP, and the
 * composite refuses `--update-set` rather than accepting it and ignoring it.
 *
 * Everything here READS. There is no write path in this package and no way to
 * reach one: the reader is GET-only and bound to the source profile (ARCH-19),
 * so this stage is safe against any topology role including `target` (ARCH-8).
 *
 * TM-1 note (`Untrusted<T>`): this package deliberately ingests no free text.
 * A story's `short_description`, an update-set description and a script body
 * are all untrusted input the threat model requires to be branded at the
 * ingestion boundary — so resolution reads IDENTITY only (table, sys_id,
 * display name) and never the prose the generator would be tempted to
 * concatenate. The brand itself lands in the first stage that genuinely reads
 * such text, which turned out to be Phase 3's ImpactAnalyzer (it scans script
 * bodies): see `Untrusted<T>` in `@tessera/types`. Introducing it here first
 * would have made the wrapper look satisfied while no dangerous string had yet
 * been read.
 */

export { createCompositeResolver } from "./composite.js";
export { ResolutionFaultError, ResolutionInputError } from "./errors.js";
export {
  SYS_ID_RE,
  TABLE_NAME_RE,
  artifactKey,
  isSysId,
  isTableName,
} from "./keys.js";
export {
  ABORTED_BEFORE_READ,
  createSnRecordReader,
  describeReadTruncation,
} from "./read.js";
export type {
  RecordReader,
  SnRecord,
  TableQueryRequest,
  TableRead,
} from "./read.js";
export {
  DEFAULT_ARTIFACT_TABLES,
  createScopeResolver,
  findScopeIdentity,
} from "./scope.js";
export type { ScopeIdentity, ScopeResolverOptions } from "./scope.js";
export {
  DEFAULT_UPDATE_SET_STORY_FIELD,
  createStoryResolver,
  parseUpdateXmlName,
} from "./story.js";
export type { StoryResolverOptions } from "./story.js";
export { completeArtifacts, isIncomplete } from "./types.js";
export type {
  ExplainingResolver,
  ResolutionLevel,
  ResolutionNote,
  ResolutionReport,
  SourceResolver,
} from "./types.js";
