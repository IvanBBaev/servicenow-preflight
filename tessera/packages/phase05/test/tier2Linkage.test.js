// runner-atf F1: every `sys_atf_test_result` row the tier-2 engine writes must
// carry `test_suite_result` = THIS execution's `sys_atf_test_suite_result`
// sys_id (the terminal payload's `links.results.id`), and the engine must
// refuse to write rows it cannot link.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "@tessera/fake-instance";

import { createAtfExecutionEngine } from "../build/tier2.js";

const HOST = "dev-skeleton.service-now.com";
const SUITE = "0000000000000000000000000000aaa1";
const TEST_A = "0000000000000000000000000000bbb1";
const TEST_B = "0000000000000000000000000000bbb2";

function seeded() {
  return createFakeInstance({
    host: HOST,
    state: {
      sys_atf_test_suite: [{ sys_id: SUITE, name: "suite" }],
      sys_atf_test: [
        { sys_id: TEST_A, name: "a" },
        { sys_id: TEST_B, name: "b" },
      ],
      sys_atf_test_suite_test: [
        { test_suite: SUITE, test: TEST_A },
        { test_suite: SUITE, test: TEST_B },
      ],
    },
  });
}

const trigger = (fetch) =>
  fetch(`https://${HOST}/api/sn_cicd/testsuite/run?sys_id=${SUITE}`, {
    method: "POST",
  });

async function finish(fetch, executionId) {
  let payload;
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(
      `https://${HOST}/api/sn_cicd/progress/${executionId}`,
    );
    payload = (await res.json()).result;
  }
  return payload;
}

describe("tier-2 engine links result rows to its execution", () => {
  it("sets test_suite_result on every row to the payload's links.results.id", async () => {
    const fake = seeded();
    const fetch = createAtfExecutionEngine(fake);
    const res = await trigger(fetch);
    // The body is still readable by the caller after the engine peeked it.
    const executionId = (await res.json()).result.links.progress.id;
    const rows = fake.tables.all("sys_atf_test_result");
    assert.equal(rows.length, 2);
    const payload = await finish(fetch, executionId);
    const link = payload.links.results.id;
    assert.match(link, /^[0-9a-f]{32}$/);
    assert.equal(link, fake.cicd.peek(executionId).resultSysId);
    for (const row of rows) assert.equal(row.test_suite_result, link);
    assert.deepEqual(rows.map((row) => row.test).sort(), [TEST_A, TEST_B]);
  });

  it("links a second run's rows to the second suite-result row only", async () => {
    const fake = seeded();
    const fetch = createAtfExecutionEngine(fake);
    const first = (await (await trigger(fetch)).json()).result.links.progress
      .id;
    const second = (await (await trigger(fetch)).json()).result.links.progress
      .id;
    const firstLink = fake.cicd.peek(first).resultSysId;
    const secondLink = fake.cicd.peek(second).resultSysId;
    assert.notEqual(firstLink, secondLink);
    const rows = fake.tables.all("sys_atf_test_result");
    assert.equal(rows.length, 4);
    assert.equal(
      rows.filter((row) => row.test_suite_result === firstLink).length,
      2,
    );
    assert.equal(
      rows.filter((row) => row.test_suite_result === secondLink).length,
      2,
    );
  });

  it("fails closed when peek cannot name the suite-result row", async () => {
    const fake = seeded();
    const substrate = {
      tables: fake.tables,
      fetch: (input, init) => fake.fetch(input, init),
      cicd: {
        setOutcome: (sysId, outcome) => fake.cicd.setOutcome(sysId, outcome),
        peek: () => undefined,
      },
    };
    const fetch = createAtfExecutionEngine(substrate);
    await assert.rejects(trigger(fetch), /no suite-result row for execution/);
    assert.deepEqual(fake.tables.all("sys_atf_test_result"), []);
  });

  it("fails closed when peek returns an empty resultSysId", async () => {
    const fake = seeded();
    const substrate = {
      tables: fake.tables,
      fetch: (input, init) => fake.fetch(input, init),
      cicd: {
        setOutcome: (sysId, outcome) => fake.cicd.setOutcome(sysId, outcome),
        peek: () => ({ resultSysId: "" }),
      },
    };
    const fetch = createAtfExecutionEngine(substrate);
    await assert.rejects(trigger(fetch), /no suite-result row/);
    assert.deepEqual(fake.tables.all("sys_atf_test_result"), []);
  });

  it("fails closed when the trigger payload names no execution id", async () => {
    const fake = seeded();
    const substrate = {
      tables: fake.tables,
      cicd: fake.cicd,
      fetch: async () =>
        new Response(JSON.stringify({ result: { links: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    };
    const fetch = createAtfExecutionEngine(substrate);
    await assert.rejects(trigger(fetch), /no result\.links\.progress\.id/);
    assert.deepEqual(fake.tables.all("sys_atf_test_result"), []);
  });
});
