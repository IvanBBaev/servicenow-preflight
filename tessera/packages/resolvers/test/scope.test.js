// ARCH-5 scope resolution — PLAN Phase 2.
//
// Two halves, and the split is deliberate.
//
//  * The DECISION half runs against a stubbed `RecordReader`. What is under
//    test there is the decision table — which read outcome becomes an artifact,
//    which becomes a note, and which becomes a thrown error — plus the exact
//    queries the adapter asks. An instance in the picture would only add ways
//    for those assertions to pass for the wrong reason, and several of them
//    ("zero reads happened", "the second read never happened") are about calls
//    that must NOT be made, which a live fake cannot state as clearly.
//
//  * The ADAPTER half runs the real `@tessera/sn-client` transport against one
//    QA-18 stateful fake. Those assertions are about HTTP: that a seeded scope
//    and its script includes really come back through `sysparm_query`, that
//    nothing but GET is ever sent (ARCH-8), and that a refused read surfaces as
//    a fault rather than as an application with nothing in it (QA-9).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import {
  DEFAULT_ARTIFACT_TABLES,
  ResolutionFaultError,
  ResolutionInputError,
  createScopeResolver,
  createSnRecordReader,
  isIncomplete,
} from "../build/index.js";

// ── decision half ───────────────────────────────────────────────────────────

const SCOPE_SYS_ID = "aaaa0000000000000000000000000001";
const SCOPE_NAME = "x_snc_demo";

const SCOPE_ROW = {
  sys_id: SCOPE_SYS_ID,
  scope: SCOPE_NAME,
  name: "Tessera Demo",
};

const INCLUDE_ROWS = [
  {
    sys_id: "bbbb0000000000000000000000000002",
    name: "AmountCalculator",
    sys_scope: SCOPE_SYS_ID,
  },
  {
    sys_id: "cccc0000000000000000000000000003",
    name: "ZoneLookup",
    sys_scope: SCOPE_SYS_ID,
  },
];

function ctx() {
  return {
    runId: "run-scope",
    lifecycle: "ephemeral",
    coverageSource: "atf",
    topology: { source: "dev", runner: "test", target: "test" },
    signal: new AbortController().signal,
  };
}

function answered(records, extra = {}) {
  return {
    outcome: "answered",
    records,
    truncated: false,
    detail: `${records.length} row(s)`,
    ...extra,
  };
}

function undecidable(detail) {
  return { outcome: "undecidable", records: [], truncated: false, detail };
}

/**
 * A reader over canned reads keyed by table. Every request is recorded, because
 * half of what this adapter promises is about the queries it sends and the ones
 * it declines to send. A table with no canned entry answers with zero rows —
 * "the instance looked and found nothing", never "the read failed".
 */
function readerFrom(canned) {
  const requests = [];
  return {
    profile: "source",
    requests,
    queryRecords(request) {
      requests.push({
        table: request.table,
        query: request.query,
        fields: [...request.fields],
        limit: request.limit,
        fetchAll: request.fetchAll,
      });
      return Promise.resolve(canned[request.table] ?? answered([]));
    },
  };
}

/** The happy path both halves start from: one scope, two script includes. */
function healthyReader(overrides = {}) {
  return readerFrom({
    sys_scope: answered([SCOPE_ROW]),
    sys_script_include: answered(INCLUDE_ROWS),
    ...overrides,
  });
}

function resolveScope(reader, scope = SCOPE_NAME, options) {
  return createScopeResolver(reader, options).resolveWithReport(ctx(), {
    scope,
  });
}

function messages(report, level) {
  return report.notes
    .filter((note) => level === undefined || note.level === level)
    .map((note) => note.message);
}

describe("the scope nobody asked about", () => {
  it("contributes nothing, says so, and reads nothing at all", async () => {
    const reader = healthyReader();
    const report = await createScopeResolver(reader).resolveWithReport(ctx(), {
      story: "STRY0010001",
    });

    assert.deepEqual(report.artifacts, []);
    assert.equal(report.notes.length, 1);
    assert.equal(report.notes[0].source, "scope");
    // `info`, not `warning`: nothing was asked, so nothing is missing. A
    // warning here would make every story-only run look incomplete.
    assert.equal(report.notes[0].level, "info");
    assert.match(report.notes[0].message, /--scope/);
    assert.equal(isIncomplete(report), false);
    // The whole point of the branch — an absent input costs no round trip.
    assert.equal(reader.requests.length, 0);
  });

  it("refuses a --scope that expanded to nothing", async () => {
    // A blank value is a fact about the request, not about the instance, so it
    // is an input error rather than a quiet "no scope was given".
    const reader = healthyReader();
    await assert.rejects(
      () => resolveScope(reader, "   "),
      ResolutionInputError,
    );
    assert.equal(reader.requests.length, 0);
  });
});

