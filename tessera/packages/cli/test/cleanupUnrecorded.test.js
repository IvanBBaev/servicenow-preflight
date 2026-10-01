// `tess cleanup` with NO local run record (fix 2026-09-26, F2d): a namespace
// sweep is addressed by nothing but the run id, so the id must be one Tessera
// minted (`run-<yyyymmdd>t<hhmmss>-<8 hex>`) or the operator must retype it in
// `--confirm-unrecorded <run-id>`. Behind that, the ATF store's own ownership
// check (F2a/b) refuses rows it did not create — surfaced as exit 4.
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
  runOwnershipMarker,
} from "@tessera/teststore-atf";

import { EXIT_CODES, main } from "../build/index.js";
import { MINTED_RUN_ID_PATTERN } from "../build/commands/runState.js";

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

async function harness(state = {}) {
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
      ],
      ...state,
    },
    acl: {
      roles: [W2_AUTHORING_ROLE],
      rules: W2_AUTHORING_CHANNEL_ACL_RULES,
    },
  });
  const restoreFetch = fake.install();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-cleanup-"));
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

const argv = (runId, extra = []) => [
  "cleanup",
  "--run-id",
  runId,
  "--runner",
  "runner",
  "--allow",
  RUNNER_HOST,
  ...extra,
];

/** A customer's own ATF test that happens to sit in run `smoke`'s namespace. */
const CUSTOMER_STATE = {
  sys_atf_test: [{ sys_id: "1".repeat(32), name: "smoke:login" }],
  sys_atf_test_suite: [{ sys_id: "3".repeat(32), name: "Customer suite" }],
  sys_atf_test_suite_test: [
    {
      sys_id: "4".repeat(32),
      test_suite: "3".repeat(32),
      test: "1".repeat(32),
    },
  ],
};

const MINTED = "run-20260926t100000-0a1b2c3d";

describe("MINTED_RUN_ID_PATTERN", () => {
  it("matches what `tess run` mints and nothing looser", () => {
    // The mint formula of commands/run.ts, replayed over a fixed clock.
    const stamp = new Date("2026-09-26T10:00:00.123Z")
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..*$/, "")
      .toLowerCase();
    assert.ok(MINTED_RUN_ID_PATTERN.test(`run-${stamp}-deadbeef`));
    assert.ok(MINTED_RUN_ID_PATTERN.test(MINTED));
    for (const id of [
      "smoke",
      "live-run-0001",
      "run-20260926t100000-0a1b2c3",
      "run-20260926t100000-0a1b2c3dd",
      "run-20260926T100000-0a1b2c3d",
      "run-2026092t100000-0a1b2c3d",
      "run-20260926t100000-0a1b2c3g",
      `x${MINTED}`,
    ]) {
      assert.equal(MINTED_RUN_ID_PATTERN.test(id), false, id);
    }
  });
});

describe("tess cleanup with no local run record (F2d)", () => {
  it("apply refuses (exit 4) a non-minted run id without contacting the runner", async () => {
    const h = await harness(CUSTOMER_STATE);
    try {
      assert.equal(
        await main(argv("smoke", ["--mode", "apply"]), h.context),
        EXIT_CODES.refused,
        h.stdout(),
      );
      assert.match(h.stderr(), /REFUSED \(unrecorded namespace\)/);
      assert.match(h.stderr(), /--confirm-unrecorded smoke/);
    } finally {
      h.restore();
    }
    assert.deepEqual(h.fake.requests(), []);
    assert.equal(h.fake.tables.count("sys_atf_test"), 1);
  });

  it("plan reports that apply would be refused (and touches nothing)", async () => {
    const h = await harness();
    try {
      assert.equal(
        await main(argv("smoke", ["--json"]), h.context),
        EXIT_CODES.ok,
        h.stderr(),
      );
      assert.equal(h.json().unrecordedSweep, "refused");
    } finally {
      h.restore();
    }
    assert.deepEqual(h.fake.requests(), []);
  });

  it("a --confirm-unrecorded that does not repeat --run-id is a usage error", async () => {
    const h = await harness();
    try {
      for (const mode of ["plan", "apply"]) {
        assert.equal(
          await main(
            argv("smoke", ["--mode", mode, "--confirm-unrecorded", "smok"]),
            h.context,
          ),
          EXIT_CODES.usage,
        );
      }
    } finally {
      h.restore();
    }
    assert.deepEqual(h.fake.requests(), []);
  });

  it("confirmed, the store's ownership check still refuses customer rows (exit 4, nothing deleted)", async () => {
    const h = await harness(CUSTOMER_STATE);
    try {
      assert.equal(
        await main(
          argv("smoke", [
            "--mode",
            "apply",
            "--confirm-unrecorded",
            "smoke",
            "--json",
          ]),
          h.context,
        ),
        EXIT_CODES.refused,
        h.stdout(),
      );
      assert.match(h.stderr(), /REFUSED \(ownership\)/);
      assert.match(h.stderr(), /smoke:login/);
    } finally {
      h.restore();
    }
    assert.deepEqual(
      h.fake.requests().filter((r) => r.method === "DELETE"),
      [],
    );
    assert.equal(h.fake.tables.count("sys_atf_test"), 1);
    assert.equal(h.fake.tables.count("sys_atf_test_suite_test"), 1);
  });

  it("a minted run id sweeps its own terminal records without confirmation (exit 0)", async () => {
    const marker = runOwnershipMarker(MINTED);
    const suiteId = "a".repeat(32);
    const testId = "b".repeat(32);
    const h = await harness({
      sys_atf_test_suite: [
        {
          sys_id: suiteId,
          name: `${MINTED}:suite`,
          description: `${marker}suite`,
        },
      ],
      sys_atf_test: [
        {
          sys_id: testId,
          name: `${MINTED}:alpha`,
          description: `${marker}alpha`,
        },
      ],
      sys_atf_test_suite_test: [{ test_suite: suiteId, test: testId }],
      sys_atf_test_suite_result: [{ test_suite: suiteId, status: "success" }],
    });
    try {
      assert.equal(
        await main(argv(MINTED, ["--json"]), h.context),
        EXIT_CODES.ok,
      );
      assert.equal(h.json().unrecordedSweep, "minted-run-id");
    } finally {
      h.restore();
    }
    const h2 = await harness({
      sys_atf_test_suite: [
        {
          sys_id: suiteId,
          name: `${MINTED}:suite`,
          description: `${marker}suite`,
        },
      ],
      sys_atf_test: [
        {
          sys_id: testId,
          name: `${MINTED}:alpha`,
          description: `${marker}alpha`,
        },
      ],
      sys_atf_test_suite_test: [{ test_suite: suiteId, test: testId }],
      sys_atf_test_suite_result: [{ test_suite: suiteId, status: "success" }],
    });
    try {
      assert.equal(
        await main(argv(MINTED, ["--mode", "apply", "--json"]), h2.context),
        EXIT_CODES.ok,
        h2.stderr(),
      );
    } finally {
      h2.restore();
    }
    assert.equal(h2.fake.tables.count("sys_atf_test"), 0);
    assert.equal(h2.fake.tables.count("sys_atf_test_suite"), 0);
    assert.equal(h2.fake.tables.count("sys_atf_test_suite_test"), 0);
    assert.equal(h2.fake.tables.count("sys_atf_test_suite_result"), 1);
  });
});
