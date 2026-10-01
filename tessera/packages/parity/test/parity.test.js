// ARCH-20 code-version parity — PLAN Phase 1.
//
// Two halves, and the split is deliberate.
//
//  * The DECISION half runs against a stubbed reader. What is under test there
//    is the decision table — which pair of reads produces which outcome, and
//    how the outcomes roll up — and an instance in the picture would only add
//    ways for the test to pass for the wrong reason.
//
//  * The ADAPTER half runs the real `@tessera/sn-client` transport against TWO
//    QA-18 stateful fakes, one per profile. Those assertions are about HTTP and
//    about the profile plumbing: that source and runner are genuinely different
//    instances, that a 403 is never a green, and that nothing but GET is sent.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import { createHash } from "node:crypto";

import {
  EXECUTABLE_FIELDS_BY_TABLE,
  ParityContractError,
  SCRIPT_FIELDS_BY_TABLE,
  comparableTables,
  createParityCheck,
  createSnArtifactReader,
  executableFieldsFor,
  fingerprint,
  fingerprintRecord,
  formatParityReport,
  rollUpParity,
  scriptFieldsFor,
  uncomparedFor,
  relatedFor,
  RELATED_ROW_LIMIT,
} from "../build/index.js";

// ── decision half ───────────────────────────────────────────────────────────

const RULE = {
  table: "sys_script",
  sysId: "aaaa0000000000000000000000000001",
  name: "Tessera demo rule",
};

const POLICY = {
  table: "sys_ui_policy",
  sysId: "bbbb0000000000000000000000000002",
  name: "Tessera demo policy",
};

const TOPOLOGY = { source: "dev", runner: "test" };

/** The instance host each stub profile resolves to (M5: sides are hosts). */
const HOSTS = { dev: "dev.service-now.com", test: "test.service-now.com" };

/**
 * Every executable field a readable record of the table carries, non-blank
 * where a readable record can never render blank. A stub entry's `record` is
 * laid over this, so a test states only the fields it is about; `bare: true`
 * opts out and the record carries exactly what the test wrote.
 */
const BASELINE = {
  sys_script: {
    active: "true",
    when: "before",
    collection: "incident",
    order: "100",
    action_insert: "true",
    action_update: "true",
    action_delete: "false",
    action_query: "false",
    advanced: "true",
    // Wave 14: a blank optional field is no longer proven readable by its
    // neighbours, so the baseline carries real values; a test about blanks
    // writes them itself.
    condition: "current.priority == 1",
    filter_condition: "active=true^EQ",
  },
  sys_ui_policy: {
    active: "true",
    table: "incident",
    run_scripts: "true",
    on_load: "true",
    reverse_if_false: "true",
    conditions: "active=true^EQ",
  },
  sys_security_acl: {
    active: "true",
    name: "incident",
    operation: "read",
    type: "record",
    admin_overrides: "true",
    advanced: "true",
    decision_type: "allow",
    condition: "active=true^EQ",
  },
  sys_script_include: {
    active: "true",
    api_name: "global.TesseraDemo",
    access: "package_private",
    client_callable: "false",
  },
};

function hostStub(hosts) {
  return (profile) =>
    hosts[profile] === undefined
      ? { ok: false, reason: `profile ${profile} has no instance configured` }
      : { ok: true, host: hosts[profile] };
}

/**
 * A reader over two in-memory sides. Each entry is either `{ record }` (the
 * instance answered with a row), `{ undecidable }` (it answered with something
 * unusable) or absent (the row is not there).
 */
function readerFrom(sides, hosts = HOSTS) {
  const calls = [];
  return {
    calls,
    instanceHost: hostStub(hosts),
    readArtifact(profile, table, sysId, fields, signal) {
      calls.push({ profile, table, sysId, fields: [...fields] });
      if (signal?.aborted === true) {
        return Promise.resolve({
          outcome: "undecidable",
          detail: "aborted before the read reached the instance",
        });
      }
      const entry = (sides[profile] ?? {})[`${table}/${sysId}`];
      if (entry === undefined) {
        return Promise.resolve({
          outcome: "absent",
          status: 404,
          detail: `${table}/${sysId}: no readable row on ${profile}`,
        });
      }
      if (entry.undecidable !== undefined) {
        return Promise.resolve({
          outcome: "undecidable",
          detail: entry.undecidable,
        });
      }
      return Promise.resolve({
        outcome: "found",
        status: 200,
        // The identity a real single-record read carries; an entry may still
        // override it to play a reader that answered about another row.
        record:
          entry.record === undefined
            ? undefined
            : entry.bare === true
              ? { sys_id: sysId, ...entry.record }
              : { sys_id: sysId, ...BASELINE[table], ...entry.record },
        detail: `${table}/${sysId} read on ${profile}`,
      });
    },
  };
}

/** One artifact on both sides, keyed the way the reader expects. */
function bothSides(artifact, source, runner) {
  const key = `${artifact.table}/${artifact.sysId}`;
  return {
    dev: source === undefined ? {} : { [key]: source },
    test: runner === undefined ? {} : { [key]: runner },
  };
}

async function checkOne(sides, artifacts = [RULE], extra = {}) {
  const reader = readerFrom(sides);
  const report = await createParityCheck(reader).check({
    artifacts,
    topology: TOPOLOGY,
    ...extra,
  });
  return { report, reader };
}

function rowFor(report, artifact) {
  const row = report.rows.find((r) => r.artifact.sysId === artifact.sysId);
  assert.ok(row, `expected a row for ${artifact.sysId}`);
  return row;
}

describe("one artifact, one verdict", () => {
  it("matches when both sides carry the same script", async () => {
    const { report } = await checkOne(
      bothSides(
        RULE,
        { record: { script: "gs.info('v1');" } },
        { record: { script: "gs.info('v1');" } },
      ),
    );

    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "match");
    // H2: the scope is every executable field, not the script body alone.
    assert.deepEqual(row.fields, executableFieldsFor("sys_script"));
    assert.ok(row.fields.includes("script"));
    assert.ok(row.fields.includes("when"));
    assert.equal(row.sourceFingerprint, row.runnerFingerprint);
    assert.notEqual(row.evidence, "");
    assert.equal(report.status, "match");
    assert.equal(report.preflightFailure, undefined);
    assert.equal(report.inconclusive, undefined);
  });

  it("differs on a single changed character", async () => {
    const { report } = await checkOne(
      bothSides(
        RULE,
        { record: { script: "gs.info('v1');" } },
        { record: { script: "gs.info('v2');" } },
      ),
    );

    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "differs");
    assert.notEqual(row.sourceFingerprint, row.runnerFingerprint);
    assert.match(row.evidence, /dev .* != test /);
    assert.equal(report.status, "mismatch");
    // PLAN maps a mismatch to a HARD preflight failure, so the report says so
    // rather than making the caller re-derive it (ARCH-28/DEV-17).
    assert.match(report.preflightFailure, /does not carry the tested version/);
    assert.equal(report.inconclusive, undefined);
  });

  it("ignores the audit fields two instances always disagree on", async () => {
    // Identical code, different sys_updated_on/sys_mod_count — exactly what an
    // update set import produces. Folding those in would report every healthy
    // promotion as a mismatch.
    const { report } = await checkOne(
      bothSides(
        RULE,
        {
          record: {
            script: "gs.info('v1');",
            sys_updated_on: "2026-01-01 10:00:00",
            sys_mod_count: "4",
          },
        },
        {
          record: {
            script: "gs.info('v1');",
            sys_updated_on: "2026-07-09 22:31:07",
            sys_mod_count: "17",
          },
        },
      ),
    );

    assert.equal(rowFor(report, RULE).outcome, "match");
  });

  it("reports a row the runner does not carry", async () => {
    const { report } = await checkOne(
      bothSides(RULE, { record: { script: "gs.info('v1');" } }, undefined),
    );

    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "missing-on-runner");
    assert.match(row.evidence, /cannot execute a version it does not carry/);
    assert.equal(report.status, "mismatch");
  });

  it("reports a row the source no longer has", async () => {
    const { report } = await checkOne(
      bothSides(RULE, undefined, { record: { script: "gs.info('v1');" } }),
    );

    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "missing-on-source");
    assert.match(row.evidence, /no longer describes the source/);
    assert.equal(report.status, "mismatch");
  });

  it("blames the source first when the row is absent on both sides", async () => {
    // The artifact set came FROM the source. "Deploy it to the runner" would be
    // the wrong advice when the source cannot show the row either.
    const { report } = await checkOne(bothSides(RULE, undefined, undefined));

    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "missing-on-source");
    assert.match(row.evidence, /not on the runner either/);
  });
});

