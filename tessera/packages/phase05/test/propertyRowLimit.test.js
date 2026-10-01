// The sys_properties row limit — complete or fail-closed (wave 14).
//
// Both property reads in this package used to ask for ten rows and read
// whatever came back as the whole picture. An eleventh row that disagreed was
// never fetched, so ten agreeing rows read as a clean value. The reads now ask
// for one row more than they compare; seeing that row, or an X-Total-Count
// larger than what came back, makes the read incomplete, and an incomplete
// read yields no value (the guard probe) or faults (the provisioner). The one
// exception is the production flag in its safe direction.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

import * as sharedTypes from "@tessera/types";

import {
  ATF_RUNNER_ENABLED_PROPERTY,
  SYS_PROPERTIES_TABLE,
} from "../build/atf.js";
import { SkeletonInfrastructureError } from "../build/errors.js";
import {
  createInstanceProbe,
  incompleteRead,
  PRODUCTION_PROPERTY,
  PROPERTY_READ_LIMIT,
  PROPERTY_ROW_LIMIT,
} from "../build/probe.js";
import { createS5Provisioner } from "../build/provisioner.js";
import { context, harness, HOST } from "./support.js";

const REF = { name: "fake", host: HOST };

const opened = [];
after(() => {
  for (const h of opened) h.restore();
});

function open(rows) {
  const h = harness({ state: { [SYS_PROPERTIES_TABLE]: rows } });
  opened.push(h);
  return h;
}

/** `count` rows for `name`; `values(i)` gives row i's value. */
function manyRows(name, count, values) {
  return Array.from({ length: count }, (_, i) => ({ name, value: values(i) }));
}

/**
 * Serve `rows` verbatim, with an X-Total-Count only when `total` is given.
 * The fake always sends the header and counts after its read ACL, so the
 * no-header and short-page shapes need a hand-built response.
 *
 * Wave 16: the guard probe reads each property with its own `name=<prop>`
 * query, so a request asking for one name is served only that name's rows.
 */
async function withStubbedRows(rows, total, run) {
  const h = open([]);
  const installed = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const query = new URL(String(input)).searchParams.get("sysparm_query");
    const name = query?.startsWith("name=") ? query.slice(5) : undefined;
    const served =
      name === undefined ? rows : rows.filter((row) => row.name === name);
    return new Response(JSON.stringify({ result: served }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...(total === undefined ? {} : { "x-total-count": String(total) }),
      },
    });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = installed;
    h.restore();
  }
}

async function probe(rows) {
  const h = open(rows);
  try {
    return await createInstanceProbe()(REF);
  } finally {
    h.restore();
  }
}

async function plan(rows) {
  const h = open(rows);
  try {
    return await createS5Provisioner().plan(context(), []);
  } finally {
    h.restore();
  }
}

describe("incompleteRead", () => {
  it("compares ten rows and reads one more", () => {
    assert.equal(PROPERTY_ROW_LIMIT, 10);
    assert.equal(PROPERTY_READ_LIMIT, 11);
  });

  for (const [returned, total] of [
    [0, undefined],
    [0, 0],
    [10, undefined],
    [10, 10],
    [3, 2],
  ]) {
    it(`${returned} rows with X-Total-Count ${String(total)} are complete`, () => {
      assert.equal(incompleteRead("p", returned, total), undefined);
    });
  }

  it("eleven rows are incomplete, with or without a count", () => {
    assert.match(
      incompleteRead("p", 11, undefined),
      /^sys_properties read for p matched more than 10 rows \(the instance sent no X-Total-Count\)/,
    );
    assert.match(incompleteRead("p", 11, 11), /\(X-Total-Count reports 11\)/);
    assert.match(incompleteRead("p", 11, 40), /\(X-Total-Count reports 40\)/);
  });

  it("fewer rows than X-Total-Count is a short read, worded by the transport", () => {
    assert.equal(
      incompleteRead("p", 10, 11),
      "sys_properties read for p came back short: X-Total-Count reports 11 matching rows but only 10 were returned (rows removed by read ACLs, or an inconsistent count; raising SN_MAX_RECORDS will not help)",
    );
    assert.match(incompleteRead("p", 0, 1), /came back short/);
  });
});

