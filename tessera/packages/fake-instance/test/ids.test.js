// QA-18 — determinism of identity and time. A Tier-2 job that replays
// deterministically cannot mint ids from Math.random() or read the wall clock.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LOGICAL_EPOCH_MS,
  SYS_ID_LENGTH,
  createIdGenerator,
  createLogicalClock,
  deriveSysId,
  formatSnDateTime,
} from "../build/index.js";

describe("createIdGenerator", () => {
  it("mints 32-hex sys_ids", () => {
    const id = createIdGenerator("s").next("sys_atf_test");
    assert.equal(id.length, SYS_ID_LENGTH);
    assert.match(id, /^[0-9a-f]{32}$/);
  });

  it("is reproducible across generators with the same seed", () => {
    const a = createIdGenerator("tier2");
    const b = createIdGenerator("tier2");
    const first = [a.next("t"), a.next("t"), a.next("u")];
    const second = [b.next("t"), b.next("t"), b.next("u")];
    assert.deepEqual(first, second);
  });

  it("gives different seeds different ids", () => {
    assert.notEqual(
      createIdGenerator("one").next("t"),
      createIdGenerator("two").next("t"),
    );
  });

  it("never repeats an id for the same table", () => {
    const gen = createIdGenerator("tier2");
    const ids = new Set();
    for (let i = 0; i < 500; i += 1) ids.add(gen.next("sys_atf_test"));
    assert.equal(ids.size, 500);
  });

  it("keeps ordinals per table, so an unrelated insert cannot shift ids", () => {
    const a = createIdGenerator("tier2");
    const b = createIdGenerator("tier2");
    a.next("other");
    a.next("other");
    assert.equal(a.next("wanted"), b.next("wanted"));
    assert.equal(a.count("other"), 2);
    assert.equal(a.count("wanted"), 1);
    assert.equal(a.count("never-used"), 0);
  });

  it("resets its ordinals", () => {
    const gen = createIdGenerator("tier2");
    const first = gen.next("t");
    gen.next("t");
    gen.reset();
    assert.equal(gen.next("t"), first);
  });

  it("derives a stable id from an opaque key", () => {
    assert.equal(deriveSysId("abc"), deriveSysId("abc"));
    assert.notEqual(deriveSysId("abc"), deriveSysId("abd"));
  });
});

describe("createLogicalClock", () => {
  it("starts at the logical epoch and advances one step per read", () => {
    const clock = createLogicalClock();
    assert.equal(clock.now(), "2020-01-01 00:00:00");
    assert.equal(clock.now(), "2020-01-01 00:00:01");
    assert.equal(clock.ticks(), 2);
  });

  it("honours an explicit start and step", () => {
    const clock = createLogicalClock(LOGICAL_EPOCH_MS, 60_000);
    assert.equal(clock.now(), "2020-01-01 00:00:00");
    assert.equal(clock.now(), "2020-01-01 00:01:00");
  });

  it("resets to the start", () => {
    const clock = createLogicalClock();
    clock.now();
    clock.now();
    clock.reset();
    assert.equal(clock.now(), "2020-01-01 00:00:00");
  });

  it("formats in the Table API's datetime shape", () => {
    assert.equal(formatSnDateTime(LOGICAL_EPOCH_MS), "2020-01-01 00:00:00");
  });
});