describe("a read that decided nothing", () => {
  it("is undecidable, and says which side and why", async () => {
    const denied = await checkOne(
      bothSides(
        RULE,
        { record: { script: "gs.info('v1');" } },
        { undecidable: "sys_script/x on test: read refused (403)" },
      ),
    );
    const timedOut = await checkOne(
      bothSides(
        RULE,
        { record: { script: "gs.info('v1');" } },
        {
          undecidable:
            "sys_script/x on test: The operation was aborted due to timeout",
        },
      ),
    );

    for (const { report } of [denied, timedOut]) {
      const row = rowFor(report, RULE);
      assert.equal(row.outcome, "undecidable");
      assert.match(row.evidence, /^runner \(test\)/);
      assert.equal(report.status, "undecidable");
      assert.match(report.inconclusive, /could not be decided/);
      assert.equal(report.preflightFailure, undefined);
    }

    // A refusal and a stall must not collapse into the same line: one is an
    // access problem, the other is a reachability problem.
    assert.match(rowFor(denied.report, RULE).evidence, /403/);
    assert.match(rowFor(timedOut.report, RULE).evidence, /timeout/);
    assert.notEqual(
      rowFor(denied.report, RULE).evidence,
      rowFor(timedOut.report, RULE).evidence,
    );
  });

  it("keeps an undecided source apart from an undecided runner", async () => {
    const { report } = await checkOne(
      bothSides(
        RULE,
        { undecidable: "sys_script/x on dev: connection reset" },
        { record: { script: "gs.info('v1');" } },
      ),
    );

    assert.match(rowFor(report, RULE).evidence, /^source \(dev\)/);
  });

  it("refuses to call an unfingerprintable table a match (QA-9)", async () => {
    const opaque = {
      table: "x_snc_custom_thing",
      sysId: "cccc0000000000000000000000000003",
      name: "not a script table",
    };
    const { report, reader } = await checkOne({}, [opaque]);

    const row = rowFor(report, opaque);
    assert.equal(row.outcome, "undecidable");
    assert.match(
      row.evidence,
      /x_snc_custom_thing is not in the executable-field index/,
    );
    // Named alternatives, not a bare refusal.
    assert.match(row.evidence, /sys_script/);
    assert.equal(report.status, "undecidable");
    // Decided locally: there was nothing worth asking an instance.
    assert.equal(reader.calls.length, 0);
  });

  it("refuses an artifact ref with no row identity", async () => {
    const { report, reader } = await checkOne({}, [
      { table: "sys_script", sysId: "", name: "resolved without a sys_id" },
    ]);

    assert.equal(report.rows[0].outcome, "undecidable");
    assert.match(report.rows[0].evidence, /no table\/sys_id/);
    assert.equal(reader.calls.length, 0);
  });
});

describe("artifacts with more than one executable field", () => {
  const same = { script_true: "onTrue();", script_false: "onFalse();" };

  it("catches a change in either field of a UI policy", async () => {
    assert.deepEqual(scriptFieldsFor("sys_ui_policy"), [
      "script_true",
      "script_false",
    ]);

    const trueChanged = await checkOne(
      bothSides(
        POLICY,
        { record: same },
        { record: { ...same, script_true: "onTrue2();" } },
      ),
      [POLICY],
    );
    const falseChanged = await checkOne(
      bothSides(
        POLICY,
        { record: same },
        { record: { ...same, script_false: "onFalse2();" } },
      ),
      [POLICY],
    );

    assert.equal(rowFor(trueChanged.report, POLICY).outcome, "differs");
    assert.equal(rowFor(falseChanged.report, POLICY).outcome, "differs");
    assert.deepEqual(
      rowFor(trueChanged.report, POLICY).fields,
      executableFieldsFor("sys_ui_policy"),
    );
  });

  it("catches two fields trading content", async () => {
    // A plain join of the field values would hash these two rows identically.
    const { report } = await checkOne(
      bothSides(
        POLICY,
        { record: { script_true: "A", script_false: "B" } },
        { record: { script_true: "B", script_false: "A" } },
      ),
      [POLICY],
    );

    assert.equal(rowFor(report, POLICY).outcome, "differs");
  });

  it("catches a field boundary moving", async () => {
    const { report } = await checkOne(
      bothSides(
        POLICY,
        { record: { script_true: "ab", script_false: "" } },
        { record: { script_true: "a", script_false: "b" } },
      ),
      [POLICY],
    );

    assert.equal(rowFor(report, POLICY).outcome, "differs");
  });

  it("never calls identical multi-field sides a clean match: the policy actions are not compared", async () => {
    const { report } = await checkOne(
      bothSides(POLICY, { record: same }, { record: { ...same } }),
      [POLICY],
    );

    const row = rowFor(report, POLICY);
    // H2 fail-closed: what a UI policy DOES lives partly in its
    // sys_ui_policy_action rows, which this stage does not read.
    assert.equal(row.outcome, "undecidable");
    assert.match(row.evidence, /identical on dev and test over/);
    assert.match(row.evidence, /sys_ui_policy_action/);
    assert.equal(row.sourceFingerprint, row.runnerFingerprint);
  });
});

describe("rollUpParity — precedence", () => {
  const row = (outcome) => ({
    artifact: RULE,
    outcome,
    evidence: "stub",
    fields: ["script"],
  });

  it("lets a proven mismatch dominate an undecided read", () => {
    // The reverse of the doctor's precedence, and on purpose: PLAN sends a
    // mismatch to a hard preflight failure and an undecidable to `inconclusive`,
    // so the more specific fact must survive.
    assert.equal(
      rollUpParity([row("undecidable"), row("differs")]),
      "mismatch",
    );
    assert.equal(
      rollUpParity([
        row("match"),
        row("undecidable"),
        row("missing-on-runner"),
      ]),
      "mismatch",
    );
  });

  it("lets an undecided read outrank a match", () => {
    assert.equal(
      rollUpParity([row("match"), row("undecidable")]),
      "undecidable",
    );
  });

  it("is a match only when every row matched", () => {
    assert.equal(rollUpParity([row("match"), row("match")]), "match");
    assert.equal(rollUpParity([]), "match");
  });

  it("agrees with what the check reports over mixed rows", async () => {
    const key = (a) => `${a.table}/${a.sysId}`;
    const { report } = await checkOne(
      {
        dev: {
          [key(RULE)]: { record: { script: "v1" } },
          [key(POLICY)]: { record: { script_true: "t", script_false: "f" } },
        },
        test: {
          [key(RULE)]: { undecidable: "sys_script on test: 500" },
          [key(POLICY)]: { record: { script_true: "t2", script_false: "f" } },
        },
      },
      [RULE, POLICY],
    );

    assert.equal(report.rows.length, 2);
    assert.equal(rowFor(report, RULE).outcome, "undecidable");
    assert.equal(rowFor(report, POLICY).outcome, "differs");
    assert.equal(report.status, "mismatch");
    assert.equal(report.status, rollUpParity(report.rows));
    assert.match(report.summary, /1 out of parity, 1 undecided/);
  });
});

describe("what parity refuses to answer", () => {
  it("reports a collapsed topology out loud", async () => {
    const reader = readerFrom({});
    const report = await createParityCheck(reader).check({
      artifacts: [RULE],
      // Same instance under both roles, whitespace and all.
      topology: { source: " dev ", runner: "dev" },
    });

    assert.equal(report.status, "not-applicable");
    assert.match(report.summary, /nothing was verified/);
    assert.deepEqual(report.rows, []);
    assert.equal(reader.calls.length, 0);
    // Not a pass: neither consequence field is set.
    assert.equal(report.preflightFailure, undefined);
    assert.equal(report.inconclusive, undefined);
  });

  it("does not let an empty artifact set read as a green", async () => {
    const { report } = await checkOne({}, []);

    assert.equal(report.status, "not-applicable");
    assert.match(report.summary, /not the same as parity holding/);
  });

  it("resolves rows as undecidable when the caller has already given up", async () => {
    const { report, reader } = await checkOne(
      bothSides(
        RULE,
        { record: { script: "v1" } },
        { record: { script: "v1" } },
      ),
      [RULE, POLICY],
      { signal: AbortSignal.abort() },
    );

    assert.equal(report.rows.length, 2);
    for (const row of report.rows) {
      assert.equal(row.outcome, "undecidable");
      assert.match(row.evidence, /aborted/);
    }
    assert.equal(report.status, "undecidable");
    assert.equal(reader.calls.length, 0);
  });

  it("throws only for a topology it cannot honestly read", async () => {
    const check = createParityCheck(readerFrom({}));
    await assert.rejects(
      () =>
        check.check({
          artifacts: [RULE],
          topology: { source: "", runner: "test" },
        }),
      ParityContractError,
    );
    await assert.rejects(
      () =>
        check.check({
          artifacts: [RULE],
          topology: { source: "dev", runner: "  " },
        }),
      ParityContractError,
    );
  });
});

describe("the report as a human reads it", () => {
  it("carries the status, the rows and the standing disclaimer", async () => {
    const { report } = await checkOne(
      bothSides(
        RULE,
        { record: { script: "v1" } },
        { record: { script: "v2" } },
      ),
    );
    const text = formatParityReport(report);

    assert.match(
      text,
      /^parity: mismatch \(source=dev \[dev\.service-now\.com\], runner=test \[test\.service-now\.com\]\)/,
    );
    assert.match(text, /\[differs\] sys_script\//);
    assert.match(text, /PREFLIGHT FAILURE:/);
    // ARCH-20: this stage never deploys, and every report says so.
    assert.match(text, /never deploys source -> runner/);
  });
});

describe("the executable-field index", () => {
  it("is derived from the sn-client script types, not re-typed", () => {
    assert.deepEqual(SCRIPT_FIELDS_BY_TABLE.get("sys_script"), ["script"]);
    assert.deepEqual(SCRIPT_FIELDS_BY_TABLE.get("sys_ws_operation"), [
      "operation_script",
    ]);
    assert.equal(scriptFieldsFor("incident"), undefined);
  });

  it("hashes only the fields it was given", () => {
    const a = fingerprint({ script: "x", sys_mod_count: "1" }, ["script"]);
    const b = fingerprint({ script: "x", sys_mod_count: "99" }, ["script"]);
    assert.equal(a, b);
    assert.notEqual(a, fingerprint({ script: "y" }, ["script"]));
    // M4 (2026-09-26): with no table to prove the record readable, a BLANK
    // field is no more a value than an ABSENT one — both refuse to hash.
    assert.throws(() => fingerprint({ script: "" }, ["script"]), /blank/);
    assert.throws(() => fingerprint({}, ["script"]), ParityContractError);
  });
});

// ── adapter half ────────────────────────────────────────────────────────────

const SOURCE_HOST = "dev-parity-source.service-now.com";
const RUNNER_HOST = "dev-parity-runner.service-now.com";

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
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
  "SN_PROFILE_SOURCE_INSTANCE",
  "SN_PROFILE_SOURCE_USER",
  "SN_PROFILE_SOURCE_PASSWORD",
  "SN_PROFILE_RUNNER_INSTANCE",
  "SN_PROFILE_RUNNER_USER",
  "SN_PROFILE_RUNNER_PASSWORD",
];

