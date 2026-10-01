// `tess cleanup --legacy` (wave 14): the operator-confirmed sweep of ATF rows
// a pre-marker store wrote. Plan issues GETs only and prints the discovery
// report (a table, or the raw report under --json); apply takes that report
// plus explicit sys_ids, runs the §11 guard, and deletes nothing unless every
// confirmed row re-verifies. Every refusal is exit 4 with zero DELETEs.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createFakeInstance,
  W2_AUTHORING_CHANNEL_ACL_RULES,
  W2_AUTHORING_ROLE,
} from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";
import {
  AUTHORING_CHANNEL_VERSION,
  AUTHORING_CHANNEL_VERSION_PROPERTY,
  LEGACY_ATF_REPORT_KIND,
  runOwnershipMarker,
} from "@tessera/teststore-atf";

import { EXIT_CODES, main } from "../build/index.js";

const RUNNER_HOST = "dev-cleanup.service-now.com";

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

async function harness(state = {}, properties = []) {
  const fake = createFakeInstance({
    host: RUNNER_HOST,
    state: {
      sys_properties: [
        { name: "sn_atf.runner.enabled", value: "true" },
        { name: "glide.installation.production", value: "false" },
        {
          name: AUTHORING_CHANNEL_VERSION_PROPERTY,
          value: AUTHORING_CHANNEL_VERSION,
        },
        ...properties,
      ],
      ...state,
    },
    acl: {
      roles: [W2_AUTHORING_ROLE],
      rules: W2_AUTHORING_CHANNEL_ACL_RULES,
    },
  });
  const restoreFetch = fake.install();
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "tessera-cleanup-legacy-"),
  );
  tempRoots.push(root);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(root, "sn-docs");
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_PROFILE_RUNNER_INSTANCE = RUNNER_HOST;
  process.env.SN_PROFILE_RUNNER_USER = "tessera";
  process.env.SN_PROFILE_RUNNER_PASSWORD = "tessera";
  reloadCredentialsFromEnv();

  const out = [];
  const err = [];
  let restored = false;
  return {
    fake,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    json: () => JSON.parse(out.join("\n")),
    context: {
      now: () => new Date("2026-09-26T10:00:00.000Z"),
      actor: "test",
      cwd: root,
      env: {},
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
    restore() {
      if (restored) return;
      restored = true;
      restoreFetch();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    },
  };
}

const LEGACY_RUN = "run-20260920t101500-abcdef01";
const OTHER_RUN = "run-20260921t101500-abcdef02";
const LEGACY_TEST = "a".repeat(32);
const LEGACY_SUITE = "b".repeat(32);
const LEGACY_LINK = "c".repeat(32);
const LEGACY_STEP = "d".repeat(32);
const LEGACY_INPUT = "e".repeat(32);
const LEGACY_RESULT = "f".repeat(32);
const CUSTOMER_TEST = "1".repeat(32);
const CUSTOMER_SUITE = "2".repeat(32);
const EXPLICIT_TEST = "3".repeat(32);
const CONFLICT_TEST = "4".repeat(32);
const FOREIGN_LINK = "5".repeat(32);

function legacyState(overrides = {}) {
  return {
    sys_atf_test: [
      {
        sys_id: LEGACY_TEST,
        name: `${LEGACY_RUN}:alpha`,
        description: "projected from spec alpha (tests/alpha.test.ts)",
        sys_created_by: "tessera.author",
      },
      {
        sys_id: CUSTOMER_TEST,
        name: "smoke:login",
        description: "Customer smoke test",
      },
      {
        sys_id: EXPLICIT_TEST,
        name: "bench-01:beta",
        description: "projected by a benchmark",
      },
      {
        sys_id: CONFLICT_TEST,
        name: `${LEGACY_RUN}:gamma`,
        description: `${runOwnershipMarker(OTHER_RUN)} — not this run`,
      },
    ],
    sys_atf_test_suite: [
      {
        sys_id: LEGACY_SUITE,
        name: `${LEGACY_RUN}:suite`,
        description: "DEV-8/DEV-19 throwaway suite",
      },
      { sys_id: CUSTOMER_SUITE, name: "Customer nightly", description: "x" },
    ],
    sys_atf_test_suite_test: [
      { sys_id: LEGACY_LINK, test_suite: LEGACY_SUITE, test: LEGACY_TEST },
    ],
    sys_atf_step: [{ sys_id: LEGACY_STEP, test: LEGACY_TEST }],
    sys_variable_value: [
      {
        sys_id: LEGACY_INPUT,
        document: "sys_atf_step",
        document_key: LEGACY_STEP,
        value: "gs.info(1);",
      },
    ],
    sys_atf_test_suite_result: [
      { sys_id: LEGACY_RESULT, test_suite: LEGACY_SUITE, status: "success" },
    ],
    ...overrides,
  };
}

