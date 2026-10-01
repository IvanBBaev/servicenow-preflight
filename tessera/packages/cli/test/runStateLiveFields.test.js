// `tess status` / `tess confirm` over a persisted `tess run --live` result
// that carries the completeness fields: `inventoryIncomplete`,
// `verdictReason` and `artifactTablesRefused` (wave 16).
//
// Before wave 16 both commands dropped all three, so a consumer asking "why
// is this run not GO?" got an INCONCLUSIVE verdict with no reason from the very
// commands that exist to answer from disk. The fields are ADDITIVE and emitted
// only when the persisted record has them (field names match `LiveRunRecord`,
// which is also what `tess run --live --json` and the MCP relay print):
//
//   * `inventoryIncomplete` — whenever the record has it as a boolean (every
//     record written since the field exists), `false` included, exactly as
//     `tess run --live --json` prints it; an older record without it prints
//     nothing rather than a synthesized `false` (that would claim a
//     completeness nobody checked).
//   * `verdictReason`, `artifactTablesRefused` — only when present.
//
// The records are written straight through the ledger's run event log, so
// this file pins the read side alone: no instance, no `fetch` at all.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createIntentLedger, createRunEventLog } from "@tessera/ledger";

import { EXIT_CODES, LIVE_RESULT_KIND, main } from "../build/index.js";

const RUN_ID = "run-state-fields-0001";
const NOW = () => new Date("2026-09-30T10:00:00.000Z");