describe("naming the scope", () => {
  it("looks a scope name up in both columns and enumerates it", async () => {
    const reader = healthyReader();
    const report = await resolveScope(reader);

    assert.deepEqual(reader.requests[0], {
      table: "sys_scope",
      // `global` is an ordinary value of `scope`, so there is no special case —
      // and `name` is matched too because that is the label Studio shows.
      query: `scope=${SCOPE_NAME}^ORname=${SCOPE_NAME}`,
      fields: ["sys_id", "scope", "name"],
      // Two rows is all the evidence an ambiguity needs.
      limit: 2,
      fetchAll: undefined,
    });
    assert.deepEqual(reader.requests[1], {
      table: "sys_script_include",
      query: `sys_scope=${SCOPE_SYS_ID}^ORDERBYname`,
      // sys_scope is read back so every row is checked against the filter (M2).
      fields: ["sys_id", "name", "sys_scope"],
      limit: undefined,
      fetchAll: true,
    });
    assert.equal(reader.requests.length, 2);

    assert.deepEqual(report.artifacts, [
      {
        ref: {
          table: "sys_script_include",
          sysId: INCLUDE_ROWS[0].sys_id,
          name: "AmountCalculator",
        },
        resolvedBy: "scope",
      },
      {
        ref: {
          table: "sys_script_include",
          sysId: INCLUDE_ROWS[1].sys_id,
          name: "ZoneLookup",
        },
        resolvedBy: "scope",
      },
    ]);
    assert.equal(isIncomplete(report), false);
    // Scope-level note first, then the per-table count — a CI log has to diff.
    assert.match(report.notes[0].message, new RegExp(SCOPE_SYS_ID));
    assert.match(report.notes[1].message, /sys_script_include: 2 artifact/);
    assert.equal(report.notes.length, 2);
  });

  it("addresses a 32-hex value as a sys_id instead of a name", async () => {
    const reader = healthyReader();
    await resolveScope(reader, SCOPE_SYS_ID);

    assert.equal(reader.requests[0].query, `sys_id=${SCOPE_SYS_ID}`);
  });

  it("defaults to the Script Includes DESIGN §12.3 pins as the MVP surface", () => {
    assert.deepEqual([...DEFAULT_ARTIFACT_TABLES], ["sys_script_include"]);
  });
});

describe("a scope that cannot be turned into one identity", () => {
  it("faults when sys_scope did not answer, and never reads on", async () => {
    const reader = healthyReader({
      sys_scope: undecidable("sys_scope on source: read refused (403)"),
    });

    await assert.rejects(() => resolveScope(reader), {
      name: "ResolutionFaultError",
      // The evidence line travels with the error — DEV-1 wants the cause, not
      // just the category.
      message: /read refused \(403\)/,
    });
    // Nothing was learned about the scope, so asking about its contents would
    // be a query against an id nobody established.
    assert.equal(reader.requests.length, 1);
  });

  it("reports an unknown scope as a bad argument, not a fault", async () => {
    const reader = healthyReader({ sys_scope: answered([]) });

    await assert.rejects(() => resolveScope(reader, "x_snc_nope"), {
      name: "ResolutionInputError",
      message: /no application scope named `x_snc_nope`/,
    });
    assert.equal(reader.requests.length, 1);
  });

  it("refuses to pick one of two matching scopes", async () => {
    // Picking blind would enumerate a different application than the caller
    // meant, and the run would look perfectly healthy while doing it.
    const reader = healthyReader({
      sys_scope: answered([
        SCOPE_ROW,
        { sys_id: "dddd0000000000000000000000000004", scope: "x_snc_other" },
      ]),
    });

    await assert.rejects(() => resolveScope(reader, "Demo"), {
      name: "ResolutionInputError",
      message: /x_snc_demo.*x_snc_other/,
    });
    assert.equal(reader.requests.length, 1);
  });

  it("faults when the scope row came back without a sys_id", async () => {
    // Field-level ACL trimming: a row arrived, but nothing addressable did.
    const reader = healthyReader({
      sys_scope: answered([{ scope: SCOPE_NAME }]),
    });

    await assert.rejects(() => resolveScope(reader), ResolutionFaultError);
    assert.equal(reader.requests.length, 1);
  });
});

