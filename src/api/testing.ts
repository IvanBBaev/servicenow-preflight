/**
 * `servicenow-preflight/testing` — test doubles for checks: the in-memory
 * {@link createFakeSnClient} and the record/replay client.
 *
 * @packageDocumentation
 */
export { createFakeSnClient } from "../http/fake.js";
export type { FakeFixtures, ForcedFailure } from "../http/fake.js";
export {
  createReplayClient,
  type ReplayClientOptions,
} from "../fixtures/replay.js";
export {
  readRecording,
  RecordingError,
  type RecordingIndex,
} from "../fixtures/recording.js";
export type { ReplayInfo } from "../types.js";
