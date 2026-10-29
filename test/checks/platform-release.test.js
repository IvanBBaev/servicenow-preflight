import { test } from "node:test";
import assert from "node:assert/strict";

import { platformRelease } from "../../build/checks/platform-release.js";
import { defaultChecks } from "../../build/checks/index.js";
import {
  FAMILY_ORDER,
  compareFamilies,
  releaseFamily,
} from "../../build/releases.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const INSTANCE = "https://dev12345.service-now.com";
const AUTH = { kind: "basic", user: "admin", pass: "secret" };
const SENTINEL = "SENTINEL_9f3a";
const WAR = `glide-xanadu-07-02-2024__patch3-${SENTINEL}_09-05-2024_1422.zip`;

/** sys_properties rows for the given build name / war (undefined / null omits one). */
function props(buildName, war = WAR) {
  const rows = [];
  if (buildName !== undefined) {
    rows.push({ sys_id: "p1", name: "glide.buildname", value: buildName });
  }
  if (war !== null) {
    rows.push({ sys_id: "p2", name: "glide.war", value: war });
  }
  return rows;
}

/**
 * Run the check against seeded sys_properties rows. The pre-trim count
 * defaults to the seeded row count (`null` omits it → ambiguous).
 */
async function run(rows, { options, totalCount, fail, auth = AUTH } = {}) {
  const calls = [];
  const counts =
    totalCount === null ? {} : { sys_properties: totalCount ?? rows.length };
  const http = createFakeSnClient({
    tables: { sys_properties: rows },
    totalCounts: counts,
    queryFilter: (table, tableRows, params) => {
      calls.push({ table, params });
      return tableRows;
    },
    fail,
  });
  const result = await platformRelease.run({
    instanceUrl: INSTANCE,
    auth,
    http,
    options,
  });
  assert.equal(result.name, "platform-release");
  assert.ok(!result.message.includes(SENTINEL), result.message);
  return { result, calls };
}

test("platform-release is registered with advisory metadata and no scope requirement", () => {
  assert.ok(defaultChecks.some((c) => c.name === "platform-release"));
  const { meta } = platformRelease;
  assert.equal(meta.requires, "ALWAYS");
  assert.equal(meta.rule, undefined);
  assert.equal(meta.severity, "advisory");
  assert.deepEqual(meta.tables, ["sys_properties"]);
  for (const v of ["pass", "warn", "fail"]) assert.ok(meta.verdicts[v]);
  assert.ok(meta.remediation);
  assert.deepEqual(Object.keys(platformRelease.optionsSchema.shape), [
    "platform",
  ]);
});

test("reads both build properties through the validated builder", async () => {
  const { calls } = await run(props("Xanadu"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, "sys_properties");
  assert.equal(
    calls[0].params.sysparm_query,
    "nameINglide.buildname,glide.war",
  );
  assert.equal(calls[0].params.sysparm_fields, "name,value");
  assert.equal(calls[0].params.sysparm_limit, undefined);
});

test("no options → pass with the family and the war's leading token only", async () => {
  const { result } = await run(props("Xanadu"));
  assert.equal(result.status, "pass");
  assert.equal(
    result.message,
    "Instance runs Xanadu (build glide-xanadu-07-02-2024).",
  );
});

test("passes without a glide.war value", async () => {
  const { result } = await run(props("Zurich", null));
  assert.equal(result.status, "pass");
  assert.equal(result.message, "Instance runs Zurich.");
});

test("below minRelease → fail", async () => {
  const { result } = await run(props("Xanadu"), {
    options: { platform: { minRelease: "Yokohama" } },
  });
  assert.equal(result.status, "fail");
  assert.equal(
    result.message,
    "Instance runs Xanadu; the app requires Yokohama or later.",
  );
});

test("equal to minRelease → pass; newer → pass", async () => {
  for (const minRelease of ["Xanadu", "xanadu", "Washington DC"]) {
    const { result } = await run(props("Xanadu"), {
      options: { platform: { minRelease } },
    });
    assert.equal(result.status, "pass", minRelease);
  }
});

test("an expect mismatch → warn; a match → pass", async () => {
  const mismatch = await run(props("Zurich"), {
    options: { platform: { expect: "Australia" } },
  });
  assert.equal(mismatch.result.status, "warn");
  assert.match(
    mismatch.result.message,
    /^Instance runs Zurich, expected Australia\./,
  );

  const match = await run(props("Zurich"), {
    options: { platform: { minRelease: "Yokohama", expect: "zurich" } },
  });
  assert.equal(match.result.status, "pass");
});

test("unknown family → warn", async () => {
  const { result } = await run(props(`Atlantis ${SENTINEL}`));
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /glide\.buildname is not set or not a known release family/,
  );
});

