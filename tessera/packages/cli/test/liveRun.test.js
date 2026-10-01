// `tess run --live` and the §6b run-state trio (`status`, `confirm`,
// `cleanup`), end to end, against the QA-18 fake with the Tier-2 ATF execution
// engine installed.
//
// What this file can falsify that the unit suites of the parts cannot:
//
//   * **The whole real composition runs.** Resolver, impact, provisioner, the
//     ATF store, the CI/CD runner and the reporters — the eight ports
//     `composeRealPipeline` returns — reach a verdict against one instance,
//     and the verdict is DERIVED from the seeded Script Include: the same spec
//     goes red when the source under test is the mutant.
//   * **Nothing is left behind.** A finished run leaves no ATF definition on
//     the runner (DEV-13) and keeps its suite result (QA-17).
//   * **TM-3 in front of the first write** (red-team canary, TM-5 Tier 1 (c)).
//     A hostile repo spec refuses the whole run with exit 4, and the fake
//     served ZERO requests — not a refused write, no request at all.
//   * **status / confirm answer from disk.** They are run after the fake is
//     gone (`fetch` restored to a thrower), so a re-run would fault loudly.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createFakeInstance,
  W2_AUTHORING_CHANNEL_ACL_RULES,
  W2_AUTHORING_ROLE,
} from "@tessera/fake-instance";
import { createIntentLedger } from "@tessera/ledger";
import { createAtfExecutionEngine } from "@tessera/phase05";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";
import {
  AUTHORING_CHANNEL_VERSION,
  AUTHORING_CHANNEL_VERSION_PROPERTY,
  runOwnershipMarker,
} from "@tessera/teststore-atf";

import { EXIT_CODES, LIVE_RESULT_KIND, main } from "../build/index.js";

// ── fixtures: the instance ──────────────────────────────────────────────────

/** Non-prod marker + vendor domain: the §11.2 heuristic reads it as sub-prod. */
const RUNNER_HOST = "dev-live.service-now.com";

const hex = (prefix) => prefix.padEnd(32, "0");

const SCOPE_NAME = "x_tessera_live";
const SCOPE_ID = hex("5c0be");
const TARGET_ID = hex("a11ce");
const TARGET_NAME = "LiveDiscount";

const CORRECT_SOURCE = [
  "var LiveDiscount = Class.create();",
  "LiveDiscount.prototype = {",
  "  apply: function (units, price) {",
  "    var total = units * price;",
  "    if (units >= 100) total = total * 0.9;",
  "    return Math.round(total * 100) / 100;",
  "  },",
  "  type: 'LiveDiscount',",
  "};",
].join("\n");

/** The seeded-bug half: `>` for `>=`, so the threshold assertion goes red. */
const MUTANT_SOURCE = CORRECT_SOURCE.replace(">= 100", "> 100");

function seed({ mutant = false } = {}) {
  return {
    sys_scope: [{ sys_id: SCOPE_ID, scope: SCOPE_NAME, name: "Tessera Live" }],
    sys_script_include: [
      {
        sys_id: TARGET_ID,
        name: TARGET_NAME,
        sys_name: TARGET_NAME,
        api_name: `${SCOPE_NAME}.${TARGET_NAME}`,
        sys_scope: SCOPE_ID,
        active: "true",
        script: mutant ? MUTANT_SOURCE : CORRECT_SOURCE,
      },
    ],
    sys_properties: [
      { name: "sn_atf.runner.enabled", value: "true" },
      { name: "glide.installation.production", value: "false" },
      {
        sys_id: hex("c4a2"),
        name: AUTHORING_CHANNEL_VERSION_PROPERTY,
        value: AUTHORING_CHANNEL_VERSION,
      },
    ],
  };
}

// ── fixtures: the repo ──────────────────────────────────────────────────────

const SPEC_PATH = `${SCOPE_NAME}/sys_script_include/${TARGET_NAME}/${TARGET_NAME}.unit.ts`;

