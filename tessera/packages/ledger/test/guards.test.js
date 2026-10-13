// Guards that only a JavaScript caller (or a hand-edited root) can reach:
// shapes the typed surface rules out, and directories under `runs/` that are
// not runs. Each refusal writes nothing; each foreign directory is passed over
// rather than read as a run — and an I/O failure is never mistaken for one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { AUDIT_KINDS, LedgerError } from "../build/index.js";
import {
  RUN,
  auditLogPath,
  createIntent,
  ledgerLogPath,
  newLedger,
  openProvisioning,
  runStatePath,
} from "./helpers.js";

function protocol(pattern) {
  return (error) =>
    error instanceof LedgerError &&
    error.code === "protocol" &&
    pattern.test(error.message);
}

describe("intend refuses a non-object target or compensation", () => {
  for (const [field, value, pattern] of [
    ["target", null, /^target is required and must be an object$/],
    ["target", "sys_user", /^target is required and must be an object$/],
    ["compensation", null, /^compensation is required and must be an object/],
    [
      "compensation",
      "delete",
      /^compensation is required and must be an object/,
    ],
  ]) {
    it(`${field}=${JSON.stringify(value)}`, async (t) => {
      const { rootDir, ledger } = newLedger(t);
      await openProvisioning(ledger, "run-1");
      await assert.rejects(
        ledger.intend(createIntent("run-1", "k1", { [field]: value })),
        protocol(pattern),
      );
      assert.equal(existsSync(ledgerLogPath(rootDir, "run-1")), false);
      assert.deepEqual(await ledger.entries("run-1"), []);
    });
  }
});

describe("appendAudit refuses a kind outside the audit vocabulary", () => {
  it("names the kind and the vocabulary, and appends nothing", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    const input = { kind: "token-minted", runId: "run-1", verdictHash: "h1" };
    const message = `unknown audit kind "token-minted"; the audit vocabulary is ${AUDIT_KINDS.join(", ")}`;
    const refused = (error) =>
      protocol(/^/)(error) && error.message === message;
    await assert.rejects(ledger.appendAudit(input), refused);
    assert.throws(() => ledger.appendAuditSync(input), refused);
    assert.equal(existsSync(auditLogPath(rootDir)), false);
  });
});

describe("runs/ entries that are not runs", () => {
  it("are passed over by listRuns and scan", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-1");
    for (const name of ["Upper-Case", ".hidden", "-dash-first"]) {
      // Holding a real run's state: only the id check keeps it out.
      mkdirSync(join(rootDir, "runs", name));
      copyFileSync(
        runStatePath(rootDir, "run-1"),
        join(rootDir, "runs", name, "run.json"),
      );
    }
    assert.deepEqual(
      (await ledger.listRuns()).map((run) => run.runId),
      ["run-1"],
    );
    assert.deepEqual(
      (await ledger.scan()).map((row) => row.run.runId),
      ["run-1"],
    );
  });

  it("a run.json that cannot be read stops scan with the I/O error, not corrupt", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await ledger.openRun({ runId: "run-1", ...RUN });
    mkdirSync(join(rootDir, "runs", "run-2"));
    mkdirSync(runStatePath(rootDir, "run-2"));
    await assert.rejects(
      ledger.scan(),
      (error) => error.code === "EISDIR" && !(error instanceof LedgerError),
    );
    assert.equal(
      JSON.parse(readFileSync(runStatePath(rootDir, "run-1"), "utf8")).runId,
      "run-1",
    );
  });
});