test("glide.buildname missing → warn", async () => {
  const { result } = await run(props(undefined));
  assert.equal(result.status, "warn");
  assert.match(result.message, /glide\.buildname is not set/);
  const blank = await run(props("   "));
  assert.equal(blank.result.status, "warn");
});

test("a malformed option → warn, and the gate is not armed", async () => {
  for (const platform of ["Xanadu", ["Xanadu"], null, 7]) {
    const { result } = await run(props("Xanadu"), { options: { platform } });
    assert.equal(result.status, "warn", JSON.stringify(platform));
    assert.match(result.message, /options\.platform is malformed/);
  }
  const { result } = await run(props("Xanadu"), {
    options: { platform: { minRelease: 42, expect: "" } },
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /options\.platform\.minRelease is malformed/);
  assert.match(result.message, /options\.platform\.expect is malformed/);
});

test("minRelease / expect outside FAMILY_ORDER → warn", async () => {
  const { result } = await run(props("Xanadu"), {
    options: { platform: { minRelease: "Omega", expect: SENTINEL } },
  });
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /options\.platform\.minRelease is not a known release family/,
  );
  assert.match(
    result.message,
    /options\.platform\.expect is not a known release family/,
  );
});

test("a trimmed read → warn (with or without visible rows)", async () => {
  const visible = await run(props("Xanadu"), { totalCount: 5 });
  assert.equal(visible.result.status, "warn");
  assert.match(visible.result.message, /security-trimmed/);

  const none = await run([], { totalCount: 2 });
  assert.equal(none.result.status, "warn");
  assert.match(none.result.message, /security-trimmed/);
});

test("a trimmed read still fails below minRelease", async () => {
  const { result } = await run(props("Utah"), {
    totalCount: 5,
    options: { platform: { minRelease: "Xanadu" } },
  });
  assert.equal(result.status, "fail");
});

test("an ambiguous zero-row read → warn", async () => {
  const { result } = await run([], { totalCount: null });
  assert.equal(result.status, "warn");
  assert.match(result.message, /no pre-trim count/);
});

test("no credentials → warn without reading", async () => {
  const { result, calls } = await run(props("Xanadu"), { auth: null });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No credentials configured/);
  assert.equal(calls.length, 0);
});

test("auth → fail; network → warn; HTTP → warn", async () => {
  const auth = await run([], { fail: { auth: true } });
  assert.equal(auth.result.status, "fail");
  assert.match(auth.result.message, /Authentication failed/);
  const network = await run([], { fail: { network: true } });
  assert.equal(network.result.status, "warn");
  const http = await run([], { fail: { http: 403 } });
  assert.equal(http.result.status, "warn");
  assert.match(http.result.message, /HTTP 403/);
});

test("release families: order, aliases, comparison", () => {
  assert.deepEqual(FAMILY_ORDER.slice(-5), [
    "Xanadu",
    "Yokohama",
    "Zurich",
    "Australia",
    "Brazil",
  ]);
  assert.equal(new Set(FAMILY_ORDER).size, FAMILY_ORDER.length);
  assert.equal(releaseFamily("Washingtondc"), "Washington DC");
  assert.equal(releaseFamily("washington"), "Washington DC");
  assert.equal(releaseFamily("sandiego"), "San Diego");
  assert.equal(releaseFamily("Xanadu Patch 3"), "Xanadu");
  assert.equal(releaseFamily("Nowhere"), undefined);
  assert.equal(releaseFamily(""), undefined);
  assert.ok(compareFamilies("Zurich", "Australia") < 0);
  assert.ok(compareFamilies("Brazil", "Aspen") > 0);
  assert.equal(compareFamilies("Rome", "Rome"), 0);
});