describe("enumerating the artifacts", () => {
  const TWO_TABLES = {
    artifactTables: ["sys_script_include", "sys_script"],
  };

  it("keeps the tables that answered when one of them did not", async () => {
    const reader = healthyReader({
      sys_script: undecidable("sys_script on source: connection reset"),
    });
    const report = await resolveScope(reader, SCOPE_NAME, TWO_TABLES);

    assert.equal(report.artifacts.length, 2);
    assert.ok(report.artifacts.every((a) => a.resolvedBy === "scope"));
    // The rows that did come back are still true; the hole in them is a
    // warning, not a reason to throw the answer away.
    const warnings = messages(report, "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sys_script could not be enumerated/);
    assert.match(warnings[0], /connection reset/);
    assert.equal(isIncomplete(report), true);
    // Deterministic order: scope note, then the two tables as configured.
    assert.match(report.notes[1].message, /sys_script_include: 2 artifact/);
  });

  it("faults when not one table answered", async () => {
    // An empty list here is indistinguishable from an empty application, which
    // is exactly the silent green QA-9 forbids.
    const reader = healthyReader({
      sys_script_include: undecidable("sys_script_include on source: 500"),
      sys_script: undecidable("sys_script on source: 500"),
    });

    await assert.rejects(
      () => resolveScope(reader, SCOPE_NAME, TWO_TABLES),
      ResolutionFaultError,
    );
    // Same rule with the default single-table list.
    await assert.rejects(
      () =>
        resolveScope(
          readerFrom({
            sys_scope: answered([SCOPE_ROW]),
            sys_script_include: undecidable("sys_script_include: 403"),
          }),
        ),
      { name: "ResolutionFaultError", message: /403/ },
    );
  });

  it("does not present a capped read as the whole application", async () => {
    const reader = healthyReader({
      sys_script_include: answered(INCLUDE_ROWS, {
        truncated: true,
        truncationReason: "cap",
        total: 7,
      }),
    });
    const report = await resolveScope(reader);

    assert.equal(report.artifacts.length, 2);
    const warnings = messages(report, "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /hit the SN_MAX_RECORDS cap \(2 of 7/);
    assert.match(warnings[0], /partial list of scope/);
    assert.equal(isIncomplete(report), true);
  });

  // Delegated decision 2026-09-26: every partial case is worded as what it
  // is, and every one of them stays exactly as fail-closed — one warning,
  // an incomplete report, and `resolve()` refusing it (H1).
  for (const [reason, extra, says, never] of [
    [
      "short-page",
      { total: 5 },
      /came back short: X-Total-Count reports 5 matching rows but only 2 were returned/,
      /hit the SN_MAX_RECORDS cap|stopped at the SN_MAX_RECORDS cap/,
    ],
    [
      "no-total",
      {},
      /sent no X-Total-Count, so more rows may exist/,
      /hit the SN_MAX_RECORDS cap|came back short/,
    ],
    [
      undefined,
      {},
      /stopped before the full result set \(2 rows read\)/,
      /SN_MAX_RECORDS/,
    ],
  ]) {
    it(`words a ${reason ?? "reason-less"} truncation as such, and still fails closed`, async () => {
      const truncatedRead = answered(INCLUDE_ROWS, {
        truncated: true,
        ...(reason === undefined ? {} : { truncationReason: reason }),
        ...extra,
      });
      const report = await resolveScope(
        healthyReader({ sys_script_include: truncatedRead }),
      );

      const warnings = messages(report, "warning");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], says);
      assert.doesNotMatch(warnings[0], never);
      assert.match(warnings[0], /partial list of scope/);
      assert.equal(isIncomplete(report), true);
      await assert.rejects(
        () =>
          createScopeResolver(
            healthyReader({ sys_script_include: truncatedRead }),
          ).resolve(ctx(), { scope: SCOPE_NAME }),
        (error) =>
          error instanceof ResolutionFaultError &&
          /incomplete/.test(error.message),
      );
    });
  }

  it("drops a row nobody can address, out loud", async () => {
    const reader = healthyReader({
      sys_script_include: answered([
        INCLUDE_ROWS[0],
        { name: "no identity here", sys_scope: SCOPE_SYS_ID },
      ]),
    });
    const report = await resolveScope(reader);

    assert.equal(report.artifacts.length, 1);
    assert.equal(report.artifacts[0].ref.sysId, INCLUDE_ROWS[0].sys_id);
    assert.match(messages(report, "warning")[0], /no readable sys_id/);
    assert.equal(isIncomplete(report), true);
    // The count note reflects what survived, not what arrived.
    assert.match(messages(report, "info")[1], /sys_script_include: 1 artifact/);
  });

  it("never labels an artifact with an empty name", async () => {
    const reader = healthyReader({
      sys_script_include: answered([
        { sys_id: INCLUDE_ROWS[0].sys_id, name: "  ", sys_scope: SCOPE_SYS_ID },
      ]),
    });
    const report = await resolveScope(reader);

    assert.equal(
      report.artifacts[0].ref.name,
      `sys_script_include/${INCLUDE_ROWS[0].sys_id}`,
    );
  });

  it("de-duplicates by table + sys_id", async () => {
    const reader = healthyReader({
      sys_script_include: answered([
        INCLUDE_ROWS[0],
        { ...INCLUDE_ROWS[0], name: "AmountCalculator (again)" },
      ]),
    });
    const report = await resolveScope(reader);

    assert.equal(report.artifacts.length, 1);
    assert.equal(report.artifacts[0].ref.name, "AmountCalculator");
  });

  it("will not answer an empty table list with a clean empty list", async () => {
    const report = await resolveScope(healthyReader(), SCOPE_NAME, {
      artifactTables: [],
    });

    assert.deepEqual(report.artifacts, []);
    // Nothing was looked at, so the scope's contents are unknown — that is
    // incomplete, even though no read went wrong.
    assert.equal(isIncomplete(report), true);
    assert.match(messages(report, "warning")[0], /no artifact tables/);
  });
});

