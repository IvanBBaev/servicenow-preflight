/**
 * @tessera/specs — the tests-as-code repo store, READ side (PLAN Phase 4).
 *
 * DESIGN §4 puts the source of truth for tests in the git repo: files next to
 * the synced source, projected onto an instance at run time. This package owns
 * the first half of that sentence. `readSpecInventory` walks a tests root,
 * reads `.manifest.json`, and answers what the repo DECLARES it intends to
 * test — spec identity, kind, and the QA-16 target list the coverage join runs
 * on. It never writes a repo and never touches an instance; the ATF projection
 * writer is the other half of Phase 4 and lives elsewhere.
 *
 * Two lines run through everything here.
 *
 * The DEV-1 line splits the two errors: `SpecInputError` says the path you
 * named is not a tests root (the fix is a different argument), while
 * `SpecStoreFaultError` says the registry is there and could not be turned
 * into an inventory. The second is a throw rather than an empty result on
 * purpose — OPP-1b's lesson carried from the Table API to the filesystem, and
 * the reasoning is written out over `SpecStoreFaultError`.
 *
 * The QA-8 line splits intent from coverage. Everything this package returns
 * is a statement about somebody's plan; only a run is a statement about the
 * code. `computeIntent` in `@tessera/impact` consumes the inventory and keeps
 * the same distinction in its wording, which is why these two packages speak
 * `@tessera/types` to each other and do not depend on one another.
 */

export { SpecInputError, SpecStoreFaultError } from "./errors.js";
export {
  KIND_SPEC_SUFFIXES,
  SPEC_FILE_SUFFIXES,
  readSpecInventory,
} from "./inventory.js";
export {
  PROPOSED_SPECS_DIRNAME,
  SPEC_MANIFEST_FILENAME,
  SPEC_MANIFEST_MAX_BYTES,
  SPEC_MANIFEST_VERSION,
} from "./types.js";
export type {
  InventoryNote,
  InventoryNoteLevel,
  ManifestSpecEntry,
  ReadInventoryOptions,
  SpecInventory,
  SpecManifest,
} from "./types.js";