const TABLES = [
  "sys_atf_test",
  "sys_atf_test_suite",
  "sys_atf_test_suite_test",
  "sys_atf_step",
  "sys_variable_value",
  "sys_atf_test_suite_result",
];
const counts = (fake) =>
  Object.fromEntries(TABLES.map((table) => [table, fake.tables.count(table)]));
const methods = (fake) => [
  ...new Set(fake.requests().map((request) => request.method)),
];
const deletes = (fake) =>
  fake.requests().filter((request) => request.method === "DELETE");

const legacy = (extra = []) => [
  "cleanup",
  "--legacy",
  "--runner",
  "runner",
  ...extra,
];

/** Run a `--json` plan and save its report under the harness cwd. */
async function saveReport(h, extra = [], name = "legacy.json") {
  assert.equal(
    await main(legacy(["--json", ...extra]), h.context),
    EXIT_CODES.ok,
    h.stderr(),
  );
  const report = h.json();
  const file = path.join(h.context.cwd, name);
  await fs.writeFile(file, JSON.stringify(report));
  return { report, file };
}

/** A second harness context over the SAME fake instance, fresh output. */
function reuse(h) {
  const out = [];
  const err = [];
  return {
    ...h,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    json: () => JSON.parse(out.join("\n")),
    context: {
      ...h.context,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  };
}

const apply = (report, confirm, extra = []) =>
  legacy([
    "--mode",
    "apply",
    "--allow",
    RUNNER_HOST,
    "--report",
    report,
    "--confirm",
    confirm,
    ...extra,
  ]);

describe("tess cleanup --legacy — plan", () => {
  it("prints candidates, blockers and conflicts, issuing GETs only", async () => {
    const h = await harness(
      legacyState({
        sys_atf_test_suite: [
          {
            sys_id: LEGACY_SUITE,
            name: `${LEGACY_RUN}:suite`,
            description: "",
          },
        ],
      }),
    );
    try {
      assert.equal(await main(legacy(), h.context), EXIT_CODES.ok, h.stderr());
    } finally {
      h.restore();
    }
    const out = h.stdout();
    assert.match(out, /tess cleanup --legacy — plan on runner/);
    assert.match(out, /nothing written/);
    assert.match(out, new RegExp(`sys_atf_test ${LEGACY_TEST}`));
    assert.match(out, new RegExp(`sys_atf_test_suite ${LEGACY_SUITE}`));
    assert.match(out, /1 step\(s\), 1 step input\(s\), 1 suite link\(s\)/);
    assert.match(out, /candidates: 2 \(1 test\(s\), 1 suite\(s\)\)/);
    // The empty description is a blocker the operator must see.
    assert.match(out, /BLOCKED: /);
    assert.match(out, /conflicts:\s+1/);
    assert.match(out, new RegExp(CONFLICT_TEST));
    assert.match(out, /--mode apply --report <file> --confirm/);
    // Neither the customer's row nor the explicit-id row is in a default scan.
    assert.doesNotMatch(out, new RegExp(CUSTOMER_TEST));
    assert.doesNotMatch(out, new RegExp(EXPLICIT_TEST));
    assert.deepEqual(methods(h.fake), ["GET"]);
  });

  it("--json prints the raw report; --run-id widens its explicit scope", async () => {
    const h = await harness(legacyState());
    try {
      assert.equal(
        await main(
          legacy(["--json", "--run-id", "bench-01", "--run-id", "bench-02"]),
          h.context,
        ),
        EXIT_CODES.ok,
        h.stderr(),
      );
    } finally {
      h.restore();
    }
    const report = h.json();
    assert.equal(report.kind, LEGACY_ATF_REPORT_KIND);
    assert.deepEqual(report.scope, {
      mintedRunIds: true,
      runIds: ["bench-01", "bench-02"],
    });
    const key = (row) => row.join(" ");
    assert.deepEqual(
      report.candidates
        .map((c) => [c.table, c.sysId, c.runId])
        .map(key)
        .sort(),
      [
        ["sys_atf_test", LEGACY_TEST, LEGACY_RUN],
        ["sys_atf_test", EXPLICIT_TEST, "bench-01"],
        ["sys_atf_test_suite", LEGACY_SUITE, LEGACY_RUN],
      ]
        .map(key)
        .sort(),
    );
    assert.deepEqual(
      report.conflicts.map((c) => c.sysId),
      [CONFLICT_TEST],
    );
    assert.deepEqual(methods(h.fake), ["GET"]);
  });

  it("runs no §11 guard: a production runner is still inventoried", async () => {
    const h = await harness(legacyState(), [
      { name: "glide.installation.production", value: "true" },
    ]);
    try {
      assert.equal(
        await main(legacy(["--json", "--prod", RUNNER_HOST]), h.context),
        EXIT_CODES.ok,
        h.stderr(),
      );
    } finally {
      h.restore();
    }
    assert.equal(h.json().candidates.length, 2);
    assert.deepEqual(methods(h.fake), ["GET"]);
  });
});

describe("tess cleanup --legacy --mode apply", () => {
  it("deletes exactly the confirmed rows (and their steps), keeping results", async () => {
    const h = await harness(legacyState());
    let applied;
    try {
      const { file } = await saveReport(h);
      applied = reuse(h);
      assert.equal(
        await main(
          apply(file, `${LEGACY_TEST}, ${LEGACY_SUITE}`),
          applied.context,
        ),
        EXIT_CODES.ok,
        applied.stderr(),
      );
    } finally {
      h.restore();
    }
    assert.match(applied.stdout(), /deleted \d+ row\(s\) on /);
    assert.match(applied.stdout(), new RegExp(`sys_atf_test ${LEGACY_TEST}`));
    assert.match(
      applied.stdout(),
      new RegExp(`sys_atf_test_suite ${LEGACY_SUITE}`),
    );
    assert.deepEqual(counts(h.fake), {
      sys_atf_test: 3, // the customer's, the explicit-id and the conflicting rows survive
      sys_atf_test_suite: 1,
      sys_atf_test_suite_test: 0,
      sys_atf_step: 0,
      sys_variable_value: 0,
      sys_atf_test_suite_result: 1, // evidence stays (QA-17)
    });
  });

  it("--json prints the deleted rows", async () => {
    const h = await harness(legacyState());
    let applied;
    try {
      const { file } = await saveReport(h);
      applied = reuse(h);
      assert.equal(
        await main(
          apply(path.basename(file), `${LEGACY_TEST},${LEGACY_SUITE}`, [
            "--json",
          ]),
          applied.context,
        ),
        EXIT_CODES.ok,
        applied.stderr(),
      );
    } finally {
      h.restore();
    }
    const outcome = applied.json();
    assert.equal(outcome.mode, "apply");
    assert.equal(outcome.runnerHost, RUNNER_HOST);
    assert.ok(
      outcome.deleted.some(
        (row) => row.table === "sys_atf_test" && row.sysId === LEGACY_TEST,
      ),
    );
    assert.ok(
      outcome.deleted.some(
        (row) =>
          row.table === "sys_atf_test_suite" && row.sysId === LEGACY_SUITE,
      ),
    );
    assert.equal(deletes(h.fake).length, outcome.deleted.length);
  });

  /** Plan, optionally mutate, apply: exit 4, the reason, and zero DELETEs. */
  async function refused({ state, mutate, confirm, reason, forge }) {
    const h = await harness(state ?? legacyState());
    let applied;
    try {
      const { report, file } = await saveReport(h);
      if (forge) await fs.writeFile(file, JSON.stringify(forge(report)));
      if (mutate) mutate(h.fake);
      const before = counts(h.fake);
      applied = reuse(h);
      assert.equal(
        await main(
          apply(file, confirm ?? `${LEGACY_TEST},${LEGACY_SUITE}`),
          applied.context,
        ),
        EXIT_CODES.refused,
        applied.stdout() + applied.stderr(),
      );
      assert.deepEqual(counts(h.fake), before);
    } finally {
      h.restore();
    }
    assert.match(
      applied.stderr(),
      new RegExp(`REFUSED \\(legacy: ${reason}\\)`),
    );
    assert.match(applied.stderr(), /Nothing was deleted/);
    assert.deepEqual(deletes(h.fake), []);
  }

  it("refuses a malformed confirmed sys_id (confirmation)", () =>
    refused({ confirm: "not-a-sys-id", reason: "confirmation" }));

  it("refuses a sys_id confirmed twice (confirmation)", () =>
    refused({
      confirm: `${LEGACY_TEST},${LEGACY_TEST}`,
      reason: "confirmation",
    }));

  it("refuses a sys_id the report does not list (not-in-report)", () =>
    refused({ confirm: CUSTOMER_TEST, reason: "not-in-report" }));

  it("refuses a row that changed since the plan (row-changed)", () =>
    refused({
      mutate: (fake) =>
        fake.tables.update("sys_atf_test", LEGACY_TEST, {
          name: "renamed by a human",
        }),
      reason: "row-changed",
    }));

  it("refuses a row with an empty description (empty-description)", () =>
    refused({
      state: legacyState({
        sys_atf_test_suite: [
          {
            sys_id: LEGACY_SUITE,
            name: `${LEGACY_RUN}:suite`,
            description: "",
          },
        ],
      }),
      reason: "empty-description",
    }));

  it("refuses a test linked into an unconfirmed suite (foreign-link)", () =>
    refused({
      state: legacyState({
        sys_atf_test_suite_test: [
          { sys_id: LEGACY_LINK, test_suite: LEGACY_SUITE, test: LEGACY_TEST },
          {
            sys_id: FOREIGN_LINK,
            test_suite: CUSTOMER_SUITE,
            test: LEGACY_TEST,
          },
        ],
      }),
      reason: "foreign-link",
    }));

  it("refuses a suite whose result is still running (non-terminal)", () =>
    refused({
      state: legacyState({
        sys_atf_test_suite_result: [
          {
            sys_id: LEGACY_RESULT,
            test_suite: LEGACY_SUITE,
            status: "running",
          },
        ],
      }),
      reason: "non-terminal",
    }));

  it("refuses a production runner (§11) before reading any row", async () => {
    const h = await harness(legacyState());
    let applied;
    try {
      const { file } = await saveReport(h);
      applied = reuse(h);
      assert.equal(
        await main(
          apply(file, `${LEGACY_TEST},${LEGACY_SUITE}`, [
            "--prod",
            RUNNER_HOST,
          ]),
          applied.context,
        ),
        EXIT_CODES.refused,
        applied.stdout() + applied.stderr(),
      );
    } finally {
      h.restore();
    }
    assert.match(applied.stderr(), /REFUSED \(§11\)/);
    assert.deepEqual(deletes(h.fake), []);
    assert.equal(h.fake.tables.count("sys_atf_test"), 4);
  });

  it("refuses a runner that declares itself production (§11)", async () => {
    const h = await harness(legacyState(), [
      { name: "glide.installation.production", value: "true" },
    ]);
    let applied;
    try {
      const { file } = await saveReport(h);
      applied = reuse(h);
      assert.equal(
        await main(
          apply(file, `${LEGACY_TEST},${LEGACY_SUITE}`),
          applied.context,
        ),
        EXIT_CODES.refused,
        applied.stdout() + applied.stderr(),
      );
    } finally {
      h.restore();
    }
    assert.match(applied.stderr(), /REFUSED \(§11\)/);
    assert.deepEqual(deletes(h.fake), []);
    assert.equal(h.fake.tables.count("sys_atf_test"), 4);
  });
});

describe("tess cleanup --legacy — usage errors (exit 2, nothing contacted)", () => {
  const CASES = [
    ["apply without --report", ["--mode", "apply", "--confirm", LEGACY_TEST]],
    ["apply without --confirm", ["--mode", "apply", "--report", "legacy.json"]],
    ["--report in plan mode", ["--report", "legacy.json"]],
    ["--confirm in plan mode", ["--confirm", LEGACY_TEST]],
    [
      "--run-id in apply mode",
      [
        "--mode",
        "apply",
        "--run-id",
        "bench-01",
        "--report",
        "legacy.json",
        "--confirm",
        LEGACY_TEST,
      ],
    ],
    ["a malformed --run-id", ["--run-id", "Bad Id"]],
    ["an unknown --mode", ["--mode", "delete"]],
    ["--acknowledge-prod", ["--acknowledge-prod", "because"]],
    ["--confirm-unrecorded", ["--confirm-unrecorded", LEGACY_RUN]],
    ["--actor", ["--actor", "someone"]],
    ["--ledger-root", ["--ledger-root", ".tessera"]],
    ["an unknown flag", ["--force"]],
    [
      "a --confirm that names no sys_id",
      ["--mode", "apply", "--report", "legacy.json", "--confirm", " , "],
    ],
  ];
  for (const [name, extra] of CASES) {
    it(name, async () => {
      const h = await harness(legacyState());
      try {
        await fs.writeFile(
          path.join(h.context.cwd, "legacy.json"),
          JSON.stringify({
            kind: LEGACY_ATF_REPORT_KIND,
            scope: { mintedRunIds: true, runIds: [] },
            candidates: [],
            conflicts: [],
          }),
        );
        assert.equal(
          await main(legacy(extra), h.context),
          EXIT_CODES.usage,
          h.stdout() + h.stderr(),
        );
        assert.match(h.stderr(), /tess cleanup --help/);
      } finally {
        h.restore();
      }
      assert.deepEqual(h.fake.requests(), []);
    });
  }

  const REPORTS = [
    ["a missing report file", undefined],
    ["a report that is not JSON", "{ nope"],
    [
      "a report of another kind",
      JSON.stringify({
        kind: "tessera.something-else/v1",
        scope: { mintedRunIds: true, runIds: [] },
        candidates: [],
        conflicts: [],
      }),
    ],
    [
      "a report without candidates",
      JSON.stringify({
        kind: LEGACY_ATF_REPORT_KIND,
        scope: { mintedRunIds: true, runIds: [] },
        conflicts: [],
      }),
    ],
    [
      "a report without a scope",
      JSON.stringify({
        kind: LEGACY_ATF_REPORT_KIND,
        candidates: [],
        conflicts: [],
      }),
    ],
    ["a JSON array", "[]"],
  ];
  for (const [name, content] of REPORTS) {
    it(`apply with ${name}`, async () => {
      const h = await harness(legacyState());
      try {
        if (content !== undefined) {
          await fs.writeFile(path.join(h.context.cwd, "bad.json"), content);
        }
        assert.equal(
          await main(
            apply("bad.json", `${LEGACY_TEST},${LEGACY_SUITE}`),
            h.context,
          ),
          EXIT_CODES.usage,
          h.stdout() + h.stderr(),
        );
        assert.match(h.stderr(), /--report "bad\.json"/);
      } finally {
        h.restore();
      }
      assert.deepEqual(h.fake.requests(), []);
      assert.equal(h.fake.tables.count("sys_atf_test"), 4);
    });
  }

  it("the run-scoped cleanup does not accept the legacy flags", async () => {
    const h = await harness();
    try {
      assert.equal(
        await main(
          [
            "cleanup",
            "--run-id",
            LEGACY_RUN,
            "--runner",
            "runner",
            "--confirm",
            LEGACY_TEST,
          ],
          h.context,
        ),
        EXIT_CODES.usage,
      );
      assert.match(h.stderr(), /unknown flag "--confirm"/);
    } finally {
      h.restore();
    }
  });
});

describe("tess cleanup --legacy is a flag only in a flag position", () => {
  it("switches to the legacy sweep wherever it stands as a flag", async () => {
    const h = await harness(legacyState());
    try {
      assert.equal(
        await main(
          ["cleanup", "--runner", "runner", "--json", "--legacy"],
          h.context,
        ),
        EXIT_CODES.ok,
        h.stderr(),
      );
    } finally {
      h.restore();
    }
    assert.equal(h.json().kind, LEGACY_ATF_REPORT_KIND);
    assert.deepEqual(methods(h.fake), ["GET"]);
  });

  // Every value flag either mode accepts: a `--legacy` right after one is its
  // (missing) value, never the mode switch — and is refused as ambiguous.
  const VALUE_FLAGS = [
    "--run-id",
    "--ledger-root",
    "--runner",
    "--mode",
    "--report",
    "--confirm",
    "--acknowledge-prod",
    "--actor",
    "--confirm-unrecorded",
    "--allow",
    "--prod",
  ];
  const FORMS = [
    ["run-scoped", (flag) => ["cleanup", "--run-id", LEGACY_RUN, flag]],
    ["legacy", (flag) => ["cleanup", "--legacy", "--runner", "runner", flag]],
  ];
  for (const [form, prefix] of FORMS) {
    for (const flag of VALUE_FLAGS) {
      it(`${form}: ${flag} --legacy is a usage error naming the ambiguity`, async () => {
        const h = await harness(legacyState());
        try {
          assert.equal(
            await main([...prefix(flag), "--legacy", "x"], h.context),
            EXIT_CODES.usage,
            h.stdout() + h.stderr(),
          );
        } finally {
          h.restore();
        }
        assert.ok(
          h
            .stderr()
            .includes(`${flag} expects a value, got the flag "--legacy"`),
          h.stderr(),
        );
        assert.deepEqual(h.fake.requests(), []);
      });
    }
  }
});

describe("tess cleanup --help documents --legacy", () => {
  it("names every legacy flag", async () => {
    const h = await harness();
    try {
      assert.equal(await main(["cleanup", "--help"], h.context), EXIT_CODES.ok);
    } finally {
      h.restore();
    }
    for (const flag of [
      "--legacy",
      "--report <file>",
      "--confirm <sys_id,...>",
    ]) {
      assert.ok(h.stdout().includes(flag), flag);
    }
    assert.match(h.stdout(), /legacy refusal/);
  });
});
