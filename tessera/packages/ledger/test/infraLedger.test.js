// The per-instance standing-infra ledger `<root>/infra/<host>/` — delegated
// decision 2026-09-23. Keyed on `planHash`, never on a run id, with the §4b
// idempotency dedupe scoped to the HOST: a retry from a new process (a reopen)
// or a concurrent process must find the entry the first one made.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  INFRA_DIRNAME,
  INFRA_LEDGER_FILENAME,
  LedgerError,
  createInfraLedger,
} from "../build/index.js";
import { tempRoot } from "./helpers.js";

const run = promisify(execFile);
const HOST = "dev12345.service-now.com";
const PLAN = "a".repeat(64);
const OTHER_PLAN = "b".repeat(64);
const NOW = () => new Date("2026-09-23T00:00:00.000Z");

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof LedgerError, `not a LedgerError: ${error}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}`);
    return true;
  };
}

function infraIntent(key, overrides = {}) {
  return {
    planHash: PLAN,
    intent: "enable sn_atf.runner.enabled (DR-3)",
    target: { table: "sys_properties", sysId: "p1" },
    compensation: {
      op: "restore",
      table: "sys_properties",
      sysId: "p1",
      fields: { value: "false" },
    },
    idempotencyKey: key,
    ...overrides,
  };
}

function open(rootDir, host = HOST) {
  return createInfraLedger({ rootDir, host, now: NOW });
}

function logPath(rootDir, host = HOST) {
  return join(rootDir, INFRA_DIRNAME, host, INFRA_LEDGER_FILENAME);
}

describe("infra ledger — round trip", () => {
  it("writes LedgerInfraWriteRecords under <root>/infra/<host>/ and reads them back", async (t) => {
    const rootDir = tempRoot(t);
    const infra = open(rootDir);
    assert.equal(infra.host, HOST);

    const intended = await infra.intend(infraIntent("k-1"));
    assert.equal(intended.kind, "infra-write");
    assert.equal(intended.state, "intended");
    assert.equal(intended.seq, 1);
    assert.equal(intended.host, HOST);
    assert.equal(intended.planHash, PLAN);
    assert.equal(intended.idempotencyKey, "k-1");
    assert.equal(intended.intendedAt, "2026-09-23T00:00:00.000Z");
    assert.equal("runId" in intended, false, "infra records carry no run id");
    assert.ok(existsSync(logPath(rootDir)));

    const applied = await infra.confirm(1);
    assert.equal(applied.state, "applied");
    const second = await infra.intend(
      infraIntent("k-2", {
        planHash: OTHER_PLAN,
        target: { table: "sys_properties" },
        compensation: { op: "delete", table: "sys_properties" },
        probe: {
          table: "sys_properties",
          query: "name=x_tess.flag",
          key: "natural-key",
        },
      }),
    );
    assert.equal(second.seq, 2);
    const compensated = await infra.compensate(1);
    assert.equal(compensated.state, "compensated");

    const reread = await open(rootDir).entries();
    assert.deepEqual(
      reread.map((e) => [e.seq, e.state, e.planHash]),
      [
        [1, "compensated", PLAN],
        [2, "intended", OTHER_PLAN],
      ],
    );
    assert.deepEqual(
      (await infra.entries({ planHash: OTHER_PLAN })).map((e) => e.seq),
      [2],
    );
    assert.equal((await infra.findByIdempotencyKey("k-2"))?.seq, 2);
    assert.equal(await infra.findByIdempotencyKey("nope"), undefined);
  });

  it("refuses to confirm a create without its sys_id (§4b step 3)", async (t) => {
    const infra = open(tempRoot(t));
    await infra.intend(
      infraIntent("k-create", {
        target: { table: "sys_properties" },
        compensation: { op: "delete", table: "sys_properties" },
        probe: {
          table: "sys_properties",
          query: "name=x_tess.flag",
          key: "natural-key",
        },
      }),
    );
    await assert.rejects(infra.confirm(1), expectCode("protocol"));
    const applied = await infra.confirm(1, { sysId: "new1" });
    assert.equal(applied.target.sysId, "new1");
  });

  it("keeps hosts apart", async (t) => {
    const rootDir = tempRoot(t);
    await open(rootDir).intend(infraIntent("k-1"));
    const other = open(rootDir, "dev99999.service-now.com");
    assert.deepEqual(await other.entries(), []);
    const intended = await other.intend(infraIntent("k-1"));
    assert.equal(intended.seq, 1, "the dedupe is host-scoped, not global");
  });

  it("refuses a host that is not a bare hostname", (t) => {
    const rootDir = tempRoot(t);
    for (const host of [
      "",
      "..",
      "a/../b",
      "https://dev1.service-now.com",
      "dev1.service-now.com:443",
      "-dev1",
    ]) {
      assert.throws(() => open(rootDir, host), expectCode("invalid-host"));
    }
  });

  it("refuses a record from another host as corrupt", async (t) => {
    const rootDir = tempRoot(t);
    const infra = open(rootDir);
    await infra.intend(infraIntent("k-1"));
    const [line] = readFileSync(logPath(rootDir), "utf8").split("\n");
    const foreign = { ...JSON.parse(line), host: "elsewhere", seq: 2 };
    appendFileSync(logPath(rootDir), `${JSON.stringify(foreign)}\n`);
    await assert.rejects(open(rootDir).entries(), expectCode("corrupt"));
    await assert.rejects(
      infra.intend(infraIntent("k-3")),
      expectCode("corrupt"),
      "nothing is appended on top of a damaged namespace",
    );
  });
});