/** A step body the Tier-2 sandbox executes against the seeded source. */
const GOOD_BODY = `(function (outputs, steps, params, stepResult, assertEqual) {
  var d = new LiveDiscount();
  assertEqual({ name: "below threshold pays full price", shouldbe: 990, value: d.apply(99, 10) });
  assertEqual({ name: "the threshold itself discounts", shouldbe: 900, value: d.apply(100, 10) });
})(outputs, steps, params, stepResult, assertEqual);
`;

/**
 * A body the TM-3 gate must refuse. The marker string is what the assertions
 * look for on the wire: if projection ever happened, it would be in a request
 * body the fake recorded.
 */
const HOSTILE_MARKER = "tm5-canary-hostile-body";
const HOSTILE_BODY = `// ${HOSTILE_MARKER}
var gr = new GlideRecord("sys_user");
gr.query();
while (gr.next()) { gr.deleteRecord(); }
`;

async function writeTestsRoot(root, body) {
  const testsRoot = path.join(root, "tests");
  const file = path.join(testsRoot, SPEC_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  await fs.writeFile(
    path.join(testsRoot, ".manifest.json"),
    `${JSON.stringify(
      {
        version: 1,
        specs: [
          {
            id: `sys_script_include/${TARGET_ID}`,
            path: SPEC_PATH,
            kind: "unit",
            targets: [
              {
                table: "sys_script_include",
                sysId: TARGET_ID,
                name: TARGET_NAME,
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return testsRoot;
}

// ── harness ─────────────────────────────────────────────────────────────────

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
];

const tempRoots = [];

after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * One fake runner behind a host-dispatching `fetch` wrapped by the Tier-2
 * execution engine, the `runner` profile staged, a tests root on disk.
 */
async function harness({ mutant = false, body = GOOD_BODY } = {}) {
  const fake = createFakeInstance({
    host: RUNNER_HOST,
    state: seed({ mutant }),
    acl: {
      roles: [W2_AUTHORING_ROLE],
      rules: W2_AUTHORING_CHANNEL_ACL_RULES,
    },
    cicdSuiteParams: ["test_suite_sys_id", "sys_id"],
  });
  const engine = createAtfExecutionEngine(fake);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (new URL(href).host !== RUNNER_HOST) {
      return Promise.reject(new Error(`no fake instance for ${href}`));
    }
    return engine(input, init);
  };

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-live-"));
  tempRoots.push(root);
  const testsRoot = await writeTestsRoot(root, body);

  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(root, "sn-docs");
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_PROFILE_RUNNER_INSTANCE = RUNNER_HOST;
  process.env.SN_PROFILE_RUNNER_USER = "tessera";
  process.env.SN_PROFILE_RUNNER_PASSWORD = "tessera";
  reloadCredentialsFromEnv();

  let out = [];
  let err = [];
  let restored = false;
  return {
    fake,
    root,
    testsRoot,
    ledgerRoot: path.join(root, ".tessera"),
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    json: () => JSON.parse(out.join("\n")),
    clear() {
      out = [];
      err = [];
    },
    context: {
      now: () => new Date("2026-09-23T10:00:00.000Z"),
      actor: "test",
      cwd: root,
      env: {},
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
    /** Put the real process back (env, credentials, the real `fetch`). */
    restore() {
      if (restored) return;
      restored = true;
      globalThis.fetch = realFetch;
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    },
  };
}

const RUN_ID = "live-run-0001";

function liveArgv(h, extra = []) {
  return [
    "run",
    "--live",
    "--runner",
    "runner",
    "--scope",
    SCOPE_NAME,
    "--tests-root",
    h.testsRoot,
    "--allow",
    RUNNER_HOST,
    "--run-id",
    RUN_ID,
    "--run-timeout-ms",
    "30000",
    ...extra,
  ];
}

/** Rows of every ATF definition table — what a teardown must empty. */
function definitions(fake) {
  return [
    "sys_atf_test_suite",
    "sys_atf_test_suite_test",
    "sys_atf_test",
    "sys_atf_step",
    "sys_variable_value",
  ].flatMap((table) => fake.tables.all(table).map((row) => ({ table, row })));
}

// ── run --live ──────────────────────────────────────────────────────────────

describe("tess run --live (against the fake runner)", () => {
  it("reaches GO on the correct source, persists it, and leaves nothing behind", async () => {
    const h = await harness();
    let code;
    try {
      code = await main(liveArgv(h), h.context);
    } finally {
      h.restore();
    }
    assert.equal(code, EXIT_CODES.ok, `${h.stdout()}\n${h.stderr()}`);
    assert.match(h.stdout(), /GO/);
    assert.deepEqual(definitions(h.fake), []);
    assert.ok(h.fake.tables.all("sys_atf_test_result").length > 0);
  });

  it("goes NO_GO (exit 1) when the source under test is the mutant", async () => {
    const h = await harness({ mutant: true });
    let code;
    try {
      code = await main(liveArgv(h), h.context);
    } finally {
      h.restore();
    }
    assert.equal(code, EXIT_CODES.noGo, `${h.stdout()}\n${h.stderr()}`);
    assert.match(h.stdout(), /VERDICT: NO_GO/);
    assert.deepEqual(definitions(h.fake), []);
  });

  it("TM-5 canary (c): a hostile repo spec refuses the run with ZERO requests to the runner", async () => {
    const h = await harness({ body: HOSTILE_BODY });
    let code;
    try {
      code = await main(liveArgv(h), h.context);
    } finally {
      h.restore();
    }
    assert.equal(code, EXIT_CODES.refused, `${h.stdout()}\n${h.stderr()}`);
    assert.match(h.stderr(), /REFUSED \(TM-3\)/);
    // The operator sees rule names, never the body.
    assert.doesNotMatch(
      `${h.stdout()}\n${h.stderr()}`,
      new RegExp(HOSTILE_MARKER),
    );
    assert.deepEqual(h.fake.requests(), []);
    assert.equal(
      existsSync(h.ledgerRoot),
      false,
      "a refusal leaves no .tessera/",
    );
  });

  it("--json carries the persisted record; --allow-skipped is accepted", async () => {
    const h = await harness();
    let code;
    try {
      code = await main(liveArgv(h, ["--json", "--allow-skipped"]), h.context);
    } finally {
      h.restore();
    }
    assert.equal(code, EXIT_CODES.ok, h.stderr());
    const doc = h.json();
    assert.equal(doc.kind, LIVE_RESULT_KIND);
    assert.equal(doc.runId, RUN_ID);
    assert.equal(doc.exitCode, EXIT_CODES.ok);
    assert.equal(doc.verdict.status, "GO");
    assert.equal(doc.topology.runnerHost, RUNNER_HOST);
  });

  it("refuses usage errors before touching anything", async () => {
    const h = await harness();
    try {
      for (const argv of [
        ["run"],
        ["run", "--live", "--skeleton"],
        ["run", "--skeleton", "--runner", "runner"],
        ["run", "--live", "--runner", "runner", "--tests-root", h.testsRoot],
        ["run", "--live", "--runner", "runner", "--scope", SCOPE_NAME],
      ]) {
        h.clear();
        const code = await main(argv, h.context);
        assert.equal(
          code,
          EXIT_CODES.usage,
          `${argv.join(" ")}: ${h.stderr()}`,
        );
      }
    } finally {
      h.restore();
    }
    assert.deepEqual(h.fake.requests(), []);
    assert.equal(existsSync(h.ledgerRoot), false);
  });
});

// ── status / confirm / cleanup ──────────────────────────────────────────────

/** Any `fetch` from here on is a test failure: these answer from disk. */
function forbidFetch() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.reject(new Error("status/confirm must not touch the network"));
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe("tess status / confirm (read-only, from disk)", () => {
  it("answers a finished live run without re-running it", async () => {
    const h = await harness();
    try {
      assert.equal(await main(liveArgv(h), h.context), EXIT_CODES.ok);
    } finally {
      h.restore();
    }
    const requestsAfterRun = h.fake.requests().length;
    const allow = forbidFetch();
    try {
      h.clear();
      assert.equal(
        await main(["status", "--run-id", RUN_ID, "--json"], h.context),
        EXIT_CODES.ok,
        h.stderr(),
      );
      const status = h.json();
      assert.equal(status.run.state, "done");
      assert.equal(status.terminal, true);
      assert.equal(status.result.verdict, "GO");
      assert.ok(status.events.length > 0);

      h.clear();
      assert.equal(
        await main(
          ["status", "--run-id", RUN_ID, "--since", String(status.cursor)],
          h.context,
        ),
        EXIT_CODES.ok,
      );
      assert.match(h.stdout(), /done/);

      h.clear();
      assert.equal(
        await main(["confirm", "--run-id", RUN_ID], h.context),
        EXIT_CODES.ok,
        h.stderr(),
      );
      assert.match(h.stdout(), /VERDICT: GO/);

      h.clear();
      assert.equal(
        await main(["confirm", "--run-id", RUN_ID, "--json"], h.context),
        EXIT_CODES.ok,
      );
      assert.equal(h.json().verdict.status, "GO");
    } finally {
      allow();
    }
    assert.equal(h.fake.requests().length, requestsAfterRun);
  });

  it("confirm hands back a NO_GO run's exit code", async () => {
    const h = await harness({ mutant: true });
    try {
      assert.equal(await main(liveArgv(h), h.context), EXIT_CODES.noGo);
    } finally {
      h.restore();
    }
    const allow = forbidFetch();
    try {
      h.clear();
      assert.equal(
        await main(["confirm", "--run-id", RUN_ID], h.context),
        EXIT_CODES.noGo,
      );
      assert.match(h.stdout(), /VERDICT: NO_GO/);
    } finally {
      allow();
    }
  });

  it("an unknown run is a usage error and creates no ledger root", async () => {
    const h = await harness();
    h.restore();
    const allow = forbidFetch();
    try {
      for (const command of ["status", "confirm"]) {
        h.clear();
        assert.equal(
          await main([command, "--run-id", "nope"], h.context),
          EXIT_CODES.usage,
        );
      }
      h.clear();
      assert.equal(
        await main(["status", "--run-id", RUN_ID, "--since", "-1"], h.context),
        EXIT_CODES.usage,
      );
    } finally {
      allow();
    }
    assert.equal(existsSync(h.ledgerRoot), false);
  });

  it("a malformed run id is a usage error before anything is read", async () => {
    // Delegated decision 2026-09-25: `validateRunId` runs immediately after
    // parsing. With a ledger root on disk the ledger's own throw used to
    // surface as exit 3 (INFRASTRUCTURE FAULT) instead.
    const h = await harness();
    h.restore();
    await createIntentLedger({
      rootDir: h.ledgerRoot,
      now: h.context.now,
    }).openRun({
      runId: RUN_ID,
      scope: SCOPE_NAME,
      runner: "runner",
      lifecycle: "ephemeral",
    });
    const allow = forbidFetch();
    try {
      for (const command of ["status", "confirm"]) {
        for (const bad of ["../x", "a/b", "x^ORsys_idISNOTEMPTY^name!="]) {
          h.clear();
          assert.equal(
            await main([command, "--run-id", bad, "--json"], h.context),
            EXIT_CODES.usage,
            `${command} ${bad}: ${h.stderr()}`,
          );
          assert.match(h.stderr(), /invalid run id/);
          assert.equal(h.stdout(), "");
        }
      }
    } finally {
      allow();
    }
  });

  it("confirm is INCONCLUSIVE (5) for a run with no persisted result", async () => {
    const h = await harness();
    h.restore();
    const ledger = createIntentLedger({
      rootDir: h.ledgerRoot,
      now: h.context.now,
    });
    await ledger.openRun({
      runId: RUN_ID,
      scope: SCOPE_NAME,
      runner: "runner",
      lifecycle: "ephemeral",
    });
    h.clear();
    assert.equal(
      await main(["confirm", "--run-id", RUN_ID], h.context),
      EXIT_CODES.inconclusive,
    );
    assert.match(h.stderr(), /INCONCLUSIVE/);
  });
});

describe("tess cleanup", () => {
  async function seededRun(h, states) {
    const ledger = createIntentLedger({
      rootDir: h.ledgerRoot,
      now: h.context.now,
    });
    await ledger.openRun({
      runId: RUN_ID,
      scope: SCOPE_NAME,
      runner: "runner",
      lifecycle: "ephemeral",
    });
    for (const state of states) await ledger.transition(RUN_ID, state);
    return ledger;
  }

  const cleanupArgv = (extra = []) => [
    "cleanup",
    "--run-id",
    RUN_ID,
    "--runner",
    "runner",
    "--allow",
    RUNNER_HOST,
    ...extra,
  ];

  it("refuses a non-terminal run (DEV-17) without contacting the runner", async () => {
    const h = await harness();
    try {
      await seededRun(h, []);
      for (const mode of ["plan", "apply"]) {
        h.clear();
        assert.equal(
          await main(cleanupArgv(["--mode", mode]), h.context),
          EXIT_CODES.refused,
        );
        assert.match(h.stderr(), /REFUSED \(DEV-17\)/);
      }
    } finally {
      h.restore();
    }
    assert.deepEqual(h.fake.requests(), []);
  });

  it("plans from the local ledger only (default mode)", async () => {
    const h = await harness();
    try {
      await seededRun(h, ["tearing-down", "failed"]);
      h.clear();
      assert.equal(
        await main(cleanupArgv(["--json"]), h.context),
        EXIT_CODES.ok,
        h.stderr(),
      );
      const plan = h.json();
      assert.equal(plan.mode, "plan");
      assert.equal(plan.localState, "failed");
      assert.deepEqual(plan.transitions, ["tearing-down", "done"]);
      assert.equal(plan.namespace, `${RUN_ID}:`);
    } finally {
      h.restore();
    }
    assert.deepEqual(h.fake.requests(), []);
  });

  it("apply re-enters tearing-down from failed and settles the run as done", async () => {
    const h = await harness();
    try {
      const ledger = await seededRun(h, ["tearing-down", "failed"]);
      h.clear();
      assert.equal(
        await main(cleanupArgv(["--mode", "apply", "--json"]), h.context),
        EXIT_CODES.ok,
        h.stderr(),
      );
      const outcome = h.json();
      assert.equal(outcome.from, "failed");
      assert.equal(outcome.state, "done");
      assert.equal((await ledger.readRun(RUN_ID)).state, "done");
      assert.ok(h.fake.requests().length > 0, "apply contacts the runner");
    } finally {
      h.restore();
    }
    h.clear();
    assert.equal(
      await main(["status", "--run-id", RUN_ID, "--json"], h.context),
      EXIT_CODES.ok,
    );
    assert.ok(h.json().events.some((event) => event.type === "cleanup"));
  });

  // Delegated decision 2026-09-25: the ATF store refuses a suite with no
  // result row unless the caller asserts it was never triggered. Cleanup
  // asserts that only when the local run.json proves the run never reached
  // `running` — a tracking record (`tracksRunning`) with no `runningAt`.
  describe("a leftover suite with zero results (DEV-17 zero-result gate)", () => {
    const SUITE_NAME = `${RUN_ID}:suite`;

    /** A projected-but-never-run suite: the definition, no result row. */
    function leaveSuite(h) {
      // Carries the run's ownership marker, as `project()` writes it (F2).
      h.fake.tables.insert("sys_atf_test_suite", {
        name: SUITE_NAME,
        description: `${runOwnershipMarker(RUN_ID)}suite`,
      });
    }

    const suites = (h) =>
      h.fake.tables
        .all("sys_atf_test_suite")
        .filter((row) => String(row.name).startsWith(`${RUN_ID}:`));

    /** A run.json written before `runningAt`/`tracksRunning` existed. */
    async function legacyRun(h, state) {
      const dir = path.join(h.ledgerRoot, "runs", RUN_ID);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "run.json"),
        JSON.stringify({
          runId: RUN_ID,
          state,
          scope: SCOPE_NAME,
          runner: "runner",
          lifecycle: "ephemeral",
          startedAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        }),
      );
    }

    it("tears it down (exit 0) when the run failed before ever reaching running", async () => {
      const h = await harness();
      try {
        const ledger = await seededRun(h, [
          "provisioning",
          "tearing-down",
          "failed",
        ]);
        leaveSuite(h);
        h.clear();
        assert.equal(
          await main(cleanupArgv(["--json"]), h.context),
          EXIT_CODES.ok,
        );
        assert.equal(h.json().neverTriggered, true);
        h.clear();
        assert.equal(
          await main(cleanupArgv(["--mode", "apply", "--json"]), h.context),
          EXIT_CODES.ok,
          h.stderr(),
        );
        assert.equal(h.json().state, "done");
        assert.deepEqual(suites(h), [], "the leftover suite is deleted");
        const after = await ledger.readRun(RUN_ID);
        assert.equal(after.state, "done");
        assert.equal(after.runningAt, undefined);
      } finally {
        h.restore();
      }
    });

    it("refuses (exit 4) when the run reached running, deleting nothing", async () => {
      const h = await harness();
      try {
        const ledger = await seededRun(h, [
          "provisioning",
          "projecting",
          "running",
          "collecting",
          "tearing-down",
          "failed",
        ]);
        assert.ok((await ledger.readRun(RUN_ID)).runningAt);
        leaveSuite(h);
        h.clear();
        assert.equal(
          await main(cleanupArgv(["--json"]), h.context),
          EXIT_CODES.ok,
        );
        assert.equal(h.json().neverTriggered, false);
        h.clear();
        assert.equal(
          await main(cleanupArgv(["--mode", "apply"]), h.context),
          EXIT_CODES.refused,
          h.stdout(),
        );
        assert.match(h.stderr(), /REFUSED \(DEV-17\)/);
        assert.equal(suites(h).length, 1, "nothing was deleted");
        assert.equal((await ledger.readRun(RUN_ID)).state, "failed");
      } finally {
        h.restore();
      }
    });

    it("refuses (exit 4) a legacy record that cannot prove it never ran", async () => {
      const h = await harness();
      try {
        await legacyRun(h, "failed");
        leaveSuite(h);
        h.clear();
        assert.equal(
          await main(cleanupArgv(["--json"]), h.context),
          EXIT_CODES.ok,
        );
        assert.equal(h.json().neverTriggered, false);
        h.clear();
        assert.equal(
          await main(cleanupArgv(["--mode", "apply"]), h.context),
          EXIT_CODES.refused,
          h.stdout(),
        );
        assert.match(h.stderr(), /REFUSED \(DEV-17\)/);
        assert.equal(suites(h).length, 1, "nothing was deleted");
      } finally {
        h.restore();
      }
    });

    it("refuses (exit 4) with no local record at all", async () => {
      const h = await harness();
      try {
        leaveSuite(h);
        h.clear();
        // RUN_ID is not a minted id: an unrecorded sweep must confirm it (F2d)
        // to reach the store's DEV-17 gate at all.
        assert.equal(
          await main(
            cleanupArgv(["--mode", "apply", "--confirm-unrecorded", RUN_ID]),
            h.context,
          ),
          EXIT_CODES.refused,
          h.stdout(),
        );
        assert.match(h.stderr(), /REFUSED \(DEV-17\)/);
        assert.equal(suites(h).length, 1, "nothing was deleted");
      } finally {
        h.restore();
      }
    });
  });

  // DEV-17 (wave 13): each suite trigger the ledger records owes one
  // `sys_atf_test_suite_result` row. One terminal row used to pass the gate
  // while a second execution of the same suite could still be queued.
  describe("recorded suite triggers vs result rows (DEV-17 wave 13)", () => {
    const SUITE_NAME = `${RUN_ID}:suite`;

    /** A run that reached `running` and recorded `triggers` trigger intents. */
    async function triggeredRun(h, triggers) {
      const ledger = await seededRun(h, [
        "provisioning",
        "projecting",
        "running",
      ]);
      for (let index = 0; index < triggers; index += 1) {
        await ledger.intend({
          runId: RUN_ID,
          instance: RUNNER_HOST,
          intent: `run 1 spec(s) via runner adapter #${index}`,
          target: { table: "sys_atf_test_suite_run" },
          compensation: { op: "none", reason: "test seed" },
          idempotencyKey: `${RUN_ID}:run:${index}`,
        });
      }
      for (const state of ["collecting", "tearing-down", "failed"]) {
        await ledger.transition(RUN_ID, state);
      }
      return ledger;
    }

    /** The run's leftover suite + test, with `results` terminal result rows. */
    function leaveTriggeredSuite(h, results) {
      const marker = runOwnershipMarker(RUN_ID);
      const suite = h.fake.tables.insert("sys_atf_test_suite", {
        name: SUITE_NAME,
        description: `${marker}suite`,
      });
      const test = h.fake.tables.insert("sys_atf_test", {
        name: `${RUN_ID}:test`,
        description: `${marker}test`,
      });
      h.fake.tables.insert("sys_atf_test_suite_test", {
        test_suite: suite.sys_id,
        test: test.sys_id,
        order: "100",
      });
      for (let index = 0; index < results; index += 1) {
        h.fake.tables.insert("sys_atf_test_suite_result", {
          test_suite: suite.sys_id,
          status: "success",
        });
      }
    }

    const leftovers = (h) =>
      ["sys_atf_test_suite", "sys_atf_test", "sys_atf_test_suite_test"]
        .flatMap((table) => h.fake.tables.all(table))
        .filter(
          (row) =>
            String(row.name ?? "").startsWith(`${RUN_ID}:`) ||
            row.test_suite !== undefined,
        );

    const deletes = (h) =>
      h.fake.requests().filter((request) => request.method === "DELETE");

    it("refuses (exit 4) two recorded triggers with one result row, deleting nothing", async () => {
      const h = await harness();
      try {
        const ledger = await triggeredRun(h, 2);
        leaveTriggeredSuite(h, 1);
        h.clear();
        assert.equal(
          await main(cleanupArgv(["--json"]), h.context),
          EXIT_CODES.ok,
        );
        assert.equal(h.json().recordedTriggers, 2);
        assert.equal(h.json().recordedTriggersFrom, "ledger");
        h.clear();
        assert.equal(
          await main(cleanupArgv(["--mode", "apply"]), h.context),
          EXIT_CODES.refused,
          h.stdout(),
        );
        assert.match(h.stderr(), /REFUSED \(DEV-17\)/);
        assert.match(h.stderr(), /records 2 suite trigger\(s\)/);
        assert.deepEqual(deletes(h), [], "no DELETE reached the runner");
        assert.equal(leftovers(h).length, 3, "suite, test and link survive");
        assert.equal((await ledger.readRun(RUN_ID)).state, "failed");
      } finally {
        h.restore();
      }
    });

    it("tears down (exit 0) when both recorded triggers have a terminal row", async () => {
      const h = await harness();
      try {
        const ledger = await triggeredRun(h, 2);
        leaveTriggeredSuite(h, 2);
        h.clear();
        assert.equal(
          await main(cleanupArgv(["--mode", "apply", "--json"]), h.context),
          EXIT_CODES.ok,
          h.stderr(),
        );
        assert.equal(h.json().state, "done");
        assert.equal(h.json().ledgerEntriesSettled, 2);
        assert.deepEqual(leftovers(h), [], "the projection is gone");
        assert.equal((await ledger.readRun(RUN_ID)).state, "done");
      } finally {
        h.restore();
      }
    });

    it("keeps the single-trigger behaviour: one trigger, one terminal row → exit 0", async () => {
      const h = await harness();
      try {
        await triggeredRun(h, 1);
        leaveTriggeredSuite(h, 1);
        h.clear();
        assert.equal(
          await main(cleanupArgv(["--mode", "apply", "--json"]), h.context),
          EXIT_CODES.ok,
          h.stderr(),
        );
        assert.equal(h.json().state, "done");
        assert.deepEqual(leftovers(h), []);
      } finally {
        h.restore();
      }
    });

    it("an unrecorded sweep is bounded by one trigger per runner group", async () => {
      const h = await harness();
      try {
        leaveTriggeredSuite(h, 1);
        h.clear();
        assert.equal(
          await main(
            cleanupArgv(["--json", "--confirm-unrecorded", RUN_ID]),
            h.context,
          ),
          EXIT_CODES.ok,
          h.stderr(),
        );
        // The real composition has one runner group, so one trigger at most.
        assert.equal(h.json().recordedTriggers, 1);
        assert.equal(h.json().recordedTriggersFrom, "unrecorded-bound");
        h.clear();
        assert.equal(
          await main(
            cleanupArgv(["--mode", "apply", "--confirm-unrecorded", RUN_ID]),
            h.context,
          ),
          EXIT_CODES.ok,
          h.stderr(),
        );
        assert.deepEqual(leftovers(h), []);
      } finally {
        h.restore();
      }
    });

    // Wave 14: `readRecordedTriggers` turns a ledger it cannot read into a
    // `null` count. The run record is still readable (so cleanup knows the
    // run and takes the ledger path), but the trigger journal is not — the
    // count is UNKNOWN, and the store must refuse rather than fall back to
    // 0 or to the pre-wave-13 gate.
    it("an unreadable ledger is a null trigger count: apply refuses (exit 4), nothing deleted", async () => {
      const h = await harness();
      try {
        const ledger = await triggeredRun(h, 2);
        // Both result rows exist: with a readable ledger apply would succeed
        // (see "tears down (exit 0)" above), so the refusal below is the
        // unreadable count's alone.
        leaveTriggeredSuite(h, 2);
        const log = path.join(h.ledgerRoot, "runs", RUN_ID, "ledger.jsonl");
        assert.ok(existsSync(log), "the run journals to ledger.jsonl");
        await fs.rm(log);
        await fs.mkdir(log); // a directory: every read of it fails (EISDIR)
        assert.equal(
          (await ledger.readRun(RUN_ID)).state,
          "failed",
          "the run record itself stays readable",
        );
        await assert.rejects(ledger.entries(RUN_ID));

        h.clear();
        assert.equal(
          await main(cleanupArgv(["--mode", "apply"]), h.context),
          EXIT_CODES.refused,
          `${h.stdout()}\n${h.stderr()}`,
        );
        assert.match(h.stderr(), /REFUSED \(DEV-17\)/);
        assert.match(
          h.stderr(),
          /recorded suite-trigger count is unknown \(null\)/,
        );
        assert.deepEqual(deletes(h), [], "no DELETE reached the runner");
        assert.equal(leftovers(h).length, 3, "suite, test and link survive");
        assert.equal((await ledger.readRun(RUN_ID)).state, "failed");
      } finally {
        h.restore();
      }
    });
  });

  it("refuses a malformed run id before composing a plan (no ledger root)", async () => {
    // Before: exit 0 with a plan whose namespace was the raw id — an
    // encoded-query fragment ("x^ORsys_idISNOTEMPTY^name!=:").
    const h = await harness();
    h.restore();
    for (const mode of ["plan", "apply"]) {
      h.clear();
      assert.equal(
        await main(
          [
            "cleanup",
            "--run-id",
            "x^ORsys_idISNOTEMPTY^name!=",
            "--runner",
            "runner",
            "--allow",
            RUNNER_HOST,
            "--mode",
            mode,
            "--json",
          ],
          h.context,
        ),
        EXIT_CODES.usage,
        h.stderr(),
      );
      assert.match(h.stderr(), /invalid run id/);
      assert.equal(h.stdout(), "");
    }
    assert.equal(existsSync(h.ledgerRoot), false);
    assert.deepEqual(h.fake.requests(), []);
  });

  it("reads `--run-id --help` as a run id, and refuses it as one", async () => {
    // `--help` in the VALUE position of `--run-id` is not a help request
    // (this is the argv an MCP call `{"runId":"--help"}` used to produce).
    const h = await harness();
    h.restore();
    for (const command of ["status", "confirm", "cleanup"]) {
      h.clear();
      assert.equal(
        await main([command, "--json", "--run-id", "--help"], h.context),
        EXIT_CODES.usage,
        `${command}: ${h.stdout()}`,
      );
      assert.match(h.stderr(), /invalid run id "--help"/);
    }
  });

  it("rejects a bad --mode and a missing --run-id as usage errors", async () => {
    const h = await harness();
    h.restore();
    h.clear();
    assert.equal(
      await main(cleanupArgv(["--mode", "yolo"]), h.context),
      EXIT_CODES.usage,
    );
    h.clear();
    assert.equal(await main(["cleanup"], h.context), EXIT_CODES.usage);
  });
});