describe("every artifact row is checked against the scope filter (M2)", () => {
  it("faults on a row from another scope", async () => {
    const reader = healthyReader({
      sys_script_include: answered([
        INCLUDE_ROWS[0],
        { ...INCLUDE_ROWS[1], sys_scope: "eeee0000000000000000000000000005" },
      ]),
    });
    await assert.rejects(() => resolveScope(reader), ResolutionFaultError);
  });

  it("faults on a row that did not carry sys_scope", async () => {
    const reader = healthyReader({
      sys_script_include: answered([
        { sys_id: INCLUDE_ROWS[0].sys_id, name: "AmountCalculator" },
      ]),
    });
    await assert.rejects(() => resolveScope(reader), ResolutionFaultError);
  });

  it("warns about and skips a row whose sys_id is not a sys_id (L4)", async () => {
    const reader = healthyReader({
      sys_script_include: answered([
        INCLUDE_ROWS[0],
        { sys_id: "x^NQactive=true", name: "Widened", sys_scope: SCOPE_SYS_ID },
      ]),
    });
    const report = await resolveScope(reader);

    assert.equal(report.artifacts.length, 1);
    assert.equal(report.artifacts[0].ref.sysId, INCLUDE_ROWS[0].sys_id);
    assert.match(messages(report, "warning").join("\n"), /not a valid sys_id/);
    assert.equal(isIncomplete(report), true);
  });
});

describe("a scope that resolved to nothing is not a clean answer (M3)", () => {
  it("warns when every configured table answered with zero rows", async () => {
    const report = await resolveScope(
      healthyReader({ sys_script_include: answered([]) }),
    );
    assert.deepEqual(report.artifacts, []);
    assert.equal(isIncomplete(report), true);
    assert.match(messages(report, "warning").join("\n"), /no artifacts/);
  });
});

