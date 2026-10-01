// @tessera/reporter — PLAN Phase 7, at its MVP scope.
//
// Three ADAPTERS of the `Reporter` port that @tessera/core already declares
// (`ports.ts`), plus the QA-11 run-id-keyed artifact directory the pipeline's
// `SEAM (QA-11)` comment points at. Nothing in `core` changes: this package
// only implements an interface core owns.
//
// The scope is fixed in three places that agree — PLAN Phase 7, DESIGN §12.2
// and §12.3 row 7: console + `--json`/JUnit, artifact directory stays, NO SSE
// and NO web dashboard. There is no stub for one here, deliberately: a stub
// would be a claim that the deferral is temporary in a way the design does not
// say it is.
//
// The exports are listed one by one rather than `export *`, so the public
// surface is a decision made here and not a side effect of what a module
// happened to export.

export { createArtifactStore } from "./artifacts.js";
export type {
  ArtifactJsonReadResult,
  ArtifactMalformed,
  ArtifactMissing,
  ArtifactReadOk,
  ArtifactReadResult,
  ArtifactRefInput,
  ArtifactStore,
  ArtifactStoreOptions,
  ArtifactUnreadable,
} from "./artifacts.js";

export {
  assertionsBySpec,
  causesBySpec,
  createEventCollector,
} from "./collect.js";
export type {
  CollectedError,
  CollectedFailure,
  CollectedRun,
  EventCollector,
  OutcomeCounts,
} from "./collect.js";

export {
  MAX_RENDERED_TEXT_LENGTH,
  createConsoleReporter,
  renderSummary,
  sanitizeLine,
} from "./consoleReporter.js";
export type { ConsoleReporterOptions } from "./consoleReporter.js";

export { buildJsonReport, createJsonReporter } from "./jsonReporter.js";
export type { JsonReport, JsonReporterOptions } from "./jsonReporter.js";

export {
  createJUnitReporter,
  escapeXml,
  renderJUnit,
} from "./junitReporter.js";
export type { JUnitReporterOptions } from "./junitReporter.js";
