// The `allow-skipped` audit kind — delegated decision 2026-09-23, TODO~175.
// The writer and the reader validate the same payload, so a record the writer
// accepts is always one the reader decodes (see the ClosedVocabulary guard in
// types.ts), and a self-contradicting record fails at the write.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

import { AUDIT_KINDS, LedgerError } from "../build/index.js";
import { acknowledgeProd, auditLogPath, newLedger } from "./helpers.js";

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof LedgerError, `not a LedgerError: ${error}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}`);
    return true;
  };
}

function allowSkipped(runId, overrides = {}) {
  return {
    kind: "allow-skipped",
    runId,
    actor: "ivan",
    surface: "cli",
    affectedRows: 2,
    specs: [
      { id: "spec-a", path: "tests/a.test.ts" },
      { id: "spec-b", path: "tests/b.test.ts" },
    ],
    verdictStatus: "GO",
    ...overrides,
  };
}

describe("audit log — allow-skipped", () => {
  it("is in the reader's accept-list", () => {
    assert.ok(AUDIT_KINDS.includes("allow-skipped"));
  });

  it("round-trips every field", async (t) => {
    const { ledger } = newLedger(t);
    const input = allowSkipped("run-1");
    const written = await ledger.appendAudit(input);
    const [read] = await ledger.readAudit();
    assert.deepEqual(read, written);
    assert.deepEqual(
      Object.keys(read).sort(),
      [...Object.keys(input), "at"].sort(),
    );
    assert.deepEqual(read.specs, input.specs);
  });

  it("records an override that flipped nothing", async (t) => {
    const { ledger } = newLedger(t);
    await ledger.appendAudit(
      allowSkipped("run-1", { affectedRows: 0, specs: [] }),
    );
    const [read] = await ledger.readAudit();
    assert.equal(read.affectedRows, 0);
  });

  for (const [name, overrides] of [
    ["a count that disagrees with the specs", { affectedRows: 3 }],
    ["a negative count", { affectedRows: -1, specs: [] }],
    ["a fractional count", { affectedRows: 1.5 }],
    ["a missing surface", { surface: undefined }],
    ["an empty actor", { actor: "" }],
    ["a missing verdict status", { verdictStatus: undefined }],
    ["specs that are not an array", { specs: "spec-a" }],
    ["a spec without a path", { specs: [{ id: "a" }, { id: "b", path: "p" }] }],
  ]) {
    it(`refuses ${name} at the write`, async (t) => {
      const { ledger } = newLedger(t);
      await assert.rejects(
        ledger.appendAudit(allowSkipped("run-1", overrides)),
        expectCode("protocol"),
      );
      assert.deepEqual(await ledger.readAudit(), []);
    });
  }

  it("refuses a hand-written mid-log line whose count disagrees as corrupt", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await ledger.appendAudit(acknowledgeProd("run-1"));
    appendFileSync(
      auditLogPath(rootDir),
      `${JSON.stringify({ ...allowSkipped("run-1", { affectedRows: 5 }), at: "2026-07-01T00:00:00.000Z" })}\n`,
    );
    await ledger.appendAudit(allowSkipped("run-1"));
    await assert.rejects(ledger.readAudit(), expectCode("corrupt"));
  });
});
