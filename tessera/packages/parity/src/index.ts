// @tessera/parity — ARCH-20 code-version parity (PLAN Phase 1).
//
// Tessera resolves what changed on the SOURCE instance and runs the suite on
// the RUNNER. This stage proves the runner actually carries those artifacts at
// the version that was tested, by comparing a SHA-256 of their executable
// fields on both sides. A mismatch is a hard preflight failure; a read nobody
// could decide is fail-closed and leads to an `inconclusive` verdict, never to
// a green one (ARCH-28/DEV-17).
//
// Read-only, and remedy-free by design: ARCH-20 says Tessera never deploys
// source -> runner itself, so the report is advice for a human, not a plan.

export type {
  ParityCheck,
  ParityOutcome,
  ParityReport,
  ParityRequest,
  ParityRow,
  ParityStatus,
  ParityTopology,
} from "./types.js";
export { ParityContractError } from "./errors.js";
export {
  EXECUTABLE_FIELDS_BY_TABLE,
  SCRIPT_FIELDS_BY_TABLE,
  comparableTables,
  digestFieldReads,
  executableFieldsFor,
  fingerprint,
  fingerprintRecord,
  readExecutableFields,
  relatedFor,
  scriptFieldsFor,
  uncomparedFor,
} from "./fingerprint.js";
export type {
  ExecutableFieldKind,
  FieldRead,
  FingerprintResult,
  RelatedSpec,
} from "./fingerprint.js";
export {
  ABORTED_BEFORE_READ,
  RELATED_ROW_LIMIT,
  createSnArtifactReader,
} from "./reader.js";
export type {
  ArtifactRead,
  ArtifactReader,
  InstanceHost,
  RelatedRowsRead,
  RelatedRowsRequest,
} from "./reader.js";
export {
  createParityCheck,
  formatParityReport,
  rollUpParity,
} from "./parity.js";
