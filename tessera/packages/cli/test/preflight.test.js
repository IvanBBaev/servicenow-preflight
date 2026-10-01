// `tess preflight` and `tess doctor`, wired, against the QA-18 stateful fake.
//
// The companion of `cli.test.js`: that file asserts the composition root's pure
// decisions, this one asserts the wiring — real config resolution, real role
// binding through the credential store, the real doctor, the real ARCH-20
// parity check, the real provisioner and the real §11 guard. Only the instance
// is fake, and it is stateful, so "nothing was written" is a claim these tests
// can actually falsify: every non-GET request the fake served is recorded.
//
// Two properties are load-bearing in almost every case below:
//
//   * `env: {}` on the injected context, and a temp `cwd`. Otherwise an ambient
//     `TESSERA_*` or a `tessera.config.json` somewhere above the repo would
//     quietly become a config layer and the assertions would stop meaning what
//     they say.
//   * `writes(fake)` is asserted on every refusal path. A guard test that only
//     checks the exit code would still pass if the write had landed first.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";

import { createInfraLedger, createIntentLedger } from "@tessera/ledger";
import { getDocsDir, reloadCredentialsFromEnv } from "@tessera/sn-client";

import { EXIT_CODES, main } from "../build/index.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * Hosts whose first label carries a §11.2 non-prod marker AND which end in a
 * vendor domain, so the name heuristic reads them as sub-prod. The fake's own
 * default host ("fake-instance...") would not do: it carries no marker, and
 * every apply test would be refused for the wrong reason.
 */
const RUNNER_HOST = "dev-preflight.service-now.com";
const SOURCE_HOST = "dev-source.service-now.com";

const SCRIPT_INCLUDE_TABLE = "sys_script_include";
const ARTIFACT_ID = "1111111111111111111111111111aaaa";

const ATF_RUNNER_PROPERTY = "sn_atf.runner.enabled";
const PRODUCTION_PROPERTY = "glide.installation.production";

const CORRECT_SOURCE = "function total(rows) { return rows.length; }";
const MUTANT_SOURCE = "function total(rows) { return rows.length + 1; }";

/**
 * The starting state of an instance: one Script Include (the artifact parity
 * fingerprints) plus the two `sys_properties` rows the doctor and the §11.2
 * guard probe read. No ATF records — an unseeded table still answers 200 with
 * an empty result set, which is exactly the "readable" the doctor asks about.
 */
function seed({
  script = CORRECT_SOURCE,
  atfRunner = true,
  production = false,
}) {
  return {
    [SCRIPT_INCLUDE_TABLE]: [
      {
        sys_id: ARTIFACT_ID,
        name: "PreflightProbe",
        api_name: "global.PreflightProbe",
        // Parity (W6a H2) compares every executable field, not only the
        // script; an absent one makes the artifact undecidable.
        active: "true",
        access: "package_private",
        client_callable: "false",
        script,
      },
    ],
    // An array seeds one row per element, in order — a duplicated property.
    sys_properties: [
      ...[atfRunner].flat().map((value) => ({
        name: ATF_RUNNER_PROPERTY,
        value: String(value),
      })),
      ...[production].flat().map((value) => ({
        name: PRODUCTION_PROPERTY,
        value: String(value),
      })),
    ],
  };
}

/** Everything the vendored transport reads, staged and restored per test. */
const ENV_KEYS = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH",
  "SN_DOCS_DIR",
  "SN_MAX_RETRIES",
  "SN_READONLY",
  "SN_ACTIVE_PROFILE",
  "SN_ALLOWED_HOSTS",
  "SN_HOST_POLICY",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
  "SN_PROFILE_RUNNER_INSTANCE",
  "SN_PROFILE_RUNNER_USER",
  "SN_PROFILE_RUNNER_PASSWORD",
  "SN_PROFILE_SOURCE_INSTANCE",
  "SN_PROFILE_SOURCE_USER",
  "SN_PROFILE_SOURCE_PASSWORD",
];

// ── harness ─────────────────────────────────────────────────────────────────

const tempRoots = [];

async function tempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-preflight-"));
  tempRoots.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Stand up one or two fake instances behind a host-dispatching `fetch`, stage
 * the credential profiles they answer to, and hand back an injectable context.
 *
 * The dispatcher is hand-written rather than `fake.install()` because the fake
 * resolves relative URLs against its own host but otherwise ignores the
 * hostname — installed directly, both profiles in a split topology would reach
 * the same instance and parity would compare an instance against itself.
 */