describe("configured artifact tables are identifiers (L4)", () => {
  for (const bad of [
    "sys_script^NQactive=true",
    "Sys_Script",
    "sys.script",
    "sys script",
  ]) {
    it(`refuses ${JSON.stringify(bad)} before any read`, async () => {
      const reader = healthyReader();
      await assert.rejects(
        () => resolveScope(reader, SCOPE_NAME, { artifactTables: [bad] }),
        ResolutionInputError,
      );
      assert.equal(reader.requests.length, 0);
    });
  }

  it("still reads nothing, and refuses nothing, when no scope was named", async () => {
    const reader = healthyReader();
    const report = await createScopeResolver(reader, {
      artifactTables: ["sys_script^NQactive=true"],
    }).resolveWithReport(ctx(), {});
    assert.deepEqual(report.artifacts, []);
    assert.equal(reader.requests.length, 0);
  });
});

describe("the port and the report agree", () => {
  it("resolve() is resolveWithReport() with the notes dropped", async () => {
    const resolver = createScopeResolver(healthyReader());
    const input = { scope: SCOPE_NAME };
    const artifacts = await resolver.resolve(ctx(), input);
    const report = await resolver.resolveWithReport(ctx(), input);

    assert.equal(resolver.source, "scope");
    assert.deepEqual(artifacts, [...report.artifacts]);
    // A mutable copy: a caller pushing onto it cannot reach the report the CLI
    // is about to print.
    artifacts.push("not an artifact");
    assert.equal(report.artifacts.length, 2);
  });

  it("resolve() refuses to hand back a partial resolution (H1)", async () => {
    const resolver = createScopeResolver(
      healthyReader({
        sys_script_include: answered(INCLUDE_ROWS, { truncated: true }),
      }),
    );
    await assert.rejects(
      () => resolver.resolve(ctx(), { scope: SCOPE_NAME }),
      (error) =>
        error instanceof ResolutionFaultError &&
        /incomplete/.test(error.message),
    );
  });
});

// ── adapter half ────────────────────────────────────────────────────────────

const SOURCE_HOST = "dev-scope-source.service-now.com";

const ENV_KEYS = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH",
  "SN_DOCS_DIR",
  "SN_READONLY",
  "SN_ACTIVE_PROFILE",
  "SN_ALLOWED_HOSTS",
  "SN_MAX_RETRIES",
  "SN_MAX_RECORDS",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
  "SN_PROFILE_SOURCE_INSTANCE",
  "SN_PROFILE_SOURCE_USER",
  "SN_PROFILE_SOURCE_PASSWORD",
];

/**
 * One fake instance behind the real transport, reachable only through the
 * `source` profile. No default profile is configured on purpose: if the profile
 * plumbing ever stopped working, the read has to fail loudly rather than answer
 * from some ambient instance (ARCH-19).
 */
function withFake({ includes, readAcl, maxRecords } = {}) {
  const fake = createFakeInstance({
    host: SOURCE_HOST,
    ...(readAcl === undefined ? {} : { readAcl }),
    state: {
      sys_scope: [
        { sys_id: SCOPE_SYS_ID, scope: SCOPE_NAME, name: "Tessera Demo" },
      ],
      // Seeded out of alphabetical order so `ORDERBYname` has something to do,
      // and without sys_ids so the fake mints real 32-hex ones.
      sys_script_include: includes ?? [
        { name: "ZoneLookup", sys_scope: SCOPE_SYS_ID, script: "var Z = {};" },
        {
          name: "AmountCalculator",
          sys_scope: SCOPE_SYS_ID,
          script: "var A = {};",
        },
        // A neighbouring application's include: it must not be enumerated.
        {
          name: "OtherAppThing",
          sys_scope: "eeee0000000000000000000000000005",
          script: "var O = {};",
        },
      ],
    },
  });
  const restoreFetch = fake.install();

  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(os.tmpdir(), "tessera-scope-docs");
  // One shot per read. The transport retries idempotent GETs by default, which
  // would let a single-fire fault be papered over by the retry.
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_PROFILE_SOURCE_INSTANCE = SOURCE_HOST;
  process.env.SN_PROFILE_SOURCE_USER = "tessera";
  process.env.SN_PROFILE_SOURCE_PASSWORD = "tessera";
  delete process.env.SN_INSTANCE;
  delete process.env.SN_USER;
  delete process.env.SN_PASSWORD;
  delete process.env.SN_READONLY;
  delete process.env.SN_ACTIVE_PROFILE;
  delete process.env.SN_TABLES_ALLOW;
  delete process.env.SN_TABLES_DENY;
  if (maxRecords === undefined) delete process.env.SN_MAX_RECORDS;
  else process.env.SN_MAX_RECORDS = String(maxRecords);
  reloadCredentialsFromEnv();

  return {
    fake,
    resolver: createScopeResolver(createSnRecordReader("source")),
    restore() {
      restoreFetch();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    },
  };
}

