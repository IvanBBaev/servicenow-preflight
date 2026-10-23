import assert from "node:assert/strict";

/**
 * Parse `--format json` output (the versioned envelope) and return the single
 * run's report, asserting the envelope shape on the way.
 */
export function reportOf(stdout) {
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.tool.name, "servicenow-preflight");
  assert.equal(envelope.runs.length, 1);
  return envelope.runs[0].report;
}