const roots = [];
after(async () => {
  await Promise.all(
    roots.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const INCONCLUSIVE_VERDICT = {
  status: "INCONCLUSIVE",
  counts: { pass: 1, fail: 0, missing: 0, inconclusive: 0, blocking: 0 },
  rows: [],
  overrides: [],
};

const REASON =
  "impact lookup is incomplete: 1 artifact table(s) refused a lookup read";
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REFUSED = [
  { table: "sys_script", reason: "read refused (403)" },
  {
    table: "sys_script_include",
    reason: "read refused (403)",
    read: "lookup",
  },
];

/** A persisted live record; `extra` adds (or, with `undefined`, removes) fields. */
function record(extra = {}) {
  const base = {
    kind: LIVE_RESULT_KIND,
    runId: RUN_ID,
    exitCode: EXIT_CODES.inconclusive,
    state: "done",
    teardown: "completed",
    verdict: INCONCLUSIVE_VERDICT,
    result: {},
    planned: 1,
    inventoryIncomplete: true,
    verdictReason: REASON,
    artifactTablesRefused: REFUSED,
    failures: [],
    ...extra,
  };
  return JSON.parse(JSON.stringify(base));
}

async function harness(persisted) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-rs-fields-"));
  roots.push(root);
  const ledgerRoot = path.join(root, ".tessera");
  await createIntentLedger({ rootDir: ledgerRoot, now: NOW }).openRun({
    runId: RUN_ID,
    scope: "x_tessera_live",
    runner: "runner",
    lifecycle: "ephemeral",
  });
  await createRunEventLog({ rootDir: ledgerRoot, now: NOW }).writeResult(
    RUN_ID,
    persisted,
  );
  let out = [];
  let err = [];
  const context = {
    now: NOW,
    actor: "test",
    cwd: root,
    env: {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return {
    async run(argv) {
      out = [];
      err = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = () =>
        Promise.reject(new Error("status/confirm must not touch the network"));
      try {
        const code = await main(argv, context);
        return { code, out: out.join("\n"), err: err.join("\n") };
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  };
}

const statusJson = async (h) => {
  const r = await h.run(["status", "--run-id", RUN_ID, "--json"]);
  assert.equal(r.code, EXIT_CODES.ok, r.err);
  return JSON.parse(r.out).result;
};
const confirmJson = async (h, code = EXIT_CODES.inconclusive) => {
  const r = await h.run(["confirm", "--run-id", RUN_ID, "--json"]);
  assert.equal(r.code, code, r.err);
  return JSON.parse(r.out);
};

describe("tess status / confirm — the persisted completeness fields", () => {
  it("status --json carries all three inside `result`", async () => {
    const h = await harness(record());
    const result = await statusJson(h);
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.equal(result.exitCode, EXIT_CODES.inconclusive);
    assert.equal(result.inventoryIncomplete, true);
    assert.equal(result.verdictReason, REASON);
    assert.deepEqual(result.artifactTablesRefused, REFUSED);
  });

  it("confirm --json carries all three at the top level", async () => {
    const h = await harness(record());
    const doc = await confirmJson(h);
    assert.equal(doc.verdict.status, "INCONCLUSIVE");
    assert.equal(doc.inventoryIncomplete, true);
    assert.equal(doc.verdictReason, REASON);
    assert.deepEqual(doc.artifactTablesRefused, REFUSED);
  });

  it("a clean record prints inventoryIncomplete: false and omits the rest", async () => {
    const h = await harness(
      record({
        exitCode: EXIT_CODES.ok,
        verdict: { ...INCONCLUSIVE_VERDICT, status: "GO" },
        inventoryIncomplete: false,
        verdictReason: undefined,
        artifactTablesRefused: undefined,
      }),
    );
    const result = await statusJson(h);
    assert.equal(result.inventoryIncomplete, false);
    assert.equal("verdictReason" in result, false);
    assert.equal("artifactTablesRefused" in result, false);
    const doc = await confirmJson(h, EXIT_CODES.ok);
    assert.equal(doc.inventoryIncomplete, false);
    assert.equal("verdictReason" in doc, false);
    assert.equal("artifactTablesRefused" in doc, false);
  });

  it("an older record without the fields prints none of them (never a synthesized false)", async () => {
    const h = await harness(
      record({
        inventoryIncomplete: undefined,
        verdictReason: undefined,
        artifactTablesRefused: undefined,
      }),
    );
    const result = await statusJson(h);
    assert.deepEqual(Object.keys(result).sort(), [
      "exitCode",
      "teardown",
      "verdict",
    ]);
    const doc = await confirmJson(h);
    assert.deepEqual(Object.keys(doc).sort(), [
      "exitCode",
      "failures",
      "persistedAt",
      "runId",
      "state",
      "verdict",
    ]);
  });

  it("a malformed field is not relayed (fail closed on the shape)", async () => {
    const h = await harness(
      record({
        inventoryIncomplete: "yes",
        verdictReason: 42,
        artifactTablesRefused: "sys_script",
      }),
    );
    const result = await statusJson(h);
    assert.equal("inventoryIncomplete" in result, false);
    assert.equal("verdictReason" in result, false);
    assert.equal("artifactTablesRefused" in result, false);
  });

  it("status prints the reason and the incompleteness in human output", async () => {
    const h = await harness(record());
    const r = await h.run(["status", "--run-id", RUN_ID]);
    assert.equal(r.code, EXIT_CODES.ok, r.err);
    assert.match(r.out, /result: {3}INCONCLUSIVE, exit 5/);
    assert.match(r.out, new RegExp(`reason: +${escapeRe(REASON)}`));
    assert.match(r.out, /inventory: INCOMPLETE/);
    assert.match(
      r.out,
      /artifacts: INCOMPLETE — 1 artifact table\(s\) not read in full/,
    );
    assert.match(r.out, /- sys_script: read refused \(403\)/);
    assert.match(
      r.out,
      /lookups: INCOMPLETE — 1 artifact table\(s\) refused an impact lookup read/,
    );
    assert.match(r.out, /- sys_script_include: read refused \(403\)/);
  });

  it("confirm prints the reason and the incompleteness in human output", async () => {
    const h = await harness(record());
    const r = await h.run(["confirm", "--run-id", RUN_ID]);
    assert.equal(r.code, EXIT_CODES.inconclusive, r.err);
    assert.match(r.out, /VERDICT: INCONCLUSIVE\n {2}reason: /);
    assert.match(r.out, new RegExp(`reason: ${escapeRe(REASON)}`));
    assert.match(r.out, /inventory: INCOMPLETE/);
    assert.match(r.out, /artifacts: INCOMPLETE — 1 artifact table\(s\)/);
    assert.match(r.out, /lookups: INCOMPLETE — 1 artifact table\(s\)/);
  });

  it("human output of a clean record adds no completeness lines", async () => {
    const h = await harness(
      record({
        exitCode: EXIT_CODES.ok,
        verdict: { ...INCONCLUSIVE_VERDICT, status: "GO" },
        inventoryIncomplete: false,
        verdictReason: undefined,
        artifactTablesRefused: undefined,
      }),
    );
    for (const command of ["status", "confirm"]) {
      const r = await h.run([command, "--run-id", RUN_ID]);
      assert.doesNotMatch(r.out, /INCOMPLETE|reason:/, `${command}: ${r.out}`);
    }
  });
});