const LIVE_TOPOLOGY = { source: "source", runner: "runner" };

function state(script) {
  return script === undefined
    ? { sys_script: [] }
    : {
        sys_script: [
          {
            sys_id: RULE.sysId,
            name: RULE.name,
            ...BASELINE.sys_script,
            script,
          },
        ],
      };
}

/**
 * Two fakes, one `fetch`.
 *
 * `FakeInstance.install()` swaps the single `globalThis.fetch`, so two fakes
 * cannot both be installed. Routing on the request host instead keeps each
 * profile pointed at a genuinely separate instance while the real transport
 * still does the whole profile -> credentials -> host resolution — which is the
 * part these tests exist to exercise.
 */
function withFakes({
  sourceScript,
  runnerScript,
  sourceState,
  runnerState,
  sourceOptions = {},
  runnerOptions = {},
} = {}) {
  const source = createFakeInstance({
    host: SOURCE_HOST,
    state: sourceState ?? state(sourceScript),
    ...sourceOptions,
  });
  const runner = createFakeInstance({
    host: RUNNER_HOST,
    state: runnerState ?? state(runnerScript),
    ...runnerOptions,
  });
  const routes = { [SOURCE_HOST]: source, [RUNNER_HOST]: runner };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const fake = routes[new URL(href).host];
    if (fake === undefined) {
      return Promise.reject(new Error(`no fake instance for ${href}`));
    }
    return fake.fetch(input, init);
  };

  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(os.tmpdir(), "tessera-parity-docs");
  // One shot per read. The transport retries idempotent GETs by default, which
  // would let a single-fire fault be papered over by the retry.
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_PROFILE_SOURCE_INSTANCE = SOURCE_HOST;
  process.env.SN_PROFILE_SOURCE_USER = "tessera";
  process.env.SN_PROFILE_SOURCE_PASSWORD = "tessera";
  process.env.SN_PROFILE_RUNNER_INSTANCE = RUNNER_HOST;
  process.env.SN_PROFILE_RUNNER_USER = "tessera";
  process.env.SN_PROFILE_RUNNER_PASSWORD = "tessera";
  // No default profile on purpose: if the per-request profile plumbing ever
  // stopped working, the read must fail loudly instead of quietly answering
  // from one ambient instance twice and reporting a match.
  delete process.env.SN_INSTANCE;
  delete process.env.SN_USER;
  delete process.env.SN_PASSWORD;
  delete process.env.SN_READONLY;
  delete process.env.SN_ACTIVE_PROFILE;
  delete process.env.SN_TABLES_ALLOW;
  delete process.env.SN_TABLES_DENY;
  reloadCredentialsFromEnv();

  return {
    source,
    runner,
    check: createParityCheck(createSnArtifactReader()),
    restore() {
      globalThis.fetch = realFetch;
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    },
  };
}

/** Every method both fakes served — used to prove parity only ever reads. */
function methods(...fakes) {
  return [
    ...new Set(fakes.flatMap((f) => f.requests().map((r) => r.method))),
  ].sort();
}

describe("against two live fake instances", () => {
  it("matches identical rows on two separate instances, and only ever GETs", async () => {
    const h = withFakes({
      sourceScript: "gs.info('shared');",
      runnerScript: "gs.info('shared');",
    });
    try {
      const report = await h.check.check({
        artifacts: [RULE],
        topology: LIVE_TOPOLOGY,
      });

      assert.equal(report.status, "match");
      assert.equal(report.rows[0].outcome, "match");
      // Both sides were really asked — one instance answering twice would be
      // the bug this whole check exists to catch.
      assert.equal(h.source.requests().length, 1);
      assert.equal(h.runner.requests().length, 1);
      // ARCH-8/ARCH-33: read-only, so it is safe on any instance in the pipeline.
      assert.deepEqual(methods(h.source, h.runner), ["GET"]);
    } finally {
      h.restore();
    }
  });

  it("differs when the runner carries another version", async () => {
    const h = withFakes({
      sourceScript: "gs.info('v2');",
      runnerScript: "gs.info('v1');",
    });
    try {
      const report = await h.check.check({
        artifacts: [RULE],
        topology: LIVE_TOPOLOGY,
      });

      assert.equal(report.status, "mismatch");
      assert.equal(report.rows[0].outcome, "differs");
      assert.notEqual(
        report.rows[0].sourceFingerprint,
        report.rows[0].runnerFingerprint,
      );
      assert.deepEqual(methods(h.source, h.runner), ["GET"]);
    } finally {
      h.restore();
    }
  });

  it("reads a record-level 404 on the runner as a missing artifact", async () => {
    const h = withFakes({ sourceScript: "gs.info('v1');" });
    try {
      const report = await h.check.check({
        artifacts: [RULE],
        topology: LIVE_TOPOLOGY,
      });

      assert.equal(report.rows[0].outcome, "missing-on-runner");
      assert.equal(report.status, "mismatch");
    } finally {
      h.restore();
    }
  });

  it("never turns a refused or dropped read into a green", async () => {
    const h = withFakes({
      sourceScript: "gs.info('v1');",
      runnerScript: "gs.info('v1');",
    });
    try {
      h.runner.faults.add({
        match: { table: "sys_script", times: 1 },
        mode: { kind: "http-error", status: 403, message: "no read access" },
      });
      const denied = await h.check.check({
        artifacts: [RULE],
        topology: LIVE_TOPOLOGY,
      });
      assert.equal(denied.status, "undecidable");
      assert.match(denied.rows[0].evidence, /403/);

      h.runner.faults.add({
        match: { table: "sys_script", times: 1 },
        mode: { kind: "transport-error", message: "connection reset" },
      });
      const dropped = await h.check.check({
        artifacts: [RULE],
        topology: LIVE_TOPOLOGY,
      });
      assert.equal(dropped.status, "undecidable");
      assert.match(dropped.rows[0].evidence, /connection reset/);
    } finally {
      h.restore();
    }
  });

  it("cannot decide when the table itself is not a resource", async () => {
    // A namespace 404 says nothing about the row, so it must not be read as
    // "the artifact is missing" — same discriminator the doctor's probe uses.
    const h = withFakes({
      sourceScript: "gs.info('v1');",
      runnerScript: "gs.info('v1');",
    });
    try {
      h.runner.faults.add({
        match: { table: "sys_script" },
        mode: {
          kind: "http-error",
          status: 404,
          message:
            "The requested URI does not represent any resource on the server",
        },
      });
      const report = await h.check.check({
        artifacts: [RULE],
        topology: LIVE_TOPOLOGY,
      });

      assert.equal(report.rows[0].outcome, "undecidable");
      assert.match(report.rows[0].evidence, /not a resource on this instance/);
      // And the namespace reading is itself one session's: a table outside
      // this caller's scope answers exactly like a table nobody installed, so
      // the line names both ways it can be true — the same move the doctor's
      // `classifyTable` makes on the same status.
      assert.match(
        report.rows[0].evidence,
        /either the table is not there at all/,
      );
      assert.match(report.rows[0].evidence, /cannot resolve it/);
    } finally {
      h.restore();
    }
  });

  // The DEV-1 error boundary of `src/reader.ts`, stated as the claim rather
  // than the mechanism. The reader's 403 evidence says the read was "refused
  // for the connected user", which asserts the INSTANCE answered — true only
  // because this adapter calls `snRequest` directly. `@tessera/sn-client`
  // fabricates an identical 403 `ServiceNowError` in `assertTableAllowed` when
  // SN_TABLES_ALLOW/SN_TABLES_DENY refuses a table, before anything is sent;
  // that guard lives in the `tableApi` layer, which nothing here touches.
  // `@tessera/resolvers` IS on that path and has to word its 403 under both
  // readings. Move this read onto `tableApi` and parity would blame a
  // production instance for the operator's own environment file — with a
  // verdict that still reads `undecidable`, so nothing else would notice.
  it("never blames the instance for a denial the client itself fabricated", async () => {
    const h = withFakes({
      sourceScript: "gs.info('v1');",
      runnerScript: "gs.info('v1');",
    });
    try {
      process.env.SN_TABLES_DENY = RULE.table;

      const read = await createSnArtifactReader().readArtifact(
        "runner",
        RULE.table,
        RULE.sysId,
        ["script"],
      );
      // Nobody refused this: not the instance, and not in a way this adapter
      // could attribute if its own client had. The proof it was not local is
      // that it went to the wire at all.
      assert.equal(read.outcome, "found");
      assert.doesNotMatch(read.detail, /refused \(403\)/);
      assert.equal(h.runner.requests().length, 1);

      const report = await h.check.check({
        artifacts: [RULE],
        topology: LIVE_TOPOLOGY,
      });
      assert.equal(report.status, "match");
      assert.doesNotMatch(report.rows[0].evidence, /refused \(403\)/);
    } finally {
      h.restore();
    }
  });
});