describe("property read limits — one source (wave 16)", () => {
  it("re-exports @tessera/types' limits, table and bound rule", () => {
    assert.equal(PROPERTY_ROW_LIMIT, sharedTypes.PROPERTY_ROW_LIMIT);
    assert.equal(PROPERTY_READ_LIMIT, sharedTypes.PROPERTY_READ_LIMIT);
    assert.equal(SYS_PROPERTIES_TABLE, sharedTypes.SYS_PROPERTIES_TABLE);
    // A function is compared by reference: the SAME rule, not a copy of it.
    assert.equal(incompleteRead, sharedTypes.incompletePropertyRead);
  });

  for (const file of ["probe.js", "atf.js", "provisioner.js"]) {
    it(`${file} declares no limit or table of its own`, () => {
      // Numbers compare by value, so a reintroduced local `= 10` would pass
      // the equality pin above; the built module must not declare one at all.
      const built = readFileSync(
        new URL(`../build/${file}`, import.meta.url),
        "utf8",
      );
      assert.doesNotMatch(
        built,
        /\b(?:const|let|var)\s+(?:PROPERTY_ROW_LIMIT|PROPERTY_READ_LIMIT|SYS_PROPERTIES_TABLE)\s*=/,
      );
    });
  }
});

describe("createInstanceProbe — row limit", () => {
  it("asks for eleven rows per property", async () => {
    const h = open([{ name: PRODUCTION_PROPERTY, value: "false" }]);
    try {
      await createInstanceProbe()(REF);
      const requests = h.fake
        .requests()
        .filter((r) => r.path.includes(SYS_PROPERTIES_TABLE));
      // Wave 16: two requests (one per property), each with its own budget.
      assert.equal(requests.length, 2);
      assert.ok(requests.every((r) => r.params.sysparm_limit === "11"));
    } finally {
      h.restore();
    }
  });

  it("ten rows are still read (the boundary is not a refusal)", async () => {
    const result = await probe([
      ...manyRows(ATF_RUNNER_ENABLED_PROPERTY, 9, () => "true"),
      { name: PRODUCTION_PROPERTY, value: "false" },
    ]);
    assert.equal(result.productionProperty, false);
    assert.equal(result.atfRunnerEnabled, true);
    assert.equal("unreachable" in result, false);
  });

  it("a differing eleventh runner row reads not enabled (wave 16)", async () => {
    // Wave 16: an incomplete read that SAW a row in the runner's safe
    // direction ("not enabled") settles it — no unseen row can make it less
    // safe. The production flag has its own read, which is complete.
    const result = await probe([
      { name: PRODUCTION_PROPERTY, value: "false" },
      ...manyRows(ATF_RUNNER_ENABLED_PROPERTY, 11, (i) =>
        i === 10 ? "false" : "true",
      ),
    ]);
    assert.equal(result.atfRunnerEnabled, false);
    assert.equal(result.productionProperty, false);
    assert.equal(result.unreachable.length, 1);
    assert.match(result.unreachable[0], /more than 10 rows/);
    assert.ok(
      result.unreachable[0].endsWith(
        `a ${ATF_RUNNER_ENABLED_PROPERTY} row that was read reads in its safe direction, so it is read as false`,
      ),
      result.unreachable[0],
    );
  });

  it("eleven agreeing rows in the licensing direction still decide nothing", async () => {
    const result = await probe([
      ...manyRows(PRODUCTION_PROPERTY, 11, () => "false"),
      ...manyRows(ATF_RUNNER_ENABLED_PROPERTY, 11, () => " TRUE"),
    ]);
    assert.equal("atfRunnerEnabled" in result, false);
    assert.equal("productionProperty" in result, false);
    assert.equal(result.unreachable.length, 2);
    for (const name of [PRODUCTION_PROPERTY, ATF_RUNNER_ENABLED_PROPERTY]) {
      assert.ok(
        result.unreachable.some(
          (note) =>
            /more than 10 rows/.test(note) &&
            note.endsWith(`; ${name} is unknown`),
        ),
        JSON.stringify(result.unreachable),
      );
    }
  });

  it("an overflowing read that saw a production `TRUE` reads production", async () => {
    const result = await probe([
      ...manyRows(ATF_RUNNER_ENABLED_PROPERTY, 10, () => "true"),
      ...manyRows(PRODUCTION_PROPERTY, 11, (i) =>
        i === 10 ? "TRUE" : "false",
      ),
    ]);
    assert.equal(result.productionProperty, true);
    assert.equal(result.atfRunnerEnabled, true, "its own, complete read");
    assert.equal(result.unreachable.length, 1);
    assert.ok(
      result.unreachable.some(
        (note) =>
          /more than 10 rows/.test(note) &&
          note.endsWith(
            `a ${PRODUCTION_PROPERTY} row that was read reads in its safe direction, so it is read as true`,
          ),
      ),
      JSON.stringify(result.unreachable),
    );
  });

  for (const odd of ["garbage", "", "yes"]) {
    it(`an overflowing read that saw a production ${JSON.stringify(odd)} reads production (wave 16)`, async () => {
      // Previously unknown here and production in the doctor — the divergence
      // wave 16 removed.
      const result = await probe([
        ...manyRows(PRODUCTION_PROPERTY, 11, (i) => (i === 3 ? odd : "false")),
      ]);
      assert.equal(result.productionProperty, true);
    });
  }

  it("each property has its own eleven-row budget (wave 16)", async () => {
    // Ten runner rows and one production row fill ONE shared eleven-row
    // query; under it neither property could be read. Read separately, both
    // reads are complete.
    const result = await probe([
      ...manyRows(ATF_RUNNER_ENABLED_PROPERTY, 10, () => "true"),
      ...manyRows(PRODUCTION_PROPERTY, 10, () => "false"),
    ]);
    assert.equal(result.productionProperty, false);
    assert.equal(result.atfRunnerEnabled, true);
    assert.equal("unreachable" in result, false);
  });

  it("a runner `true` on an overflowing read is never enabled", async () => {
    // (Wave 16: the eleven rows now fill only the runner's own read.)
    const result = await probe([
      ...manyRows(ATF_RUNNER_ENABLED_PROPERTY, 11, () => "true"),
    ]);
    assert.equal("atfRunnerEnabled" in result, false);
  });

  it("overflow without X-Total-Count is still incomplete", async () => {
    const rows = manyRows(ATF_RUNNER_ENABLED_PROPERTY, 11, () => "true");
    const result = await withStubbedRows(rows, undefined, () =>
      createInstanceProbe()(REF),
    );
    assert.equal("atfRunnerEnabled" in result, false);
    assert.ok(result.unreachable.some((note) => /no X-Total-Count/.test(note)));
  });

  it("a short read under X-Total-Count decides nothing", async () => {
    const rows = [
      { name: PRODUCTION_PROPERTY, value: "false" },
      { name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" },
    ];
    const result = await withStubbedRows(rows, 3, () =>
      createInstanceProbe()(REF),
    );
    assert.equal("atfRunnerEnabled" in result, false);
    assert.equal("productionProperty" in result, false);
    assert.ok(result.unreachable.some((note) => /came back short/.test(note)));
  });
});

describe("createS5Provisioner().plan — row limit", () => {
  it("asks for eleven rows", async () => {
    const h = open([{ name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" }]);
    try {
      await createS5Provisioner().plan(context(), []);
      const [request] = h.fake
        .requests()
        .filter((r) => r.path.includes(SYS_PROPERTIES_TABLE));
      assert.equal(request.params.sysparm_limit, "11");
    } finally {
      h.restore();
    }
  });

  it("ten agreeing rows are an enabled runner", async () => {
    const result = await plan(
      manyRows(ATF_RUNNER_ENABLED_PROPERTY, 10, () => "true"),
    );
    assert.deepEqual(result.actions, []);
  });

  for (const eleventh of ["false", "true"]) {
    it(`an eleventh row (${eleventh}) faults — never an empty plan`, async () => {
      const h = open(
        manyRows(ATF_RUNNER_ENABLED_PROPERTY, 11, (i) =>
          i === 10 ? eleventh : "true",
        ),
      );
      try {
        await assert.rejects(
          () => createS5Provisioner().plan(context(), []),
          (error) => {
            assert.ok(error instanceof SkeletonInfrastructureError);
            assert.match(
              error.message,
              /^could not read sn_atf\.runner\.enabled completely: sys_properties read for sn_atf\.runner\.enabled matched more than 10 rows/,
            );
            return true;
          },
        );
      } finally {
        h.restore();
      }
    });
  }

  it("a short read faults", async () => {
    const rows = [{ name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" }];
    await withStubbedRows(rows, 2, () =>
      assert.rejects(
        () => createS5Provisioner().plan(context(), []),
        (error) =>
          error instanceof SkeletonInfrastructureError &&
          /came back short/.test(error.message),
      ),
    );
  });

  it("a complete read under an equal X-Total-Count passes", async () => {
    const rows = [{ name: ATF_RUNNER_ENABLED_PROPERTY, value: "true" }];
    const result = await withStubbedRows(rows, 1, () =>
      createS5Provisioner().plan(context(), []),
    );
    assert.deepEqual(result.actions, []);
  });
});

// Wave 15: a read that returned NO rows while X-Total-Count counted some —
// every matching row hidden by read ACLs — is unreadable, never "absent".
describe("no rows under a larger X-Total-Count (wave 15)", () => {
  it("incompleteRead calls it a short read", () => {
    assert.equal(
      incompleteRead("p", 0, 2),
      "sys_properties read for p came back short: X-Total-Count reports 2 matching rows but only 0 were returned (rows removed by read ACLs, or an inconsistent count; raising SN_MAX_RECORDS will not help)",
    );
  });

  it("the guard probe reads neither property, and says why", async () => {
    const result = await withStubbedRows([], 2, () =>
      createInstanceProbe()(REF),
    );
    assert.equal("atfRunnerEnabled" in result, false);
    assert.equal("productionProperty" in result, false);
    assert.equal(result.unreachable.length, 2);
    assert.ok(
      result.unreachable.every((note) => /came back short/.test(note)),
      JSON.stringify(result.unreachable),
    );
    assert.ok(
      result.unreachable.every((note) => !/is absent/.test(note)),
      JSON.stringify(result.unreachable),
    );
  });

  it("the provisioner faults instead of planning a DR-3 write", async () => {
    await withStubbedRows([], 1, () =>
      assert.rejects(
        () => createS5Provisioner().plan(context(), []),
        (error) =>
          error instanceof SkeletonInfrastructureError &&
          /came back short: X-Total-Count reports 1 matching rows but only 0/.test(
            error.message,
          ),
      ),
    );
  });

  it("no rows under an X-Total-Count of 0 is still an absent property", async () => {
    const result = await withStubbedRows([], 0, () =>
      createInstanceProbe()(REF),
    );
    assert.ok(
      result.unreachable.some((note) => /is absent/.test(note)),
      JSON.stringify(result.unreachable),
    );
    assert.ok(
      result.unreachable.every((note) => !/came back short/.test(note)),
    );
  });
});

describe("sys_properties names — one source (wave 17)", () => {
  it("re-exports @tessera/types' property names", () => {
    assert.equal(PRODUCTION_PROPERTY, sharedTypes.PRODUCTION_PROPERTY);
    assert.equal(
      ATF_RUNNER_ENABLED_PROPERTY,
      sharedTypes.ATF_RUNNER_ENABLED_PROPERTY,
    );
  });

  for (const file of ["probe.js", "atf.js", "provisioner.js", "tier2.js"]) {
    it(`${file} declares and spells neither name itself`, () => {
      // Strings compare by value, so a reintroduced local copy would pass the
      // equality pin above; the built module must not hold one at all.
      const built = readFileSync(
        new URL(`../build/${file}`, import.meta.url),
        "utf8",
      );
      assert.doesNotMatch(
        built,
        /\b(?:const|let|var)\s+(?:PRODUCTION_PROPERTY|ATF_RUNNER_ENABLED_PROPERTY)\s*=/,
      );
      assert.doesNotMatch(built, /"glide\.installation\.production"/);
      assert.doesNotMatch(built, /"sn_atf\.runner\.enabled"/);
    });
  }
});
