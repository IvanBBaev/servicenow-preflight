// The filesystem primitives the §4b guarantees rest on. These are tested
// directly (not only through the ledger) because "the intent is durable before
// the write leaves the process" is a property of THESE functions.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  appendLineDurable,
  ensureDir,
  listDirectories,
  readLogLines,
  readTextFile,
  repairLogTail,
  writeJsonAtomic,
} from "../build/durability.js";
import { tempRoot } from "./helpers.js";

describe("appendLineDurable", () => {
  it("creates the log and terminates every record with a newline", async (t) => {
    const root = tempRoot(t);
    const file = join(root, "log.jsonl");

    await appendLineDurable(file, '{"a":1}');
    await appendLineDurable(file, '{"a":2}');

    assert.equal(readFileSync(file, "utf8"), '{"a":1}\n{"a":2}\n');
  });

  it("is durable on return — the bytes are readable by another handle", async (t) => {
    const root = tempRoot(t);
    const file = join(root, "log.jsonl");

    await appendLineDurable(file, '{"intent":"create"}');

    // Nothing is buffered in the process: a crash here still leaves the record.
    assert.match(readFileSync(file, "utf8"), /"intent":"create"/);
  });
});

describe("readLogLines", () => {
  it("returns nothing for a missing or empty log", async (t) => {
    const root = tempRoot(t);
    assert.deepEqual(await readLogLines(join(root, "missing.jsonl")), {
      lines: [],
      torn: false,
    });

    const empty = join(root, "empty.jsonl");
    writeFileSync(empty, "");
    assert.deepEqual(await readLogLines(empty), { lines: [], torn: false });
  });

  it("drops an uncommitted tail and reports it as torn", async (t) => {
    const root = tempRoot(t);
    const file = join(root, "log.jsonl");
    writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3');

    const read = await readLogLines(file);

    assert.deepEqual(read.lines, ['{"a":1}', '{"a":2}']);
    assert.equal(read.torn, true);
  });

  it("keeps every committed record when the log ends cleanly", async (t) => {
    const root = tempRoot(t);
    const file = join(root, "log.jsonl");
    writeFileSync(file, '{"a":1}\n{"a":2}\n');

    const read = await readLogLines(file);

    assert.deepEqual(read.lines, ['{"a":1}', '{"a":2}']);
    assert.equal(read.torn, false);
  });
});

describe("repairLogTail", () => {
  it("leaves a clean log untouched", async (t) => {
    const root = tempRoot(t);
    const file = join(root, "log.jsonl");
    writeFileSync(file, '{"a":1}\n');

    assert.equal(await repairLogTail(file), false);
    assert.equal(readFileSync(file, "utf8"), '{"a":1}\n');
  });

  it("truncates a torn tail so the next append lands on a record boundary", async (t) => {
    const root = tempRoot(t);
    const file = join(root, "log.jsonl");
    writeFileSync(file, '{"a":1}\n{"a":2');

    assert.equal(await repairLogTail(file), true);
    assert.equal(readFileSync(file, "utf8"), '{"a":1}\n');

    await appendLineDurable(file, '{"a":3}');
    assert.equal(readFileSync(file, "utf8"), '{"a":1}\n{"a":3}\n');
  });

  it("truncates a newline-terminated but unparsable tail (crash zero-fill)", async (t) => {
    const root = tempRoot(t);
    const file = join(root, "log.jsonl");
    writeFileSync(file, '{"a":1}\n');
    appendFileSync(file, Buffer.from([0, 0, 0, 0, 0x0a]));

    assert.equal(await repairLogTail(file), true);
    assert.equal(readFileSync(file, "utf8"), '{"a":1}\n');
  });

  it("empties a log whose single record was never committed", async (t) => {
    const root = tempRoot(t);
    const file = join(root, "log.jsonl");
    writeFileSync(file, '{"a":1');

    assert.equal(await repairLogTail(file), true);
    assert.equal(readFileSync(file, "utf8"), "");
  });

  it("is a no-op on a missing or empty log", async (t) => {
    const root = tempRoot(t);
    assert.equal(await repairLogTail(join(root, "missing.jsonl")), false);

    const empty = join(root, "empty.jsonl");
    writeFileSync(empty, "");
    assert.equal(await repairLogTail(empty), false);
  });

  it("never removes a committed record", async (t) => {
    const root = tempRoot(t);
    const file = join(root, "log.jsonl");
    const committed = '{"a":1}\n{"b":2}\n{"c":3}\n';
    writeFileSync(file, committed);

    await repairLogTail(file);

    assert.equal(readFileSync(file, "utf8"), committed);
  });
});

describe("writeJsonAtomic", () => {
  it("writes, replaces, and leaves no temp files behind", async (t) => {
    const root = tempRoot(t);
    const file = join(root, "state.json");

    await writeJsonAtomic(file, { state: "planned" });
    await writeJsonAtomic(file, { state: "provisioning" });

    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      state: "provisioning",
    });
    assert.deepEqual(readdirSync(root), ["state.json"]);
  });
});

describe("readTextFile / ensureDir / listDirectories", () => {
  it("reports a missing file as undefined rather than throwing", async (t) => {
    const root = tempRoot(t);
    assert.equal(await readTextFile(join(root, "nope.json")), undefined);
  });

  it("creates nested directories idempotently", async (t) => {
    const root = tempRoot(t);
    const dir = join(root, "runs", "run-1");

    await ensureDir(dir);
    await ensureDir(dir);

    assert.deepEqual(await listDirectories(join(root, "runs")), ["run-1"]);
  });

  it("lists only directories, and nothing for a missing one", async (t) => {
    const root = tempRoot(t);
    await ensureDir(join(root, "runs", "run-a"));
    writeFileSync(join(root, "runs", "stray.json"), "{}");

    assert.deepEqual(await listDirectories(join(root, "runs")), ["run-a"]);
    assert.deepEqual(await listDirectories(join(root, "absent")), []);
  });
});