// The reader's other way of being handed a `ServiceNowError` that does not
// mean "the instance answered", and it is the quieter one: no `status` at all.
// The transport raises that same type with `status` unset for a dropped
// connection, a timeout, and a request that never left this client
// (unconfigured instance, missing credentials, host policy). `ArtifactRead
// .status` means "what the instance answered with", so it may not be filled in
// from one — and the detail line may not quote it either, because on an
// undecidable row the evidence line IS the product of the row.
describe("a read that carries no status", () => {
  it("never attributes a status to a read the instance never answered", async () => {
    const h = withFakes({
      sourceScript: "gs.info('v1');",
      runnerScript: "gs.info('v1');",
    });
    try {
      h.runner.faults.add({
        match: { table: RULE.table },
        mode: { kind: "transport-error", message: "socket hang up" },
      });

      const read = await createSnArtifactReader().readArtifact(
        "runner",
        RULE.table,
        RULE.sysId,
        ["script"],
      );

      // Not rounded up to an answer, and not down to a refusal either.
      assert.equal(read.outcome, "undecidable");
      assert.equal(read.record, undefined);
      // The key's PRESENCE is itself the claim that a status was observed, so
      // `status: undefined` would not be good enough: a caller spreading this
      // object cannot tell that apart from one the instance answered.
      assert.ok(!("status" in read), "the read carries a status key");
      assert.doesNotMatch(read.detail, /undefined/);
      assert.doesNotMatch(read.detail, /refused \(/);
      // It states the one fact it has — nothing came back — and declines to
      // pick between the two readings it cannot separate, exactly as the 403
      // line above declines to pick between its two.
      assert.match(read.detail, /no answer was received/);
      assert.match(read.detail, /never left this client/);
      assert.match(read.detail, /never got a response/);
      // The transport's own message survives; it names the host and the cause.
      assert.match(read.detail, /socket hang up/);
      // It reached the wire, so this is a genuine transport failure and not a
      // 403 fabricated inside the client before anything was sent — the other
      // half of this boundary, with its own test above. Exactly one because
      // the harness stages SN_MAX_RETRIES=0.
      assert.equal(h.runner.requests().length, 1);

      // And the absent status stays absent all the way out to the report: the
      // row a human reads is where a quoted `undefined` would actually do its
      // damage.
      const report = await h.check.check({
        artifacts: [RULE],
        topology: LIVE_TOPOLOGY,
      });
      assert.equal(report.rows[0].outcome, "undecidable");
      assert.doesNotMatch(report.rows[0].evidence, /undefined/);
      assert.match(report.rows[0].evidence, /no answer was received/);
    } finally {
      h.restore();
    }
  });
});

// ── the claims a row is not allowed to make ─────────────────────────────────
//
// Every case below is one shape of a single defect: an operator-facing string,
// or a published field, that says more than the two reads observed. They are
// written as the PROPERTY the row may not violate rather than the sentence
// that currently carries it, so a rewording leaves them green while a
// re-collapse of the two readings does not.

/**
 * A reader whose sides answer `found` — one of them WITHOUT the record. The
 * port allows that shape (the API answered; the fields did not come back), and
 * the stub above cannot express it because it keys `found` off a record.
 */
function readerAnswering(sides) {
  return {
    instanceHost: hostStub(HOSTS),
    readArtifact(profile, table, sysId) {
      const mode = sides[profile];
      return Promise.resolve({
        outcome: mode === "undecidable-with-record" ? "undecidable" : "found",
        status: 200,
        ...(mode === "found-without-record"
          ? {}
          : {
              record: {
                sys_id: sysId,
                ...BASELINE[table],
                script: "gs.info('v1');",
              },
            }),
        detail: `${table}/${sysId} read on ${profile}`,
      });
    },
  };
}

describe("a row never claims more than its two reads observed", () => {
  it("does not manufacture a match out of two sides that returned no record", async () => {
    // Both digests are `undefined`, and `undefined === undefined` is true: the
    // comparison used to render as `match` over "(sha256 )" — a green with
    // nothing whatsoever behind it, and the one outcome that lets a pipeline
    // deploy.
    const report = await createParityCheck(
      readerAnswering({
        dev: "found-without-record",
        test: "found-without-record",
      }),
    ).check({ artifacts: [RULE], topology: TOPOLOGY });

    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "undecidable");
    assert.equal(report.status, "undecidable");
    // Nothing was digested, so no field and no line may speak in the grammar
    // of a digest that exists.
    assert.equal(row.sourceFingerprint, undefined);
    assert.equal(row.runnerFingerprint, undefined);
    assert.doesNotMatch(row.evidence, /identical/);
    assert.doesNotMatch(row.evidence, /sha256/);
    assert.equal(report.preflightFailure, undefined);
    assert.match(report.inconclusive, /could not be decided/);
  });

  it("publishes a fingerprint only for the side that answered with the row", async () => {
    // A digest on a row is itself a claim: "this side was read, and this is
    // what came back". The blind side must not carry one, and the row must not
    // be decided from the half that does.
    const report = await createParityCheck(
      readerAnswering({ dev: "found", test: "found-without-record" }),
    ).check({ artifacts: [RULE], topology: TOPOLOGY });

    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "undecidable");
    assert.equal(typeof row.sourceFingerprint, "string");
    assert.equal(row.runnerFingerprint, undefined);
    // And the evidence names WHICH side is blind, because that is the only
    // thing an operator can act on.
    assert.match(row.evidence, /runner \(test\)/);
    assert.doesNotMatch(row.evidence, /identical/);
  });

  it("never fingerprints a side whose read did not answer about the row", async () => {
    // The port lets an `undecidable` read carry a partial record — a body that
    // came back with the fault, say. Digesting it would publish a digest on a
    // row whose own outcome says nothing was read, and the two fields are the
    // machine-readable half of that row.
    const report = await createParityCheck(
      readerAnswering({ dev: "found", test: "undecidable-with-record" }),
    ).check({ artifacts: [RULE], topology: TOPOLOGY });

    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "undecidable");
    assert.equal(row.runnerFingerprint, undefined);
    assert.doesNotMatch(row.evidence, /identical/);
  });

  it("never blames the runner for a row the source itself could not show", async () => {
    const { report } = await checkOne(
      bothSides(RULE, undefined, { record: { script: "gs.info('v1');" } }),
    );

    assert.equal(rowFor(report, RULE).outcome, "missing-on-source");
    assert.equal(report.status, "mismatch");
    // The failure line is the instruction a human acts on. The runner was
    // never the subject of this row — the SOURCE did not show it — and
    // "the runner does not carry the tested version" sends someone to deploy
    // a version nobody has read.
    assert.notEqual(report.preflightFailure, "");
    assert.doesNotMatch(
      report.preflightFailure,
      /the runner \(test\) does not carry/,
    );
    assert.match(report.preflightFailure, /source \(dev\)/);
  });

  it("keeps the two failure kinds apart when one report carries both", async () => {
    // POLICY is on the source only (behind on the runner); RULE is on neither
    // (gone on the source). One `mismatch`, two different instructions.
    const report = await createParityCheck(
      readerFrom({
        dev: {
          [`${POLICY.table}/${POLICY.sysId}`]: {
            record: { script_true: "onTrue();", script_false: "onFalse();" },
          },
        },
        test: {},
      }),
    ).check({ artifacts: [RULE, POLICY], topology: TOPOLOGY });

    assert.equal(rowFor(report, RULE).outcome, "missing-on-source");
    assert.equal(rowFor(report, POLICY).outcome, "missing-on-runner");
    assert.equal(report.status, "mismatch");

    const clauses = report.preflightFailure.split("; ");
    const runnerClause = clauses.find((c) => c.includes("the runner"));
    const sourceClause = clauses.find((c) => c.startsWith("the source"));
    assert.ok(runnerClause, `no runner clause in: ${report.preflightFailure}`);
    assert.ok(sourceClause, `no source clause in: ${report.preflightFailure}`);
    // Each artifact appears in exactly the clause that is true of it.
    assert.match(runnerClause, /Tessera demo policy/);
    assert.doesNotMatch(runnerClause, /Tessera demo rule/);
    assert.match(sourceClause, /Tessera demo rule/);
    assert.doesNotMatch(sourceClause, /Tessera demo policy/);
  });

  it("offers both readings of an absence, on either side", async () => {
    // The Table API renders "no such row" and "ACL-trimmed" identically
    // (OPP-1b), so parity's own conclusion — the clause after the read's
    // detail — may not state only the first reading.
    const { report: runnerSide } = await checkOne(
      bothSides(RULE, { record: { script: "gs.info('v1');" } }, undefined),
    );
    const { report: sourceSide } = await checkOne(
      bothSides(RULE, undefined, { record: { script: "gs.info('v1');" } }),
    );

    for (const [side, report] of [
      ["runner", runnerSide],
      ["source", sourceSide],
    ]) {
      const evidence = rowFor(report, RULE).evidence;
      const conclusion = evidence.split(" — ")[1];
      assert.ok(conclusion, `${side}: no conclusion clause in "${evidence}"`);
      assert.match(
        conclusion,
        /cannot see|cannot separate|not shown|not visible/i,
        `${side}: the conclusion states one reading only`,
      );
    }
  });
});

// ── the namespace wording, wherever the body puts it ─────────────────────────
//
// The property: a namespace 404 is recognised as one no matter WHICH field of
// the error body carries the wording. The two placements must be
// indistinguishable to `classify`.
//
// Why it can be violated: `extractErrorDetail` (`@tessera/sn-client`'s
// `core/http.ts`) PREFERS `error.message` and only falls back to
// `error.detail`, so a body carrying the wording in `detail` alone arrives with
// a `ServiceNowError.message` that says nothing about a namespace — while
// `ServiceNowError.detail`, the whole parsed body, still holds it.
// `api/plugin.ts` composes message plus body and catches those; this reader
// tested the message alone and did not. Here the cost is a wrong verdict, not
// just a wrong line: the reader would answer `absent` — "the artifact is not on
// this instance" — on a 404 that never mentioned the row.
//
// The third body is the control. Without it the equality below would still hold
// for a reader that called every 404 a namespace 404, which loses the ONLY
// answer this stage can give about a missing artifact.
const NAMESPACE_PHRASE_404 =
  "The requested URI does not represent any resource on the server";
const RECORD_PHRASE_404 = "No Record found";
const RECORD_DETAIL_404 =
  "Record doesn't exist or ACL restricts the record retrieval";