/** Every method the fake served — used to prove this stage only ever reads. */
function methods(fake) {
  return [...new Set(fake.requests().map((r) => r.method))].sort();
}

describe("against a live fake instance", () => {
  it("enumerates the scope's script includes, and only ever GETs", async () => {
    const h = withFake();
    try {
      const report = await h.resolver.resolveWithReport(ctx(), {
        scope: SCOPE_NAME,
      });

      assert.deepEqual(
        report.artifacts.map((a) => a.ref.name),
        ["AmountCalculator", "ZoneLookup"],
      );
      // Real minted ids, and the same ones the instance is holding.
      const stored = new Map(
        h.fake.tables
          .all("sys_script_include")
          .map((row) => [row.name, row.sys_id]),
      );
      for (const artifact of report.artifacts) {
        assert.match(artifact.ref.sysId, /^[0-9a-f]{32}$/);
        assert.equal(artifact.ref.sysId, stored.get(artifact.ref.name));
        assert.equal(artifact.ref.table, "sys_script_include");
        assert.equal(artifact.resolvedBy, "scope");
      }
      // The neighbouring application stayed out of it.
      assert.equal(report.artifacts.length, 2);
      assert.equal(isIncomplete(report), false);
      // ARCH-8: there is no write path in this stage, on any instance.
      assert.deepEqual(methods(h.fake), ["GET"]);
    } finally {
      h.restore();
    }
  });

  it("resolves the same scope by its sys_id", async () => {
    const h = withFake();
    try {
      const report = await h.resolver.resolveWithReport(ctx(), {
        scope: SCOPE_SYS_ID,
      });

      assert.equal(report.artifacts.length, 2);
      assert.deepEqual(methods(h.fake), ["GET"]);
    } finally {
      h.restore();
    }
  });

  it("turns a refused artifact read into a fault, never an empty list", async () => {
    const h = withFake();
    try {
      h.fake.faults.add({
        match: { table: "sys_script_include" },
        mode: { kind: "http-error", status: 403, message: "no read access" },
      });

      await assert.rejects(
        () => h.resolver.resolveWithReport(ctx(), { scope: SCOPE_NAME }),
        ResolutionFaultError,
      );
      // The scope itself was found — the fault is about its contents.
      assert.equal(
        h.fake.requests().filter((r) => r.path.includes("sys_scope")).length,
        1,
      );
      assert.deepEqual(methods(h.fake), ["GET"]);
    } finally {
      h.restore();
    }
  });

  // Delegated decision 2026-09-26: the two partial cases the live transport
  // can produce here, end to end. A row read-ACL shortens the page while
  // X-Total-Count still counts the hidden row; a small SN_MAX_RECORDS stops
  // the read on the cap. Different advice, same fail-closed verdict.
  it("words a page the read ACLs shortened as a short page, not the cap", async () => {
    const h = withFake({
      readAcl: {
        rules: [
          {
            table: "sys_script_include",
            when: (row) => row.name === "ZoneLookup",
          },
        ],
      },
    });
    try {
      const report = await h.resolver.resolveWithReport(ctx(), {
        scope: SCOPE_NAME,
      });

      assert.deepEqual(
        report.artifacts.map((a) => a.ref.name),
        ["AmountCalculator"],
      );
      const warning = messages(report, "warning").join("\n");
      assert.match(
        warning,
        /sys_script_include enumeration came back short: X-Total-Count reports 2 matching rows but only 1 were returned/,
      );
      assert.match(warning, /raising SN_MAX_RECORDS will not help/);
      assert.doesNotMatch(warning, /stopped at the SN_MAX_RECORDS cap/);
      assert.equal(isIncomplete(report), true);
      assert.deepEqual(methods(h.fake), ["GET"]);
    } finally {
      h.restore();
    }
  });

  it("words a read stopped by a small SN_MAX_RECORDS as the cap", async () => {
    const h = withFake({ maxRecords: 1 });
    try {
      const report = await h.resolver.resolveWithReport(ctx(), {
        scope: SCOPE_NAME,
      });

      assert.equal(report.artifacts.length, 1);
      const warning = messages(report, "warning").join("\n");
      assert.match(
        warning,
        /sys_script_include enumeration hit the SN_MAX_RECORDS cap \(1 of 2 matching rows read/,
      );
      assert.doesNotMatch(warning, /came back short/);
      assert.equal(isIncomplete(report), true);
    } finally {
      h.restore();
    }
  });

  it("reports an application that really is empty as empty, and incomplete (M3)", async () => {
    // The counterpart of the test above: same shape of answer, opposite cause,
    // and the two must not be reachable by the same code path. An empty answer
    // cannot be told apart from rows an ACL hid (OPP-1b), so it is a warning.
    const h = withFake({ includes: [] });
    try {
      const report = await h.resolver.resolveWithReport(ctx(), {
        scope: SCOPE_NAME,
      });

      assert.deepEqual(report.artifacts, []);
      assert.equal(isIncomplete(report), true);
      assert.match(messages(report, "info")[1], /0 artifact/);
      assert.match(messages(report, "warning").join("\n"), /no artifacts/);
    } finally {
      h.restore();
    }
  });
});

// The Table API renders "no such scope" and "a scope this caller is not shown"
// as the same empty result set (OPP-1b), and the input error above is the only
// thing an operator gets. Stating one reading tells them to install an
// application that may already be sitting there, unreadable.
describe("an empty answer about a scope", () => {
  it("names both readings, not just the one that assumes full visibility", async () => {
    const reader = healthyReader({ sys_scope: answered([]) });

    await assert.rejects(
      () => resolveScope(reader, "x_snc_nope"),
      (error) => {
        assert.equal(error.name, "ResolutionInputError");
        // The provable half stays: the instance did answer.
        assert.match(error.message, /the instance answered/);
        // The half the empty set cannot decide is offered rather than settled.
        assert.match(error.message, /cannot read|ACL|not shown/i);
        return true;
      },
    );
  });
});

// ── review 2026-09-25: encoded-query injection ──────────────────────────────

describe("a --scope argument is a value, never a query fragment", () => {
  for (const bad of [
    "x_mine^NQscope=x_other",
    "x_mine^ORscope=x_other",
    "scope=x",
    "a,b",
    "a@b",
    "a\rb",
    "a\nb",
  ]) {
    it(`refuses ${JSON.stringify(bad)} without sending a query`, async () => {
      const reader = healthyReader();
      await assert.rejects(() => resolveScope(reader, bad), {
        name: "ResolutionInputError",
        message: /encoded-query syntax/,
      });
      assert.equal(reader.requests.length, 0);
    });
  }

  it("refuses a row that is not the scope that was named", async () => {
    const reader = healthyReader({
      sys_scope: answered([
        {
          sys_id: "dddd0000000000000000000000000004",
          scope: "x_other",
          name: "Other",
        },
      ]),
    });
    await assert.rejects(() => resolveScope(reader, "x_mine"), {
      name: "ResolutionInputError",
      message: /not the scope that was named/,
    });
    assert.equal(reader.requests.length, 1);
  });

  it("refuses a row whose sys_id is not the one that was named", async () => {
    const reader = healthyReader({
      sys_scope: answered([
        { ...SCOPE_ROW, sys_id: "dddd0000000000000000000000000004" },
      ]),
    });
    await assert.rejects(() => resolveScope(reader, SCOPE_SYS_ID), {
      name: "ResolutionInputError",
    });
    assert.equal(reader.requests.length, 1);
  });

  it("still accepts a row matched by its name column", async () => {
    const reader = healthyReader();
    const report = await resolveScope(reader, "Tessera Demo");
    assert.equal(report.artifacts.length, 2);
  });

  it("faults before interpolating a scope sys_id that is not one", async () => {
    const reader = healthyReader({
      sys_scope: answered([{ ...SCOPE_ROW, sys_id: "x^NQsys_scope=y" }]),
    });
    await assert.rejects(() => resolveScope(reader), ResolutionFaultError);
    assert.equal(reader.requests.length, 1);
  });
});
