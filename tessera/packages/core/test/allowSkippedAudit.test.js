// The `allow-skipped` audit producer — delegated decision 2026-09-23,
// TODO~175. It reads the ACCEPTED override off a resolved verdict and writes
// the ledger's `allow-skipped` record; these drive the REAL intent ledger so a
// payload the producer builds and the ledger refuses cannot pass here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createIntentLedger } from "@tessera/ledger";

import { allowSkippedAuditInput, recordAllowSkipped } from "../build/index.js";

function row(id, raw, overridden) {
  return {
    spec: { id, path: `tests/${id}.test.ts` },
    kind: "unit",
    target: { table: "sys_script", sysId: id, name: id },
    raw,
    status: raw === "pass" ? "pass" : "inconclusive",
    blocking: false,
    overridden,
  };
}

/** Only the fields the producer reads, shaped as the reducer emits them. */
function verdict(overrides) {
  return {
    status: "GO",
    runId: "run-allow",
    rows: [
      row("spec-a", "skipped", true),
      row("spec-b", "pass", false),
      row("spec-c", "skipped", true),
    ],
    overrides,
  };
}

const APPLIED = [{ flag: "allow-skipped", affectedRows: 2, actor: "ivan" }];

function tempLedger(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-core-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return createIntentLedger({
    rootDir,
    now: () => new Date("2026-09-23T00:00:00.000Z"),
  });
}

describe("allowSkippedAuditInput", () => {
  it("returns undefined when the verdict carries no allow-skipped override", () => {
    assert.equal(
      allowSkippedAuditInput(verdict([]), { surface: "cli" }),
      undefined,
    );
  });

  it("builds the ledger payload from the verdict, not from the caller", () => {
    const input = allowSkippedAuditInput(verdict(APPLIED), {
      surface: "cli",
    });
    assert.deepEqual(input, {
      kind: "allow-skipped",
      runId: "run-allow",
      actor: "ivan",
      surface: "cli",
      affectedRows: 2,
      specs: [
        { id: "spec-a", path: "tests/spec-a.test.ts" },
        { id: "spec-c", path: "tests/spec-c.test.ts" },
      ],
      verdictStatus: "GO",
    });
  });

  it("lets the surface name the actor and stamp the time", () => {
    const input = allowSkippedAuditInput(verdict(APPLIED), {
      surface: "mcp",
      actor: "client-7",
      at: "2026-09-23T12:00:00.000Z",
    });
    assert.equal(input.actor, "client-7");
    assert.equal(input.at, "2026-09-23T12:00:00.000Z");
  });
});

describe("recordAllowSkipped", () => {
  it("appends the record and reads it back from the real ledger", async (t) => {
    const ledger = tempLedger(t);
    const written = await recordAllowSkipped(ledger, verdict(APPLIED), {
      surface: "cli",
    });
    const [read] = await ledger.readAudit();
    assert.deepEqual(read, written);
    assert.equal(read.kind, "allow-skipped");
    assert.equal(read.affectedRows, 2);
  });

  it("writes nothing when there is no override", async (t) => {
    const ledger = tempLedger(t);
    assert.equal(
      await recordAllowSkipped(ledger, verdict([]), { surface: "cli" }),
      undefined,
    );
    assert.deepEqual(await ledger.readAudit(), []);
  });

  it("fails closed on a verdict whose count disagrees with its rows", async (t) => {
    const ledger = tempLedger(t);
    await assert.rejects(
      recordAllowSkipped(
        ledger,
        verdict([{ flag: "allow-skipped", affectedRows: 5, actor: "ivan" }]),
        { surface: "cli" },
      ),
      (error) => error.code === "protocol",
    );
    assert.deepEqual(await ledger.readAudit(), []);
  });
});