// NAMESPACE_404 has two alternatives and a real instance uses both. The two
// placements below therefore carry a different half each: the message carries
// "does not represent any resource", the detail carries "Invalid URI". Give
// both placements the same phrasing and half the pattern goes untested.
const NAMESPACE_DETAIL_PHRASE = "Invalid URI: /api/now/table/sys_script";

/** The SN error body shape, with the namespace wording placed where asked. */
function bodyWithWordingIn(where) {
  return {
    error: {
      message: where === "message" ? NAMESPACE_PHRASE_404 : RECORD_PHRASE_404,
      detail: where === "detail" ? NAMESPACE_DETAIL_PHRASE : RECORD_DETAIL_404,
    },
    status: "failure",
  };
}

const WORDING_PLACEMENTS = ["message", "detail", "nowhere"];

describe("createSnArtifactReader — the namespace wording, in message or in detail", () => {
  it("reads a 404 the same whichever field of the body carries the wording", async () => {
    const h = withFakes({
      sourceScript: "gs.info('v1');",
      runnerScript: "gs.info('v1');",
    });
    try {
      for (const where of WORDING_PLACEMENTS) {
        h.runner.faults.add({
          match: { table: "sys_script", times: 1 },
          mode: {
            kind: "http-error",
            status: 404,
            body: bodyWithWordingIn(where),
          },
        });
      }

      const reader = createSnArtifactReader();
      const read = () =>
        reader.readArtifact("runner", RULE.table, RULE.sysId, ["script"]);

      const fromMessage = await read();
      const fromDetail = await read();
      const control = await read();

      // The property, as an equality: the placement is invisible to the
      // reader. This fails the moment the match narrows back to
      // `error.message` — `fromDetail` collapses into `absent`, which is the
      // reader claiming the row is gone on an answer about the namespace.
      assert.deepEqual(
        fromDetail,
        fromMessage,
        "a namespace 404 was read differently depending on which field of the body carried the wording",
      );
      assert.equal(fromMessage.outcome, "undecidable");
      assert.match(fromMessage.detail, /not a resource on this instance/);
      // Control: a 404 that says nothing about the namespace IS an answer
      // about the row, and must stay one.
      assert.equal(control.outcome, "absent");
      assert.match(control.detail, /no readable row/);
    } finally {
      h.restore();
    }
  });

  // The same body, judged by the canonical transport's own composition. If
  // this reader and `api/plugin.ts` ever answer differently about one body,
  // one of them is wrong and no equality above would say which.
  it("agrees with the vendored transport on the same body", async () => {
    const h = withFakes({
      sourceScript: "gs.info('v1');",
      runnerScript: "gs.info('v1');",
    });
    try {
      const reader = createSnArtifactReader();
      for (const where of WORDING_PLACEMENTS) {
        const body = bodyWithWordingIn(where);
        // What `core/http.ts` hands the reader: the message it derived
        // (message preferred, detail as fallback) and the whole parsed body.
        const derived = `ServiceNow API error (404): ${body.error.message}`;
        const transportSaysNamespace =
          /does not represent any resource|invalid uri/i.test(
            `${derived} ${JSON.stringify(body)}`,
          );

        h.runner.faults.add({
          match: { table: "sys_script", times: 1 },
          mode: { kind: "http-error", status: 404, body },
        });
        const got = await reader.readArtifact(
          "runner",
          RULE.table,
          RULE.sysId,
          ["script"],
        );
        assert.equal(
          got.outcome === "undecidable",
          transportSaysNamespace,
          `wording in ${where}: the reader and the vendored transport disagree about the same body`,
        );
      }
    } finally {
      h.restore();
    }
  });
});

// ── review 2026-09-25: rows that used to fingerprint as a false match ───────

describe("a sys_id that is not one is never read", () => {
  it("leaves `..` and `.` undecidable at the check, with no read sent", async () => {
    for (const sysId of ["..", ".", "AAAA0000000000000000000000000001", "x"]) {
      const artifact = { table: "sys_script", sysId, name: "odd" };
      const { report, reader } = await checkOne({}, [artifact]);
      assert.equal(report.rows[0].outcome, "undecidable", sysId);
      assert.match(report.rows[0].evidence, /not a sys_id/);
      assert.equal(reader.calls.length, 0, `a read was sent for ${sysId}`);
      assert.notEqual(report.status, "match");
    }
  });

  it("the live reader refuses `..` before any request reaches the instance", async () => {
    const h = withFakes({ sourceScript: "a", runnerScript: "a" });
    try {
      const reader = createSnArtifactReader();
      for (const sysId of ["..", "."]) {
        const read = await reader.readArtifact("runner", "sys_script", sysId, [
          "script",
        ]);
        assert.equal(read.outcome, "undecidable");
        assert.match(read.detail, /not a sys_id/);
      }
      assert.equal(h.runner.requests().length, 0);
    } finally {
      h.restore();
    }
  });
});