async function harness(options = {}) {
  const runner = createFakeInstance({
    host: RUNNER_HOST,
    state: seed(options.runner ?? {}),
  });
  const source =
    options.source === undefined
      ? undefined
      : createFakeInstance({
          host: SOURCE_HOST,
          state: seed(options.source),
        });

  const routes = { [RUNNER_HOST]: runner };
  if (source !== undefined) routes[SOURCE_HOST] = source;

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

  const root = await tempRoot();
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(root, "sn-docs");
  // A retry would paper over a single-fire fault and turn a 500 into a hang.
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_PROFILE_RUNNER_INSTANCE = RUNNER_HOST;
  process.env.SN_PROFILE_RUNNER_USER = "tessera";
  process.env.SN_PROFILE_RUNNER_PASSWORD = "tessera";
  process.env.SN_PROFILE_SOURCE_INSTANCE = SOURCE_HOST;
  process.env.SN_PROFILE_SOURCE_USER = "tessera";
  process.env.SN_PROFILE_SOURCE_PASSWORD = "tessera";
  reloadCredentialsFromEnv();

  const out = [];
  const err = [];
  return {
    runner,
    source,
    out,
    err,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    /** The single JSON document a `--json` run prints. */
    json: () => JSON.parse(out.join("\n")),
    context: {
      now: () => new Date("2026-02-02T03:04:05.000Z"),
      actor: "test",
      // Temp cwd: `tessera.config.json` is discovered UPWARDS, and a file above
      // the repo would silently become a layer under the flags.
      cwd: root,
      env: {},
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
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

/** Run one command against a harness and always tear the harness down. */
async function run(argv, options = {}) {
  const h = await harness(options);
  try {
    const code = await main(argv, h.context);
    return { code, h };
  } finally {
    h.restore();
  }
}

/** Every non-GET the fake served — i.e. every mutation that was attempted. */
function writes(fake) {
  return fake.requests().filter((entry) => entry.method !== "GET");
}

// ── tess doctor ─────────────────────────────────────────────────────────────

describe("tess doctor (wired, against the fake instance)", () => {
  it("reports a seeded instance as ready and exits 0", async () => {
    const { code, h } = await run(["doctor", "--instance", "runner"]);

    assert.equal(code, EXIT_CODES.ok);
    assert.match(
      h.stdout(),
      /^runner: runner <dev-preflight\.service-now\.com>$/m,
    );
    assert.match(h.stdout(), /readiness: ready/);
    assert.equal(h.stderr(), "");
    assert.deepEqual(writes(h.runner), []);
  });

  it("emits one JSON document and no precedence log under --json", async () => {
    const { code, h } = await run(["doctor", "--instance", "runner", "--json"]);

    assert.equal(code, EXIT_CODES.ok);
    const report = h.json();
    assert.equal(report.status, "ready");
    assert.deepEqual(report.kinds, []);
    assert.equal(report.instances.length, 1);
    assert.equal(report.instances[0].role, "runner");
    assert.equal(report.instances[0].profile, "runner");
    assert.equal(report.instances[0].host, RUNNER_HOST);
    // Every precondition is reported, deferred ones included (rule 1).
    assert.ok(report.instances[0].findings.length >= 6);
  });

  it("diagnoses both ends of a topology when --target is given", async () => {
    const { code, h } = await run(
      ["doctor", "--instance", "runner", "--target", "source"],
      { source: {} },
    );

    assert.equal(code, EXIT_CODES.ok);
    assert.match(h.stdout(), /^runner: runner </m);
    assert.match(h.stdout(), /^target: source </m);
  });

  it("exits 1 when the DR-3 runner property reads false", async () => {
    const { code, h } = await run(
      ["doctor", "--instance", "runner", "--json"],
      {
        runner: { atfRunner: false },
      },
    );

    assert.equal(code, EXIT_CODES.noGo);
    const report = h.json();
    assert.equal(report.status, "not-ready");
    const finding = report.instances[0].findings.find(
      (entry) => entry.precondition === ATF_RUNNER_PROPERTY,
    );
    assert.equal(finding.status, "not-ready");
    assert.ok(finding.remedy, "a disabled runner must carry a remedy");
  });

  it("exits 1 with a DEV-2 hard failure when --kind ui is requested", async () => {
    const { code, h } = await run([
      "doctor",
      "--instance",
      "runner",
      "--kind",
      "ui",
      "--json",
    ]);

    // Hard failure, not inconclusive: a `ui` request against a Test Runner
    // nobody can confirm is a definite refusal (DEV-2), even though the
    // underlying finding is `unknown`.
    assert.equal(code, EXIT_CODES.noGo);
    const report = h.json();
    assert.match(report.instances[0].hardFailure, /requested kind\(s\) ui/);
    assert.match(
      report.instances[0].hardFailure,
      /sn_atf\.browser\.test-runner/,
    );
    // The property, not the shape: a machine reader must be able to learn that
    // a hard failure happened WITHOUT walking `instances[]`. The document's
    // root said `status: "not-ready"` and nothing else, while the tool contract
    // tells hosts to read `status` AND `hardFailure` there — so a host that
    // obeyed it read `undefined` and had no way to tell DEV-2 from a soft
    // not-ready. The root field is a roll-up of the same predicate the exit
    // code uses, and it names the instance so the reader knows which one.
    assert.notEqual(report.hardFailure, null);
    assert.match(report.hardFailure, /^runner: /);
    assert.match(report.hardFailure, /requested kind\(s\) ui/);
  });

  it("exits 5 when a precondition cannot be decided at all (QA-9)", async () => {
    const h = await harness({});
    try {
      h.runner.faults.add({
        match: { method: "GET", table: "sys_atf_test" },
        mode: {
          kind: "http-error",
          status: 500,
          message: "instance is unwell",
        },
      });
      const code = await main(
        ["doctor", "--instance", "runner", "--json"],
        h.context,
      );

      assert.equal(code, EXIT_CODES.inconclusive);
      const report = h.json();
      assert.equal(report.status, "unknown");
      assert.equal(report.instances[0].hardFailure, undefined);
      // The other half of the root roll-up, and the reason it is `null` rather
      // than omitted: QA-9 undecided is exactly the case a missing key would be
      // indistinguishable from, so the key is always there and the ABSENCE of a
      // hard failure is stated as a value.
      assert.equal(report.hardFailure, null);
      assert.equal("hardFailure" in report, true);
    } finally {
      h.restore();
    }
  });

  it("refuses with exit 2 when no instance was named", async () => {
    const { code, h } = await run(["doctor"]);

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /tess doctor: no instance/);
  });

  it("refuses a bare host with exit 2 and names the env keys", async () => {
    const { code, h } = await run([
      "doctor",
      "--instance",
      "https://dev-preflight.service-now.com",
    ]);

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /expects a credential-store PROFILE name/);
    assert.match(h.stderr(), /SN_PROFILE_<NAME>_INSTANCE/);
  });
});

// ── tess preflight: plan mode ───────────────────────────────────────────────

describe("tess preflight (plan mode)", () => {
  it("passes a ready instance and says parity was not applicable", async () => {
    const { code, h } = await run(["preflight", "--runner", "runner"]);

    assert.equal(code, EXIT_CODES.ok);
    assert.match(
      h.stdout(),
      /VERDICT: READY — the runner is ready; parity was not applicable/,
    );
    assert.match(
      h.stdout(),
      /provision plan \(mode plan — nothing was written\)/,
    );
    assert.match(
      h.stdout(),
      /nothing to do — every required precondition is ready/,
    );
    assert.deepEqual(writes(h.runner), []);
  });

  it("plans the DR-3 write without performing it and exits 1", async () => {
    const { code, h } = await run(["preflight", "--runner", "runner"], {
      runner: { atfRunner: false },
    });

    assert.equal(code, EXIT_CODES.noGo);
    assert.match(
      h.stdout(),
      /VERDICT: NOT READY — the runner is not ready — 1 step\(s\) planned; re-run with --mode apply to perform them/,
    );
    // The claim that matters: a plan is a plan. Nothing was written.
    assert.deepEqual(writes(h.runner), []);
  });

  it("publishes the plan's hash, and a different plan gets a different one", async () => {
    // DESIGN §6b: plan returns a plan AND its content hash. This is the whole
    // path — real config, real doctor, real probe, real recipe, real renderer —
    // so the digest asserted here is over a plan that was actually planned.
    const HASH_LINE = /^plan hash: ([0-9a-f]{64}) \(.+\)$/m;

    const pending = await run(["preflight", "--runner", "runner"], {
      runner: { atfRunner: false },
    });
    const ready = await run(["preflight", "--runner", "runner"]);

    assert.equal(pending.code, EXIT_CODES.noGo);
    assert.equal(ready.code, EXIT_CODES.ok);
    const planned = HASH_LINE.exec(pending.h.stdout());
    const nothingToDo = HASH_LINE.exec(ready.h.stdout());
    assert.ok(planned, "the run with a planned write printed no plan hash");
    assert.ok(nothingToDo, "the ready run printed no plan hash");
    // A step-less plan is hashed like any other — it is a legal plan — and it
    // is not the same plan as the one carrying the DR-3 write.
    assert.notEqual(planned[1], nothingToDo[1]);
    // Exposure only. Nothing reads a hash back in: `--mode apply` still applies
    // the plan object it was handed, so printing one changes no verdict and
    // still writes nothing here.
    assert.deepEqual(writes(pending.h.runner), []);
  });

  it("publishes that same hash in the machine document", async () => {
    // The property: the machine document carries the SAME plan identity the
    // human output does. It did not — `formatProvisionPlan` printed `plan
    // hash: <64 hex>` while `--json` published every other field of the plan
    // and omitted that one, which is backwards: the operator reading prose is
    // the one who cannot hand a digest back to anything, and the machine
    // consumer is the one that could.
    //
    // Both runs are the same seeded run, invoked twice, so the digests are
    // comparable only if the hash is a function of the plan and nothing else —
    // which is the §6b claim being asserted here as much as the exposure is.
    const human = await run(["preflight", "--runner", "runner"], {
      runner: { atfRunner: false },
    });
    const machine = await run(["preflight", "--runner", "runner", "--json"], {
      runner: { atfRunner: false },
    });

    const printed = /^plan hash: ([0-9a-f]{64}) \(.+\)$/m.exec(
      human.h.stdout(),
    );
    assert.ok(printed, "the human run printed no plan hash to compare against");
    const identity = machine.h.json().plan.planHash;
    assert.equal(identity.state, "computed");
    assert.equal(identity.value, printed[1]);
    assert.deepEqual(writes(machine.h.runner), []);
  });

  it("hashes a step-less plan too, and says so in the same shape", async () => {
    // A plan with nothing to do is a legal plan with an identity, not a plan
    // without one — so the ready run must NOT be the case that produces
    // `not-computed`. Asserted because the two are easy to conflate, and
    // conflating them would make the tagged state useless: a consumer would
    // learn "no digest" from a run that has one.
    const { code, h } = await run([
      "preflight",
      "--runner",
      "runner",
      "--json",
    ]);

    assert.equal(code, EXIT_CODES.ok);
    const report = h.json();
    assert.equal(report.plan.steps.length, 0);
    assert.equal(report.plan.planHash.state, "computed");
    assert.match(report.plan.planHash.value, /^[0-9a-f]{64}$/);
  });

  it("reports the same run as structured JSON", async () => {
    const { code, h } = await run(
      ["preflight", "--runner", "runner", "--json"],
      {
        runner: { atfRunner: false },
      },
    );

    assert.equal(code, EXIT_CODES.noGo);
    const report = h.json();
    assert.equal(report.mode, "plan");
    assert.equal(report.plan.applied, false);
    assert.equal(report.plan.steps.length, 1);
    assert.equal(report.plan.steps[0].write.table, "sys_properties");
    assert.equal(report.verdict.exitCode, EXIT_CODES.noGo);
    // The tri-state, by value. The human branch has printed READY /
    // INCONCLUSIVE / NOT READY since the first version of this command; the
    // JSON branch published only the exit code, so the one consumer that reads
    // `verdict.status` had a banner it could never reach.
    assert.equal(report.verdict.status, "NOT READY");
    // The run's own handle. It is stamped once, given to the §11.4 audit sink
    // and to the pipeline context, and was published nowhere — which left the
    // journal holding entries about a run no caller could name.
    assert.match(report.runId, /^preflight-\d{4}-\d\d-\d\dt[0-9.]+z$/);
    assert.equal(report.parity.status, "not-applicable");
    // No `--mode apply`, so no classification was performed at all.
    assert.equal(report.runnerClassification, undefined);
    assert.deepEqual(writes(h.runner), []);
  });

  it("fails the gate when the runner carries a different version (ARCH-20)", async () => {
    const { code, h } = await run(
      [
        "preflight",
        "--runner",
        "runner",
        "--source",
        "source",
        "--artifact",
        `${SCRIPT_INCLUDE_TABLE}/${ARTIFACT_ID}:PreflightProbe`,
        "--json",
      ],
      { runner: { script: MUTANT_SOURCE }, source: { script: CORRECT_SOURCE } },
    );

    assert.equal(code, EXIT_CODES.noGo);
    const report = h.json();
    assert.equal(report.parity.status, "mismatch");
    assert.equal(report.parity.rows[0].outcome, "differs");
    assert.match(report.verdict.reason, /does not carry the tested version/);
    // A parity mismatch outranks readiness in the reason, and the doctor still
    // said the instance itself was fine.
    assert.equal(report.doctor.status, "ready");
    assert.deepEqual(writes(h.runner), []);
    assert.deepEqual(writes(h.source), []);
  });

  it("passes when both ends carry identical bytes", async () => {
    const { code, h } = await run(
      [
        "preflight",
        "--runner",
        "runner",
        "--source",
        "source",
        "--artifact",
        `${SCRIPT_INCLUDE_TABLE}/${ARTIFACT_ID}`,
        "--json",
      ],
      {
        runner: { script: CORRECT_SOURCE },
        source: { script: CORRECT_SOURCE },
      },
    );

    assert.equal(code, EXIT_CODES.ok);
    const report = h.json();
    assert.equal(report.parity.status, "match");
    assert.equal(report.verdict.reason, "the runner is ready and in parity");
    assert.equal(report.verdict.status, "READY");
  });

  it("is inconclusive, never green, for a table parity cannot fingerprint", async () => {
    const { code, h } = await run(
      [
        "preflight",
        "--runner",
        "runner",
        "--source",
        "source",
        "--artifact",
        "sys_user/0000000000000000000000000000beef",
        "--json",
      ],
      { source: {} },
    );

    assert.equal(code, EXIT_CODES.inconclusive);
    const report = h.json();
    assert.equal(report.parity.status, "undecidable");
    assert.match(
      report.parity.rows[0].evidence,
      /not in the executable-field index/,
    );
    assert.equal(report.doctor.status, "ready");
    // The third value, and the one that carries the distinction: undecidable is
    // not a failure, and a consumer collapsing exit 5 into "not ready" would
    // report a verdict this run never reached (QA-9).
    assert.equal(report.verdict.status, "INCONCLUSIVE");
  });

  it("refuses with exit 2 when no runner was named", async () => {
    const { code, h } = await run(["preflight"]);

    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /tess preflight: no runner/);
  });

  for (const [raw, expected] of [
    ["sys_script_include", /expects <table>\/<sys_id>\[:<label>\]/],
    ["sys_script_include/", /expects a non-empty table and sys_id/],
  ]) {
    it(`refuses --artifact ${JSON.stringify(raw)} with exit 2`, async () => {
      const { code, h } = await run([
        "preflight",
        "--runner",
        "runner",
        "--artifact",
        raw,
      ]);

      assert.equal(code, EXIT_CODES.usage);
      assert.match(h.stderr(), expected);
    });
  }
});

