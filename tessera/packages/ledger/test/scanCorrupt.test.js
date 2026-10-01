// `scan()` over a root holding corrupt run records (§4b startup scan).
//
// Delegated decision 2026-09-26: a corrupt record under the root stays a HARD
// STOP for `scan()` — nothing is auto-quarantined or renamed, because that
// would mutate evidence. What changed is that the stop is actionable: the
// error names every offending run id (bounded), the file, and why it would
// not decode, all in one go.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

import { LedgerError } from "../build/index.js";
import {
  RUN,
  createIntent,
  ledgerLogPath,
  newLedger,
  openProvisioning,
  reopen,
  runDirPath,
  runStatePath,
} from "./helpers.js";

function snapshotRuns(rootDir) {
  const out = {};
  const runs = `${rootDir}/runs`;
  for (const id of readdirSync(runs)) {
    for (const file of readdirSync(`${runs}/${id}`)) {
      out[`${id}/${file}`] = readFileSync(`${runs}/${id}/${file}`, "utf8");
    }
  }
  return out;
}

describe("scan() over corrupt run records", () => {
  it("collects EVERY corrupt record, with its id, path and reason", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-healthy");
    await openProvisioning(ledger, "run-notjson");
    await openProvisioning(ledger, "run-schema");
    await openProvisioning(ledger, "run-log");
    await ledger.intend(createIntent("run-log", "a"));
    await ledger.intend(createIntent("run-log", "b"));

    writeFileSync(runStatePath(rootDir, "run-notjson"), "{not json");
    writeFileSync(
      runStatePath(rootDir, "run-schema"),
      '{"runId":"run-schema"}',
    );
    // A run directory whose run.json names another run (a moved/edited file).
    mkdirSync(runDirPath(rootDir, "run-moved"), { recursive: true });
    writeFileSync(
      runStatePath(rootDir, "run-moved"),
      readFileSync(runStatePath(rootDir, "run-healthy"), "utf8"),
    );
    const logFile = ledgerLogPath(rootDir, "run-log");
    const lines = readFileSync(logFile, "utf8").split("\n");
    lines[0] = "{not json";
    writeFileSync(logFile, lines.join("\n"));
    const before = snapshotRuns(rootDir);

    await assert.rejects(reopen(rootDir).scan(), (error) => {
      assert.ok(error instanceof LedgerError);
      assert.equal(error.code, "corrupt");
      assert.deepEqual(
        error.corruptRecords.map((record) => record.runId),
        ["run-log", "run-moved", "run-notjson", "run-schema"],
        "scan must not stop at the first corrupt record",
      );
      assert.equal(error.corruptTotal, 4);
      const byId = Object.fromEntries(
        error.corruptRecords.map((record) => [record.runId, record]),
      );
      assert.equal(
        byId["run-notjson"].path,
        runStatePath(rootDir, "run-notjson"),
      );
      assert.equal(byId["run-log"].path, logFile);
      assert.match(byId["run-notjson"].reason, /not valid JSON/);
      assert.match(byId["run-schema"].reason, /not a valid run record/);
      assert.match(byId["run-moved"].reason, /belongs to run "run-healthy"/);
      for (const record of error.corruptRecords) {
        assert.ok(
          error.message.includes(record.runId),
          `the message must name ${record.runId}`,
        );
        assert.ok(
          error.message.includes(record.path),
          `the message must name ${record.path}`,
        );
      }
      assert.doesNotMatch(error.message, /run-healthy"?:/);
      return true;
    });

    assert.deepEqual(
      snapshotRuns(rootDir),
      before,
      "the hard stop must not quarantine, rename or rewrite anything",
    );
  });

  it("bounds the list at 20 and says how many more there are", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    for (let i = 0; i < 25; i += 1) {
      const runId = `run-${String(i).padStart(2, "0")}`;
      await ledger.openRun({ runId, ...RUN });
      writeFileSync(runStatePath(rootDir, runId), "garbage");
    }

    await assert.rejects(reopen(rootDir).scan(), (error) => {
      assert.equal(error.code, "corrupt");
      assert.equal(error.corruptRecords.length, 20);
      assert.equal(error.corruptTotal, 25);
      assert.equal(error.corruptRecords[19].runId, "run-19");
      assert.match(error.message, /25 corrupt/);
      assert.match(error.message, /5 more/);
      return true;
    });
  });

  it("still reads a healthy run by id while another record is corrupt", async (t) => {
    const { rootDir, ledger } = newLedger(t);
    await openProvisioning(ledger, "run-healthy");
    await openProvisioning(ledger, "run-bad");
    writeFileSync(runStatePath(rootDir, "run-bad"), "{");

    const restarted = reopen(rootDir);
    assert.equal(
      (await restarted.readRun("run-healthy")).state,
      "provisioning",
    );
    await assert.rejects(restarted.readRun("run-bad"), (error) => {
      assert.equal(error.code, "corrupt");
      assert.match(error.message, /not valid JSON/);
      return true;
    });
  });
});