describe("the live reader calls a read found only when it names the row", () => {
  /** Replace the routed fetch with one answering 200 + `result` for every GET. */
  function answering(h, resultFor) {
    globalThis.fetch = (input) => {
      const href =
        typeof input === "string" ? input : (input.url ?? input.href);
      return Promise.resolve(
        new Response(JSON.stringify({ result: resultFor(href) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    return h;
  }

  const cases = {
    "an array (the list endpoint's shape)": () => [
      { sys_id: RULE.sysId, script: "x" },
    ],
    "a record carrying another sys_id": () => ({
      sys_id: "f".repeat(32),
      script: "x",
    }),
    "a record carrying no sys_id": () => ({ script: "x" }),
    "a scalar": () => "x",
  };

  for (const [name, resultFor] of Object.entries(cases)) {
    it(`is undecidable for ${name}`, async () => {
      const h = answering(withFakes(), resultFor);
      try {
        const read = await createSnArtifactReader().readArtifact(
          "runner",
          RULE.table,
          RULE.sysId,
          ["script"],
        );
        assert.equal(read.outcome, "undecidable");
        assert.equal(read.record, undefined);
        assert.match(read.detail, /instead of the requested row/);

        const report = await h.check.check({
          artifacts: [RULE],
          topology: LIVE_TOPOLOGY,
        });
        assert.equal(report.status, "undecidable");
      } finally {
        h.restore();
      }
    });
  }

  it("still reads the requested row as found", async () => {
    const h = answering(withFakes(), () => ({
      sys_id: RULE.sysId,
      script: "x",
    }));
    try {
      const read = await createSnArtifactReader().readArtifact(
        "runner",
        RULE.table,
        RULE.sysId,
        ["script"],
      );
      assert.equal(read.outcome, "found");
    } finally {
      h.restore();
    }
  });
});

describe("a record with nothing hashable is never a digest", () => {
  const unhashable = {
    "the field absent on both sides": {},
    "a display_value with no value": { script: { display_value: "x" } },
    "a null value": { script: null },
    "an array value": { script: ["x"] },
    "a value wrapper around an object": { script: { value: { a: 1 } } },
  };

  for (const [name, fields] of Object.entries(unhashable)) {
    it(`leaves the row undecidable for ${name}`, async () => {
      const { report } = await checkOne(
        bothSides(RULE, { record: fields }, { record: fields }),
      );
      const row = rowFor(report, RULE);
      assert.equal(row.outcome, "undecidable");
      assert.match(row.evidence, /no hashable value for script/);
      assert.equal(row.sourceFingerprint, undefined);
      assert.equal(row.runnerFingerprint, undefined);
      assert.equal(report.status, "undecidable");
    });
  }

  it("never matches a script body that is blank on both sides (M4)", async () => {
    const empty = await checkOne(
      bothSides(RULE, { record: { script: "" } }, { record: { script: "" } }),
    );
    const row = rowFor(empty.report, RULE);
    assert.equal(row.outcome, "undecidable");
    assert.match(row.evidence, /no hashable value for script \(blank/);
  });

  it("still compares a `{ value }` wrapper", async () => {
    const wrapped = await checkOne(
      bothSides(
        RULE,
        { record: { script: { value: "v1", display_value: "v1" } } },
        { record: { script: "v1" } },
      ),
    );
    assert.equal(rowFor(wrapped.report, RULE).outcome, "match");
  });

  it("does not digest a record that answered about another row", async () => {
    const other = { sys_id: "f".repeat(32), script: "" };
    const { report } = await checkOne(
      bothSides(RULE, { record: other }, { record: other }),
    );
    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "undecidable");
    assert.match(row.evidence, /not the requested/);
  });

  it("fingerprintRecord names the unhashable field instead of hashing it", () => {
    const result = fingerprintRecord({ script: "a" }, ["script", "condition"]);
    assert.equal(result.ok, false);
    assert.match(result.reason, /condition \(absent\)/);
  });
});

// ── review W6a 2026-09-26: H2 / M4 / M5 / L5 ────────────────────────────────

const ACL = {
  table: "sys_security_acl",
  sysId: "dddd0000000000000000000000000004",
  name: "incident.read",
};

const INCLUDE = {
  table: "sys_script_include",
  sysId: "eeee0000000000000000000000000005",
  name: "TesseraDemo",
};

describe("H2 — the version is every executable field, not the script body", () => {
  it("asks the reader for the full executable field set", async () => {
    const { reader } = await checkOne(
      bothSides(
        RULE,
        { record: { script: "gs.info('v1');" } },
        { record: { script: "gs.info('v1');" } },
      ),
    );
    for (const call of reader.calls) {
      for (const field of [
        "script",
        "when",
        "collection",
        "order",
        "active",
        "condition",
        "action_insert",
      ]) {
        assert.ok(call.fields.includes(field), `${field} was not requested`);
      }
    }
  });

  it("reports a business rule whose script is identical but whose timing differs", async () => {
    // Review repro P1: same body, before -> after. It used to read `match`.
    const { report } = await checkOne(
      bothSides(
        RULE,
        { record: { script: "gs.info('v1');", when: "before" } },
        { record: { script: "gs.info('v1');", when: "after" } },
      ),
    );
    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "differs");
    assert.match(row.evidence, /\bwhen\b/);
    assert.equal(report.status, "mismatch");
  });

  it("reports a business rule deactivated on the runner", async () => {
    const { report } = await checkOne(
      bothSides(
        RULE,
        { record: { script: "x", active: "true" } },
        { record: { script: "x", active: "false" } },
      ),
    );
    assert.equal(rowFor(report, RULE).outcome, "differs");
  });

  it("reports an ACL whose script is identical but whose operation differs", async () => {
    const { report } = await checkOne(
      bothSides(
        ACL,
        { record: { script: "answer = true;", operation: "read" } },
        { record: { script: "answer = true;", operation: "write" } },
      ),
      [ACL],
    );
    const row = rowFor(report, ACL);
    assert.equal(row.outcome, "differs");
    assert.match(row.evidence, /operation/);
  });

  it("never gives an ACL a clean match: its roles are not compared", async () => {
    const { report } = await checkOne(
      bothSides(
        ACL,
        { record: { script: "answer = true;" } },
        { record: { script: "answer = true;" } },
      ),
      [ACL],
    );
    const row = rowFor(report, ACL);
    assert.equal(row.outcome, "undecidable");
    assert.match(row.evidence, /identical on dev and test over/);
    assert.match(row.evidence, /sys_security_acl_role/);
    assert.notEqual(report.status, "match");
    assert.match(uncomparedFor("sys_security_acl"), /sys_security_acl_role/);
  });

  it("is undecidable when an executable field is missing from a side", async () => {
    const record = { ...BASELINE.sys_script, script: "x" };
    delete record.when;
    const { report } = await checkOne(
      bothSides(RULE, { record, bare: true }, { record: { script: "x" } }),
    );
    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "undecidable");
    assert.match(row.evidence, /when \(absent\)/);
    assert.equal(row.sourceFingerprint, undefined);
  });

  it("still reports a proven difference next to an unreadable field", async () => {
    // A field hashable on both sides and different is a fact on its own; a
    // blind neighbour does not cancel it.
    const { report } = await checkOne(
      bothSides(
        RULE,
        { record: { script: "x", when: "before", condition: null } },
        { record: { script: "x", when: "after" } },
      ),
    );
    assert.equal(rowFor(report, RULE).outcome, "differs");
  });

  it("covers every sn-client script table, and keeps the script fields in it", () => {
    assert.deepEqual(
      comparableTables(),
      [...SCRIPT_FIELDS_BY_TABLE.keys()].sort(),
    );
    for (const [table, scriptFields] of SCRIPT_FIELDS_BY_TABLE) {
      const executable = executableFieldsFor(table);
      assert.ok(executable, `${table} has no executable field set`);
      assert.deepEqual(EXECUTABLE_FIELDS_BY_TABLE.get(table), executable);
      for (const field of scriptFields) {
        assert.ok(executable.includes(field), `${table}.${field} missing`);
      }
      assert.ok(
        executable.length > scriptFields.length,
        `${table}: the executable set is only the script body`,
      );
      assert.ok(
        executable.includes("active") || table === "sys_transform_script",
      );
    }
    assert.equal(executableFieldsFor("incident"), undefined);
  });
});

describe("M4 — blank is not a version", () => {
  it("never matches a script include that is blank on both sides (repro P2)", async () => {
    const { report } = await checkOne(
      bothSides(
        INCLUDE,
        { record: { script: "" } },
        { record: { script: "" } },
      ),
      [INCLUDE],
    );
    const row = rowFor(report, INCLUDE);
    assert.equal(row.outcome, "undecidable");
    assert.match(row.evidence, /script \(blank/);
    assert.equal(row.sourceFingerprint, undefined);
    assert.equal(row.runnerFingerprint, undefined);
  });

  it("never matches a flag that is blank on both sides", async () => {
    const { report } = await checkOne(
      bothSides(
        RULE,
        { record: { script: "x", when: "" } },
        { record: { script: "x", when: "" } },
      ),
    );
    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "undecidable");
    assert.match(row.evidence, /when \(blank/);
  });

  it("never matches a blank `{ value }` wrapper either", async () => {
    const { report } = await checkOne(
      bothSides(
        INCLUDE,
        { record: { script: { value: "", display_value: "" } } },
        { record: { script: { value: "" } } },
      ),
      [INCLUDE],
    );
    assert.equal(rowFor(report, INCLUDE).outcome, "undecidable");
  });

  it("never matches an optional field blank on both sides, however readable its flags (wave 14)", async () => {
    // Every flag reads non-blank, so the ROW is readable — but a field-level
    // read ACL on exactly `condition` blanks that one value and nothing else.
    // Two such blind reads used to hash equal and report `match`.
    const blank = { script: "x", condition: "" };
    const { report } = await checkOne(
      bothSides(RULE, { record: blank }, { record: { ...blank } }),
    );
    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "undecidable");
    assert.match(row.evidence, /condition \(blank/);
    assert.equal(row.sourceFingerprint, undefined);
    assert.equal(row.runnerFingerprint, undefined);
    assert.equal(report.status, "undecidable");
  });

  it("does not call a one-sided blank a difference: it may hide an equal value (wave 14)", async () => {
    const { report } = await checkOne(
      bothSides(
        RULE,
        { record: { script: "x", condition: "current.priority == 1" } },
        { record: { script: "x", condition: "" } },
      ),
    );
    const row = rowFor(report, RULE);
    assert.equal(row.outcome, "undecidable");
    assert.match(
      row.evidence,
      /runner \(test\): no hashable value for condition \(blank/,
    );
    assert.ok(row.sourceFingerprint);
    assert.equal(row.runnerFingerprint, undefined);
  });

  it("still reports a real difference next to a blank optional field", async () => {
    const { report } = await checkOne(
      bothSides(
        RULE,
        { record: { script: "x", condition: "", when: "before" } },
        { record: { script: "x", condition: "", when: "after" } },
      ),
    );
    assert.equal(rowFor(report, RULE).outcome, "differs");
  });

  it("accepts a blank client-script `field` only where the script type never reads it", async () => {
    const CLIENT = {
      table: "sys_script_client",
      sysId: "cccc0000000000000000000000000003",
      name: "Tessera demo client script",
    };
    const base = {
      active: "true",
      table: "incident",
      ui_type: "0",
      field: "",
      script: "function onLoad() {}",
    };
    for (const type of ["onLoad", "onSubmit"]) {
      const { report } = await checkOne(
        bothSides(
          CLIENT,
          { record: { ...base, type }, bare: true },
          { record: { ...base, type }, bare: true },
        ),
        [CLIENT],
      );
      assert.equal(rowFor(report, CLIENT).outcome, "match", type);
    }
    for (const type of ["onChange", "onCellEdit", "onload"]) {
      const { report } = await checkOne(
        bothSides(
          CLIENT,
          { record: { ...base, type }, bare: true },
          { record: { ...base, type }, bare: true },
        ),
        [CLIENT],
      );
      const row = rowFor(report, CLIENT);
      assert.equal(row.outcome, "undecidable", type);
      assert.match(row.evidence, /field \(blank/);
    }
  });

  it("fingerprintRecord still refuses every blank, with no table to gate it", () => {
    const result = fingerprintRecord({ condition: "" }, ["condition"]);
    assert.equal(result.ok, false);
    assert.match(result.reason, /condition \(blank/);
  });

  it("accepts blank UI policy scripts only when run_scripts proves them inert", async () => {
    const inert = { run_scripts: "false", script_true: "", script_false: "" };
    const { report } = await checkOne(
      bothSides(POLICY, { record: inert }, { record: { ...inert } }),
      [POLICY],
    );
    const row = rowFor(report, POLICY);
    // Still undecidable (policy actions), but for that reason — not a blank.
    assert.equal(row.outcome, "undecidable");
    assert.match(row.evidence, /identical on dev and test over/);
    assert.doesNotMatch(row.evidence, /blank/);

    const live = { run_scripts: "true", script_true: "", script_false: "" };
    const { report: liveReport } = await checkOne(
      bothSides(POLICY, { record: live }, { record: { ...live } }),
      [POLICY],
    );
    assert.match(rowFor(liveReport, POLICY).evidence, /script_true \(blank/);
  });
});

describe("L5 — a string that is not well-formed is never hashed", () => {
  it("does not let a lone surrogate collide with U+FFFD (repro P3)", async () => {
    const { report } = await checkOne(
      bothSides(
        RULE,
        { record: { script: "x\uD800" } },
        { record: { script: "x�" } },
      ),
    );
    const row = rowFor(report, RULE);
    assert.notEqual(row.outcome, "match");
    assert.equal(row.outcome, "undecidable");
    assert.match(row.evidence, /well-formed/);
  });

  it("fingerprintRecord refuses a lone surrogate by name", () => {
    const result = fingerprintRecord({ script: "x\uD800" }, ["script"]);
    assert.equal(result.ok, false);
    assert.match(result.reason, /script \(not well-formed/);
  });

  it("prefixes each field with its UTF-8 byte length", () => {
    const expected = createHash("sha256")
      .update("script:2:", "utf8")
      .update("é", "utf8")
      .digest("hex");
    assert.equal(fingerprint({ script: "é" }, ["script"]), expected);
  });
});

describe("M5 — the two sides are instance hosts, not profile names", () => {
  const sides = bothSides(
    RULE,
    { record: { script: "x" } },
    { record: { script: "x" } },
  );

  it("is not-applicable when two names resolve to the same host", async () => {
    const reader = readerFrom(sides, {
      dev: "shared.service-now.com",
      test: "SHARED.service-now.com",
    });
    const report = await createParityCheck(reader).check({
      artifacts: [RULE],
      topology: TOPOLOGY,
    });
    assert.equal(report.status, "not-applicable");
    assert.match(report.summary, /same instance host/);
    assert.match(report.summary, /shared\.service-now\.com/);
    assert.equal(reader.calls.length, 0);
    assert.equal(report.inconclusive, undefined);
  });

  it("never treats one name resolving to two hosts as one side", async () => {
    const reader = readerFrom(sides);
    let n = 0;
    reader.instanceHost = () => ({
      ok: true,
      host: n++ === 0 ? "a.service-now.com" : "b.service-now.com",
    });
    const report = await createParityCheck(reader).check({
      artifacts: [RULE],
      topology: { source: "dev", runner: "dev" },
    });
    assert.notEqual(report.status, "not-applicable");
    assert.notEqual(report.status, "match");
    assert.equal(report.status, "undecidable");
    assert.match(report.rows[0].evidence, /a\.service-now\.com/);
    assert.match(report.rows[0].evidence, /b\.service-now\.com/);
    assert.equal(reader.calls.length, 0);
  });

  it("is undecidable when a side's host cannot be resolved", async () => {
    const reader = readerFrom(sides, { dev: "dev.service-now.com" });
    const report = await createParityCheck(reader).check({
      artifacts: [RULE],
      topology: TOPOLOGY,
    });
    assert.equal(report.status, "undecidable");
    assert.match(report.rows[0].evidence, /runner \(test\)/);
    assert.match(report.rows[0].evidence, /no instance configured/);
    assert.equal(reader.calls.length, 0);
  });

  it("fails closed for a reader that cannot name its hosts", async () => {
    const reader = readerFrom(sides);
    delete reader.instanceHost;
    const report = await createParityCheck(reader).check({
      artifacts: [RULE],
      topology: TOPOLOGY,
    });
    assert.equal(report.status, "undecidable");
    assert.equal(reader.calls.length, 0);
  });

  it("carries both hosts on the report and in the human rendering", async () => {
    const { report } = await checkOne(sides);
    assert.equal(report.sourceHost, "dev.service-now.com");
    assert.equal(report.runnerHost, "test.service-now.com");
    assert.match(
      formatParityReport(report),
      /source=dev \[dev\.service-now\.com\], runner=test \[test\.service-now\.com\]/,
    );
  });

  it("the live reader resolves a profile's host, and refuses one with none", () => {
    const h = withFakes();
    try {
      const reader = createSnArtifactReader();
      assert.deepEqual(reader.instanceHost("source"), {
        ok: true,
        host: SOURCE_HOST,
      });
      const none = reader.instanceHost("nobody");
      assert.equal(none.ok, false);
      assert.match(none.reason, /nobody/);
      // The port promises a NORMALIZED host: scheme, path and port gone, and
      // lowercase — a host name is case-insensitive (RFC 4343).
      process.env.SN_PROFILE_RUNNER_INSTANCE = `https://${SOURCE_HOST.toUpperCase()}/`;
      reloadCredentialsFromEnv();
      assert.deepEqual(reader.instanceHost("runner"), {
        ok: true,
        host: SOURCE_HOST,
      });
    } finally {
      h.restore();
    }
  });

  it("two live profiles pointing at one instance are not-applicable, with no read sent", async () => {
    const h = withFakes({ sourceScript: "x", runnerScript: "x" });
    try {
      process.env.SN_PROFILE_RUNNER_INSTANCE = `https://${SOURCE_HOST.toUpperCase()}/`;
      reloadCredentialsFromEnv();
      const report = await h.check.check({
        artifacts: [RULE],
        topology: LIVE_TOPOLOGY,
      });
      assert.equal(report.status, "not-applicable");
      assert.equal(h.source.requests().length, 0);
      assert.equal(h.runner.requests().length, 0);
    } finally {
      h.restore();
    }
  });
});

// ── wave 14: a blank read is not a value; ACL roles are compared ──────────

/** A sys_id-shaped id for the n-th role link. */
function linkId(n) {
  return `ffff${String(n).padStart(28, "0")}`;
}

function roleLink(n, role, parent = ACL.sysId) {
  return {
    sys_id: linkId(n),
    sys_security_acl: parent,
    "sys_user_role.name": role,
  };
}

/**
 * The stub reader plus `readRelated`: `related[profile]` is either a list of
 * rows (a complete read) or `{ undecidable }`, or a function that throws.
 */
function relatedReaderFrom(sides, related) {
  const reader = readerFrom(sides);
  reader.relatedCalls = [];
  reader.readRelated = (profile, request) => {
    reader.relatedCalls.push({ profile, ...request });
    const entry = related[profile];
    if (typeof entry === "function") return entry();
    if (entry === undefined || entry.undecidable !== undefined) {
      return Promise.resolve({
        outcome: "undecidable",
        detail: entry?.undecidable ?? `nothing configured for ${profile}`,
      });
    }
    return Promise.resolve({
      outcome: "complete",
      status: 200,
      rows: entry,
      detail: `${entry.length} row(s), complete`,
    });
  };
  return reader;
}

async function checkAcl(related, { source = {}, runner = {} } = {}) {
  const reader = relatedReaderFrom(
    bothSides(
      ACL,
      { record: { script: "answer = true;", ...source } },
      { record: { script: "answer = true;", ...runner } },
    ),
    related,
  );
  const report = await createParityCheck(reader).check({
    artifacts: [ACL],
    topology: TOPOLOGY,
  });
  return { report, reader, row: rowFor(report, ACL) };
}

describe("wave 14 — ACL required roles are compared, on complete reads only", () => {
  it("declares sys_security_acl_role as the ACL's related set", () => {
    assert.deepEqual(relatedFor("sys_security_acl"), {
      table: "sys_security_acl_role",
      parentField: "sys_security_acl",
      valueField: "sys_user_role.name",
      label: "required roles",
    });
    assert.equal(relatedFor("sys_script"), undefined);
    assert.equal(RELATED_ROW_LIMIT, 100);
  });

  it("matches an ACL whose fields and required roles are the same on both sides", async () => {
    const { row, report, reader } = await checkAcl({
      dev: [roleLink(1, "itil"), roleLink(2, "admin")],
      test: [roleLink(3, "admin"), roleLink(4, "itil")],
    });
    assert.equal(row.outcome, "match");
    assert.match(
      row.evidence,
      /required roles \(sys_security_acl_role\) identical: \[admin, itil\]/,
    );
    assert.equal(report.status, "match");
    assert.deepEqual(
      reader.relatedCalls.map((c) => [
        c.profile,
        c.table,
        c.parentField,
        c.parentSysId,
        c.fields,
      ]),
      [
        [
          "dev",
          "sys_security_acl_role",
          "sys_security_acl",
          ACL.sysId,
          ["sys_user_role.name"],
        ],
        [
          "test",
          "sys_security_acl_role",
          "sys_security_acl",
          ACL.sysId,
          ["sys_user_role.name"],
        ],
      ],
    );
  });

  it("matches two ACLs that both require no role", async () => {
    const { row } = await checkAcl({ dev: [], test: [] });
    assert.equal(row.outcome, "match");
    assert.match(row.evidence, /identical: \(none\)/);
  });

  it("reports a role granted on one side only as a difference", async () => {
    const { row, report } = await checkAcl({
      dev: [roleLink(1, "itil")],
      test: [roleLink(2, "itil"), roleLink(3, "snc_internal")],
    });
    assert.equal(row.outcome, "differs");
    assert.match(
      row.evidence,
      /required roles \(sys_security_acl_role\) differ — dev \[itil\] != test \[itil, snc_internal\]/,
    );
    assert.equal(report.status, "mismatch");
    assert.ok(report.preflightFailure);
  });

  it("reports a role dropped on the runner (none vs one) as a difference", async () => {
    const { row } = await checkAcl({ dev: [roleLink(1, "itil")], test: [] });
    assert.equal(row.outcome, "differs");
    assert.match(row.evidence, /dev \[itil\] != test \(none\)/);
  });

  it("treats a role bound twice as the same requirement", async () => {
    const { row } = await checkAcl({
      dev: [roleLink(1, "itil"), roleLink(2, "itil")],
      test: [roleLink(3, "itil")],
    });
    assert.equal(row.outcome, "match");
  });

  it("does not read the roles of an ACL whose fields already differ", async () => {
    const { row, reader } = await checkAcl(
      { dev: [roleLink(1, "itil")], test: [roleLink(2, "itil")] },
      { runner: { operation: "write" } },
    );
    assert.equal(row.outcome, "differs");
    assert.equal(reader.relatedCalls.length, 0);
  });

  for (const [name, related, pattern] of [
    [
      "a side whose read is not complete",
      {
        dev: [roleLink(1, "itil")],
        test: { undecidable: "3 row(s) returned of 4 matching" },
      },
      /runner \(test\): 3 row\(s\) returned of 4/,
    ],
    [
      "a role name this user cannot read (blank)",
      { dev: [roleLink(1, "itil")], test: [roleLink(2, "")] },
      /carries no readable sys_user_role\.name \(blank\)/,
    ],
    [
      "a role link with no name at all",
      {
        dev: [roleLink(1, "itil")],
        test: [{ sys_id: linkId(2), sys_security_acl: ACL.sysId }],
      },
      /sys_user_role\.name \(absent\)/,
    ],
    [
      "a row that names another ACL",
      {
        dev: [roleLink(1, "itil", "dddd0000000000000000000000000099")],
        test: [roleLink(2, "itil")],
      },
      /source \(dev\): a row returned does not carry a sys_id and the requested parent/,
    ],
    [
      "a row with no sys_id",
      {
        dev: [{ sys_security_acl: ACL.sysId, "sys_user_role.name": "itil" }],
        test: [roleLink(2, "itil")],
      },
      /does not carry a sys_id/,
    ],
    [
      "a row that is not a record",
      { dev: [roleLink(1, "itil"), null], test: [roleLink(2, "itil")] },
      /source \(dev\): a row returned is null, not a record/,
    ],
    [
      "the same row returned twice",
      {
        dev: [roleLink(1, "itil"), roleLink(1, "itil")],
        test: [roleLink(2, "itil")],
      },
      /returned twice/,
    ],
    [
      "a reader that throws",
      {
        dev: [roleLink(1, "itil")],
        test: () => {
          throw new Error("socket hang up");
        },
      },
      /runner \(test\): socket hang up/,
    ],
  ]) {
    it(`is undecidable, never a match or a difference, on ${name}`, async () => {
      const { row, report } = await checkAcl(related);
      assert.equal(row.outcome, "undecidable");
      assert.match(
        row.evidence,
        /required roles \(sys_security_acl_role\) could not be compared/,
      );
      assert.match(row.evidence, pattern);
      assert.match(row.evidence, /not a clean match/);
      assert.notEqual(report.status, "match");
      assert.notEqual(report.status, "mismatch");
    });
  }
});

/** A live ACL row plus its role links, for one fake. */
function aclState(links, condition = "active=true^EQ") {
  return {
    sys_security_acl: [
      {
        sys_id: ACL.sysId,
        ...BASELINE.sys_security_acl,
        condition,
        script: "answer = true;",
      },
    ],
    sys_security_acl_role: links,
  };
}

describe("wave 14 — against two live fake instances", () => {
  async function run(options) {
    const h = withFakes(options);
    try {
      const report = await h.check.check({
        artifacts: [ACL],
        topology: LIVE_TOPOLOGY,
      });
      return { h, report, row: rowFor(report, ACL) };
    } finally {
      h.restore();
    }
  }

  function roleReads(fake) {
    return fake
      .requests()
      .filter((r) => r.path.includes("sys_security_acl_role"));
  }

  it("matches an ACL whose roles are the same on two instances, and only GETs", async () => {
    const { h, row, report } = await run({
      sourceState: aclState([roleLink(1, "itil"), roleLink(2, "admin")]),
      runnerState: aclState([roleLink(3, "admin"), roleLink(4, "itil")]),
    });
    assert.equal(row.outcome, "match", row.evidence);
    assert.match(row.evidence, /identical: \[admin, itil\]/);
    assert.equal(report.status, "match");
    assert.deepEqual(methods(h.source, h.runner), ["GET"]);
    assert.equal(roleReads(h.source).length, 1);
    assert.equal(roleReads(h.runner).length, 1);
  });

  it("reports a role missing on the runner instance", async () => {
    const { row } = await run({
      sourceState: aclState([roleLink(1, "itil"), roleLink(2, "admin")]),
      runnerState: aclState([roleLink(3, "itil")]),
    });
    assert.equal(row.outcome, "differs", row.evidence);
    assert.match(row.evidence, /\[admin, itil\] != .* \[itil\]/);
  });

  it("ignores role links of other ACLs", async () => {
    const other = "dddd0000000000000000000000000099";
    const { row } = await run({
      sourceState: aclState([roleLink(1, "itil"), roleLink(2, "admin", other)]),
      runnerState: aclState([roleLink(3, "itil")]),
    });
    assert.equal(row.outcome, "match", row.evidence);
  });

  it("is undecidable when the instance sends no X-Total-Count", async () => {
    const { row } = await run({
      sourceState: aclState([roleLink(1, "itil")]),
      runnerState: aclState([roleLink(2, "itil")]),
      runnerOptions: { omitTotalCount: true },
    });
    assert.equal(row.outcome, "undecidable", row.evidence);
    assert.match(row.evidence, /no X-Total-Count/);
  });

  it("is undecidable when a row-level read ACL hides a role link", async () => {
    const { row } = await run({
      sourceState: aclState([roleLink(1, "itil"), roleLink(2, "admin")]),
      runnerState: aclState([roleLink(3, "itil"), roleLink(4, "admin")]),
      runnerOptions: {
        readAcl: {
          rules: [
            {
              table: "sys_security_acl_role",
              when: (r) => r["sys_user_role.name"] === "admin",
            },
          ],
        },
      },
    });
    // Without the count check this would read [itil] vs [admin, itil] — a
    // false `differs` — or, hidden on both sides, a false `match`.
    assert.equal(row.outcome, "undecidable", row.evidence);
    assert.match(row.evidence, /1 row\(s\) returned of 2 matching/);
  });

  it("is undecidable when a field-level read ACL blanks the role name", async () => {
    const { row } = await run({
      sourceState: aclState([roleLink(1, "itil")]),
      runnerState: aclState([roleLink(2, "itil")]),
      runnerOptions: {
        readAcl: {
          rules: [
            { table: "sys_security_acl_role", fields: ["sys_user_role.name"] },
          ],
        },
      },
    });
    assert.equal(row.outcome, "undecidable", row.evidence);
    assert.match(row.evidence, /\(blank\)/);
  });

  it("is undecidable, not truncated to a match, past the one-page limit", async () => {
    const many = (offset) =>
      Array.from({ length: RELATED_ROW_LIMIT + 1 }, (_, i) =>
        roleLink(offset + i, `role_${String(i).padStart(3, "0")}`),
      );
    const { row } = await run({
      sourceState: aclState(many(1)),
      runnerState: aclState(many(1000)),
    });
    assert.equal(row.outcome, "undecidable", row.evidence);
    assert.match(row.evidence, /100 row\(s\) returned of 101 matching/);
  });

  it("is undecidable when a field-level read ACL blanks the runner's ACL condition", async () => {
    // Both instances carry the same condition; the runner user may not read
    // it. It used to hash as blank on one side — and, blanked on both sides,
    // as a match.
    const blankCondition = {
      readAcl: {
        rules: [{ table: "sys_security_acl", fields: ["condition"] }],
      },
    };
    for (const sourceOptions of [{}, blankCondition]) {
      const { row, report } = await run({
        sourceState: aclState([roleLink(1, "itil")]),
        runnerState: aclState([roleLink(2, "itil")]),
        sourceOptions,
        runnerOptions: blankCondition,
      });
      assert.equal(row.outcome, "undecidable", row.evidence);
      assert.match(row.evidence, /condition \(blank/);
      assert.notEqual(report.status, "match");
    }
  });

  it("sends a bounded, parent-filtered, ordered role query", async () => {
    const { h } = await run({
      sourceState: aclState([roleLink(1, "itil")]),
      runnerState: aclState([roleLink(2, "itil")]),
    });
    const reads = roleReads(h.source);
    assert.equal(reads.length, 1);
    const { params, path: readPath, method } = reads[0];
    assert.equal(method, "GET");
    assert.equal(readPath, "/api/now/table/sys_security_acl_role");
    assert.equal(
      params.sysparm_query,
      `sys_security_acl=${ACL.sysId}^ORDERBYsys_id`,
    );
    assert.equal(params.sysparm_limit, String(RELATED_ROW_LIMIT));
    assert.equal(
      params.sysparm_fields,
      "sys_id,sys_security_acl,sys_user_role.name",
    );
  });
});

describe("wave 14 — createSnArtifactReader().readRelated proves completeness itself", () => {
  const REQUEST = {
    table: "sys_security_acl_role",
    parentField: "sys_security_acl",
    parentSysId: ACL.sysId,
    fields: ["sys_user_role.name"],
  };

  /** Route every GET to one canned list answer; `total: null` = no header. */
  async function readWith(rows, total = rows.length) {
    const h = withFakes();
    const sent = [];
    globalThis.fetch = (input) => {
      sent.push(typeof input === "string" ? input : (input.url ?? input.href));
      return Promise.resolve(
        new Response(JSON.stringify({ result: rows }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            ...(total === null ? {} : { "x-total-count": String(total) }),
          },
        }),
      );
    };
    try {
      const read = await createSnArtifactReader().readRelated(
        "source",
        REQUEST,
      );
      return { read, sent };
    } finally {
      h.restore();
    }
  }

  it("is complete when the total matches and every row names the parent", async () => {
    const { read, sent } = await readWith([roleLink(1, "itil")]);
    assert.equal(read.outcome, "complete", read.detail);
    assert.equal(read.rows.length, 1);
    assert.equal(sent.length, 1);
  });

  it("refuses rows of another parent: the query was not applied as sent", async () => {
    const { read } = await readWith([
      roleLink(1, "itil"),
      roleLink(2, "admin", "dddd0000000000000000000000000099"),
    ]);
    assert.equal(read.outcome, "undecidable");
    assert.match(
      read.detail,
      /1 of 2 row\(s\) do not reference the requested parent/,
    );
  });

  it("refuses a page shorter than its total, and a page with no total", async () => {
    assert.equal(
      (await readWith([roleLink(1, "itil")], 2)).read.outcome,
      "undecidable",
    );
    assert.equal(
      (await readWith([roleLink(1, "itil")], null)).read.outcome,
      "undecidable",
    );
  });

  it("refuses a non-list answer", async () => {
    const { read } = await readWith({ sys_id: ACL.sysId });
    assert.equal(read.outcome, "undecidable");
  });

  it("sends nothing for a parent that is not a sys_id or a name that is not one", async () => {
    for (const request of [
      { ...REQUEST, parentSysId: `${ACL.sysId}^ORactive=true` },
      { ...REQUEST, fields: ["name^ORactive=true"] },
      { ...REQUEST, table: "sys_security_acl_role/x" },
    ]) {
      const h = withFakes();
      try {
        const read = await createSnArtifactReader().readRelated(
          "source",
          request,
        );
        assert.equal(read.outcome, "undecidable");
        assert.match(read.detail, /no read was sent/);
        assert.equal(h.source.requests().length, 0);
      } finally {
        h.restore();
      }
    }
  });
});