describe("infra ledger — host-scoped idempotency dedupe", () => {
  it("returns the durable entry to a retry after reopen, without a second line", async (t) => {
    const rootDir = tempRoot(t);
    const first = await open(rootDir).intend(infraIntent("k-1"));

    // A new ledger instance over the same root: a restarted process.
    const retry = await open(rootDir).intend(infraIntent("k-1"));

    assert.deepEqual(retry, first);
    assert.equal(
      readFileSync(logPath(rootDir), "utf8").trim().split("\n").length,
      1,
      "the retry must not append",
    );
  });

  it("refuses one key naming writes of two different plans", async (t) => {
    const rootDir = tempRoot(t);
    await open(rootDir).intend(infraIntent("k-1"));
    await assert.rejects(
      open(rootDir).intend(infraIntent("k-1", { planHash: OTHER_PLAN })),
      expectCode("protocol"),
    );
  });

  it("dedupes across concurrent processes: one entry per key, gap-free seqs", async (t) => {
    const rootDir = tempRoot(t);
    const entry = fileURLToPath(new URL("../build/index.js", import.meta.url));
    const script = `
      const { createInfraLedger } = await import(${JSON.stringify(entry)});
      const infra = createInfraLedger({ rootDir: process.argv[1], host: ${JSON.stringify(HOST)} });
      for (let i = 0; i < 8; i += 1) {
        await infra.intend({
          planHash: ${JSON.stringify(PLAN)},
          intent: "shared write " + i,
          target: { table: "sys_properties", sysId: "p" + i },
          compensation: { op: "restore", table: "sys_properties", sysId: "p" + i, fields: { value: "x" } },
          idempotencyKey: "shared-" + i,
        });
      }
    `;
    await Promise.all(
      [0, 1, 2].map(() =>
        run(process.execPath, ["--input-type=module", "-e", script, rootDir]),
      ),
    );

    const entries = await open(rootDir).entries();
    assert.equal(entries.length, 8, "three processes, eight distinct keys");
    assert.deepEqual(
      entries.map((e) => e.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(new Set(entries.map((e) => e.idempotencyKey)).size, 8);
    assert.equal(
      existsSync(join(rootDir, INFRA_DIRNAME, HOST, ".lock")),
      false,
      "every process released the lock",
    );
  });
});