// ── tess preflight: apply mode and the §11 guard ────────────────────────────

describe("tess preflight (apply mode)", () => {
  it("refuses to write to an unclassified runner (exit 4, nothing written)", async () => {
    const { code, h } = await run(
      ["preflight", "--runner", "runner", "--mode", "apply"],
      { runner: { atfRunner: false } },
    );

    assert.equal(code, EXIT_CODES.refused);
    assert.match(h.stderr(), /REFUSED \(§11\)/);
    assert.match(h.stderr(), /the runner classifies "unknown"/);
    assert.deepEqual(writes(h.runner), []);
  });

  it("refuses an allowlisted host the §11.2 probe disagrees about", async () => {
    // The §11.2 probe reads `sn_atf.runner.enabled` as a production signal, so
    // the ONE instance state that gives the provisioner a step to perform is
    // also the state that downgrades the host to `prod-suspect`. That identity
    // holds because both ends turn on the same question: the DR-3 recipe plans
    // a write only for a `found` row the doctor read as not-enabled, and the
    // probe now reads exactly those rows as `false`. It did NOT hold while the
    // probe read only the literal "false" that way — see the fail-closed test
    // below, whose input is a state that used to produce a step and no
    // downgrade. Without `--acknowledge-prod` apply mode therefore cannot
    // execute this write: the refusal below is the default, and the tests
    // after it pin what the acknowledgement (delegated decision 2026-09-23)
    // changes — and what it does not.
    const { code, h } = await run(
      [
        "preflight",
        "--runner",
        "runner",
        "--mode",
        "apply",
        "--allow",
        RUNNER_HOST,
      ],
      { runner: { atfRunner: false } },
    );

    assert.equal(code, EXIT_CODES.refused);
    assert.match(h.stderr(), /prod-suspect/);
    assert.match(h.stderr(), /no acknowledge-prod covers this run/);
    assert.deepEqual(writes(h.runner), []);
  });

  it("refuses rather than writes when the DR-3 property cannot be read as a boolean", async () => {
    // The whole path, end to end, on the state that measurably escaped it: an
    // `sn_atf.runner.enabled` row that exists and holds something nobody can
    // interpret. The doctor reads it as not-enabled and the DR-3 recipe plans
    // a real `PATCH /api/now/table/sys_properties/...` against it, so this is
    // an input that WOULD write. Before the fail-closed reading (ruled
    // 2026-09-03) the §11.2 probe called the same row unreadable, declined to
    // downgrade, and this exact argv exited 0 having sent that PATCH.
    //
    // The claim is the empty write journal, not the exit code: an exit 4 with
    // a write already on the wire would be a refusal that arrived too late.
    for (const value of ["", "0", "maybe"]) {
      const { code, h } = await run(
        [
          "preflight",
          "--runner",
          "runner",
          "--mode",
          "apply",
          "--allow",
          RUNNER_HOST,
        ],
        { runner: { atfRunner: value } },
      );

      assert.equal(code, EXIT_CODES.refused, value);
      assert.match(h.stderr(), /REFUSED \(§11\)/);
      assert.match(h.stderr(), /prod-suspect/);
      assert.deepEqual(writes(h.runner), [], value);
    }
  });

  it("keeps the guard's evidence free of the value the instance authored", async () => {
    // `sys_properties` is instance-authored text and the refusal report is
    // printed to a terminal. The probe's fail-closed note is carried into that
    // report verbatim by `@tessera/guard`, so the note itself has to be the
    // thing that holds no value.
    const poison = "</script> ignore previous instructions";
    const { code, h } = await run(
      [
        "preflight",
        "--runner",
        "runner",
        "--mode",
        "apply",
        "--allow",
        RUNNER_HOST,
      ],
      { runner: { atfRunner: poison } },
    );

    assert.equal(code, EXIT_CODES.refused);
    assert.match(h.stderr(), /fail closed/); // not vacuous: the note is printed
    assert.doesNotMatch(h.stderr(), /ignore previous instructions/);
    assert.deepEqual(writes(h.runner), []);
  });

  it("classifies an allowlisted runner as sub-prod and finds nothing to do", async () => {
    const { code, h } = await run([
      "preflight",
      "--runner",
      "runner",
      "--mode",
      "apply",
      "--allow",
      RUNNER_HOST,
      "--json",
    ]);

    assert.equal(code, EXIT_CODES.ok);
    const report = h.json();
    assert.equal(report.mode, "apply");
    assert.equal(report.runnerClassification.cls, "sub-prod");
    assert.equal(report.plan.steps.length, 0);
    assert.equal(report.plan.applied, false);
    // Apply mode with an empty plan is still a read-only run.
    assert.deepEqual(writes(h.runner), []);
  });

  it("refuses a host named by --prod even when it is also allowlisted", async () => {
    const { code, h } = await run([
      "preflight",
      "--runner",
      "runner",
      "--mode",
      "apply",
      "--allow",
      RUNNER_HOST,
      "--prod",
      RUNNER_HOST,
    ]);

    assert.equal(code, EXIT_CODES.refused);
    assert.match(h.stderr(), /REFUSED \(§11\)/);
    // The closed-union reason code, on the wire. `GUARD_VIOLATION_REASONS` is
    // the guard's own vocabulary for WHY it refused and it reached a caller
    // through no path at all: the CLI printed `error.message` and dropped
    // `detail`, so a consumer had to pattern-match English prose to tell one
    // refusal from another — and the prose for three of the eight reasons does
    // not even name the instance class. `formatGuardViolation` was written to
    // render this and its only call site was a test.
    assert.match(h.stderr(), /GuardViolation \[runner-not-writable\]/);
    assert.match(h.stderr(), /^ {2}class: +prod$/m);
    assert.match(h.stderr(), /^ {2}role: +runner$/m);
    assert.match(h.stderr(), /^ {2}remedy: /m);
    assert.deepEqual(writes(h.runner), []);
  });

  // ── the hardened apply surface (delegated decision 2026-09-23) ──────────
  //
  // `--acknowledge-prod`, `--ledger-root`, `--plan-hash`, `--idempotency-key`.
  // All four are argv-only and apply-only; each refusal below is asserted on
  // the write journal, not only on the exit code.

  /** The argv that plans the DR-3 write on an allowlisted, prod-suspect runner. */
  const APPLY = [
    "preflight",
    "--runner",
    "runner",
    "--mode",
    "apply",
    "--allow",
    RUNNER_HOST,
  ];

  /** Several commands against ONE harness (one fake, one temp cwd). */
  async function session(options, body) {
    const h = await harness(options);
    try {
      return await body(h, async (argv) => {
        h.out.length = 0;
        h.err.length = 0;
        return main(argv, h.context);
      });
    } finally {
      h.restore();
    }
  }

  it("--acknowledge-prod lifts the prod-suspect downgrade, journals the override, and writes", async () => {
    const { code, h } = await run(
      [
        ...APPLY,
        "--acknowledge-prod",
        "PDI reset; runner owned by QA",
        "--json",
      ],
      { runner: { atfRunner: false } },
    );

    assert.equal(code, EXIT_CODES.ok, h.stderr());
    const report = h.json();
    assert.equal(report.plan.applied, true);
    assert.equal(report.plan.steps.length, 1);
    // The write landed — exactly one, and it is the DR-3 PATCH.
    const landed = writes(h.runner);
    assert.equal(landed.length, 1);
    assert.equal(landed[0].method, "PATCH");
    assert.match(landed[0].url ?? landed[0].path ?? "", /sys_properties/);

    // §11.4: the override is on disk BEFORE the write, as one audit record.
    const ledgerRoot = path.join(h.context.cwd, ".tessera");
    assert.equal(report.ledger.root, ledgerRoot);
    assert.equal(report.ledger.acknowledgements.length, 1);
    assert.match(
      report.ledger.acknowledgements[0],
      /PDI reset; runner owned by QA/,
    );
    const audit = await createIntentLedger({ rootDir: ledgerRoot }).readAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].kind, "acknowledge-prod");
    assert.equal(audit[0].reason, "PDI reset; runner owned by QA");
    assert.equal(audit[0].actor, "test");
    assert.equal(audit[0].surface, "cli");
    assert.equal(audit[0].cls, "prod-suspect");

    // ARCH-33: the write is a confirmed standing-infra entry under this host.
    assert.equal(report.ledger.infra.length, 1);
    assert.equal(report.ledger.infra[0].state, "applied");
    assert.equal(report.ledger.infra[0].planHash, report.plan.planHash.value);
    const infra = createInfraLedger({ rootDir: ledgerRoot, host: RUNNER_HOST });
    const onDisk = await infra.entries();
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].state, "applied");
    assert.equal(onDisk[0].compensation.op, "none");
  });

  it("an acknowledgement does not lift a host named by --prod", async () => {
    const { code, h } = await run(
      [...APPLY, "--prod", RUNNER_HOST, "--acknowledge-prod", "anything"],
      { runner: { atfRunner: false } },
    );

    assert.equal(code, EXIT_CODES.refused);
    assert.match(h.stderr(), /REFUSED \(§11\)/);
    assert.deepEqual(writes(h.runner), []);
  });

  it("prints the acknowledgement and the ledger in the human report", async () => {
    const { code, h } = await run(
      [...APPLY, "--acknowledge-prod", "PDI", "--ledger-root", "journal"],
      { runner: { atfRunner: false } },
    );

    assert.equal(code, EXIT_CODES.ok, h.stderr());
    assert.match(
      h.stdout(),
      /acknowledged \(§11\.4\): runner prod-suspect: PDI \(test\)/,
    );
    assert.match(
      h.stdout(),
      new RegExp(
        `ledger \\(ARCH-33\\): 1 standing-infra entry under ${path
          .join(h.context.cwd, "journal")
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  });

  it("refuses a stale --plan-hash with nothing written, and applies a matching one", async () => {
    await session({ runner: { atfRunner: false } }, async (h, exec) => {
      const stale = "sha256:" + "0".repeat(64);
      assert.equal(
        await exec([
          ...APPLY,
          "--acknowledge-prod",
          "PDI",
          "--plan-hash",
          stale,
        ]),
        EXIT_CODES.refused,
      );
      assert.match(h.stderr(), /REFUSED \(§6b\): stale plan hash/);
      assert.match(h.stderr(), /nothing was written/);
      assert.deepEqual(writes(h.runner), []);

      // Review: a plan-mode run publishes the hash an apply hands back.
      assert.equal(
        await exec(["preflight", "--runner", "runner", "--json"]),
        EXIT_CODES.noGo,
      );
      const reviewed = h.json().plan.planHash;
      assert.equal(reviewed.state, "computed");

      assert.equal(
        await exec([
          ...APPLY,
          "--acknowledge-prod",
          "PDI",
          "--plan-hash",
          reviewed.value,
        ]),
        EXIT_CODES.ok,
        h.stderr(),
      );
      assert.equal(writes(h.runner).length, 1);
    });
  });

  it("refuses an --idempotency-key that already names another plan's writes", async () => {
    await session({ runner: { atfRunner: false } }, async (h, exec) => {
      const infra = createInfraLedger({
        rootDir: path.join(h.context.cwd, ".tessera"),
        host: RUNNER_HOST,
      });
      const other = await infra.intend({
        planHash: "sha256:" + "f".repeat(64),
        intent: "an earlier, different plan",
        target: { table: "sys_properties", sysId: "0".repeat(32) },
        compensation: { op: "none", reason: "test seed" },
        idempotencyKey: "change-42#0",
      });
      await infra.confirm(other.seq, { sysId: "0".repeat(32) });

      assert.equal(
        await exec([
          ...APPLY,
          "--acknowledge-prod",
          "PDI",
          "--idempotency-key",
          "change-42",
        ]),
        EXIT_CODES.refused,
      );
      assert.match(h.stderr(), /REFUSED \(ARCH-33\)/);
      assert.match(h.stderr(), /change-42#0/);
      assert.deepEqual(writes(h.runner), []);
    });
  });

  it("skips a step the ledger already confirmed under the same key and plan", async () => {
    await session({ runner: { atfRunner: false } }, async (h, exec) => {
      assert.equal(
        await exec(["preflight", "--runner", "runner", "--json"]),
        EXIT_CODES.noGo,
      );
      const plan = h.json().plan;
      const step = plan.steps[0];
      const infra = createInfraLedger({
        rootDir: path.join(h.context.cwd, ".tessera"),
        host: RUNNER_HOST,
      });
      // A previous process wrote and confirmed step 0 of THIS plan.
      const earlier = await infra.intend({
        planHash: plan.planHash.value,
        intent: step.action.description,
        target: { table: step.write.table, sysId: step.write.sysId },
        compensation: { op: "none", reason: "test seed" },
        idempotencyKey: "change-42#0",
      });
      await infra.confirm(earlier.seq, { sysId: step.write.sysId });

      const code = await exec([
        ...APPLY,
        "--acknowledge-prod",
        "PDI",
        "--idempotency-key",
        "change-42",
        "--json",
      ]);
      // The retry sent nothing: the ledger said the write already happened,
      // and no second entry was journalled for it.
      assert.deepEqual(writes(h.runner), []);
      assert.equal((await infra.entries()).length, 1);
      // ...and the provisioner's own verification still asked the instance.
      // Seeded un-enabled, the instance contradicts the ledger, so this is a
      // DEV-1 fault rather than a pass: a skipped step is verified exactly
      // like a written one, and a stale ledger cannot manufacture a READY.
      assert.equal(code, EXIT_CODES.fault);
      assert.match(h.stderr(), /APPLY UNVERIFIED/);
    });
  });

  it("refuses the apply-only flags outside --mode apply (exit 2, nothing read)", async () => {
    for (const flag of [
      ["--acknowledge-prod", "x"],
      ["--ledger-root", "x"],
      ["--plan-hash", "x"],
      ["--idempotency-key", "x"],
    ]) {
      const { code, h } = await run([
        "preflight",
        "--runner",
        "runner",
        ...flag,
      ]);
      assert.equal(code, EXIT_CODES.usage, flag[0]);
      assert.match(h.stderr(), new RegExp(flag[0]));
      assert.deepEqual(h.runner.requests(), [], flag[0]);
    }
  });

  it("refuses an empty --acknowledge-prod reason", async () => {
    const { code, h } = await run([...APPLY, "--acknowledge-prod", "  "], {
      runner: { atfRunner: false },
    });
    assert.equal(code, EXIT_CODES.usage);
    assert.match(h.stderr(), /--acknowledge-prod expects a non-empty value/);
    assert.deepEqual(writes(h.runner), []);
  });

  it("reads the hardened flags from argv only — config cannot acknowledge prod", async () => {
    const h = await harness({ runner: { atfRunner: false } });
    let code;
    try {
      await fs.writeFile(
        path.join(h.context.cwd, "tessera.config.json"),
        JSON.stringify({ acknowledgeProd: "from config" }),
      );
      h.context.env = { TESSERA_ACKNOWLEDGE_PROD: "from env" };
      code = await main(APPLY, h.context);
    } finally {
      h.restore();
    }
    // Either the layer is rejected outright or it is ignored; in both cases
    // the §11.4 refusal stands and nothing is written.
    assert.notEqual(code, EXIT_CODES.ok);
    assert.deepEqual(writes(h.runner), []);
  });

  // The DEV-15 journal root, end to end. Every other test in this file sets
  // `SN_DOCS_DIR` in the harness, which is precisely why the suite was blind
  // while `--docs-dir` was a flag `preflightCommand` parsed, validated, echoed
  // back with its provenance and never read: the harness supplied the fact the
  // code failed to supply. So this one takes it away first.
  //
  // It asserts the root the transport would journal against — `getDocsDir()`,
  // the very function `appendWriteJournal` calls — sampled while the command
  // is mid-flight, rather than a file on disk. A plan-mode run reaches the
  // instance on every path, so the sample needs no write; the only write
  // `tess preflight --mode apply` can land (DR-3) additionally needs
  // `--acknowledge-prod`, which the apply tests above cover on their own.
  it("stages --docs-dir as the journal root for the whole run", async () => {
    const h = await harness({});
    delete process.env.SN_DOCS_DIR;
    const chosen = path.join(h.context.cwd, "chosen-docs");

    const dispatch = globalThis.fetch;
    const roots = new Set();
    globalThis.fetch = (input, init) => {
      roots.add(getDocsDir());
      return dispatch(input, init);
    };

    let code;
    try {
      code = await main(
        ["preflight", "--runner", "runner", "--docs-dir", chosen],
        h.context,
      );
    } finally {
      h.restore();
    }

    assert.equal(code, EXIT_CODES.ok, h.stderr());
    // Not vacuous: an empty set would satisfy a subset assertion, and a run
    // that never reached the instance would produce one.
    assert.deepEqual([...roots], [chosen]);
    // And the environment is handed back as it was found. `""` would not be a
    // restoration — `getDocsDir()` reads a blank value as unset and falls to
    // its own cwd-relative default.
    assert.equal("SN_DOCS_DIR" in process.env, false);
  });
});

// ── duplicate §11.2 rows, end to end ────────────────────────────────────────
//
// Delegated decision 2026-09-26: the CLI reads the production property name
// from `@tessera/doctor` (no local copy), and a duplicated row must reach the
// guard through the real doctor probe and the topology's `readBoolean`. The
// production flag resolves toward "production" whatever the row order, so a
// clean allowlisted runner with rows [false, true] must NOT classify sub-prod.
describe("tess preflight: duplicated §11.2 rows reach the guard", () => {
  const APPLY_JSON = [
    "preflight",
    "--runner",
    "runner",
    "--mode",
    "apply",
    "--allow",
    RUNNER_HOST,
    "--json",
  ];

  for (const production of [
    [false, true],
    [true, false],
    ["false", "yes"],
  ]) {
    it(`reads production rows ${JSON.stringify(production)} as production and downgrades`, async () => {
      const { code, h } = await run(APPLY_JSON, { runner: { production } });

      // Refused at composition time, before any plan runs: the guard saw the
      // production property read TRUE, whichever row the instance listed first.
      assert.equal(code, EXIT_CODES.refused);
      assert.match(h.stderr(), /^ {2}class: +prod-suspect$/m);
      assert.match(
        h.stderr(),
        /\[downgrade\] production-property: glide\.installation\.production reads true/,
      );
      assert.deepEqual(writes(h.runner), []);
    });
  }

  it("keeps identical duplicate production rows [false, false] sub-prod", async () => {
    // The control: duplicates alone are not a downgrade — only a row that
    // reads production is.
    const { code, h } = await run(APPLY_JSON, {
      runner: { production: [false, false] },
    });

    assert.equal(code, EXIT_CODES.ok);
    assert.equal(h.json().runnerClassification.cls, "sub-prod");
    assert.deepEqual(writes(h.runner), []);
  });

  it("never clears a runner whose DR-3 rows differ", async () => {
    // Wave 16: the runner flag's safe direction is "not enabled"
    // (`ATF_RUNNER_SAFE_DIRECTION` in `@tessera/types`, the rule the doctor
    // and phase05 already apply), so differing rows are no longer a mere
    // warning to the guard: a row that is not `true` settles them as not
    // enabled, which downgrades the host and refuses apply before any plan.
    // No row wins by order, and nothing is written.
    for (const atfRunner of [
      [true, false],
      [false, true],
    ]) {
      const { code, h } = await run(APPLY_JSON, { runner: { atfRunner } });
      assert.equal(code, EXIT_CODES.refused, JSON.stringify(atfRunner));
      assert.match(h.stderr(), /^ {2}class: +prod-suspect$/m);
      assert.match(
        h.stderr(),
        /sn_atf\.runner\.enabled: 2 rows with differing values — read as false \(fail closed\)/,
      );
      assert.deepEqual(writes(h.runner), []);
    }
  });

  it("downgrades an uninterpretable §11.2 row under its own kind (wave 17)", async () => {
    // A single row the probe could not interpret reaches the guard as the
    // `*Uninterpretable` flag, which replaces the boolean's signal: the
    // refusal must not claim the row "reads false" / "reads true".
    for (const [runner, kind, replaced] of [
      [
        { atfRunner: "yes" },
        "atf-runner-uninterpretable",
        "atf-runner-disabled",
      ],
      [
        { production: "maybe" },
        "production-property-uninterpretable",
        "production-property",
      ],
    ]) {
      const { code, h } = await run(APPLY_JSON, { runner });
      assert.equal(code, EXIT_CODES.refused, kind);
      assert.match(h.stderr(), /^ {2}class: +prod-suspect$/m);
      assert.match(h.stderr(), new RegExp(`\\[downgrade\\] ${kind}: `));
      assert.doesNotMatch(
        h.stderr(),
        new RegExp(`\\[downgrade\\] ${replaced}: `),
      );
      assert.deepEqual(writes(h.runner), []);
    }
  });
});
