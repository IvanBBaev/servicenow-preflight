// `tess status` / `tess confirm` text rendering and refusals, plus the
// `tess cleanup` refusals that are decided before any instance is contacted.
//
// Runs are written straight through the ledger and its run event log, and
// `fetch` is replaced by a rejecting stub for every call: nothing here may
// reach the network.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createIntentLedger, createRunEventLog } from "@tessera/ledger";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import { EXIT_CODES, LIVE_RESULT_KIND, main } from "../build/index.js";

const RUN_ID = "run-state-read-0001";
const NOW = () => new Date("2026-10-16T10:00:00.000Z");

const roots = [];
after(async () => {
  await Promise.all(
    roots.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const GO_COUNTS = {
  pass: 2,
  fail: 0,
  missing: 0,
  inconclusive: 0,
  blocking: 0,
};

/** A persisted live record; `extra` overrides any field. */
function liveRecord(extra = {}) {
  return JSON.parse(
    JSON.stringify({
      kind: LIVE_RESULT_KIND,
      runId: RUN_ID,
      exitCode: EXIT_CODES.ok,
      state: "done",
      teardown: "completed",
      verdict: {
        status: "GO",
        counts: GO_COUNTS,
        rows: [],
        overrides: [],
        confirmToken: { verdictHash: "sha256:abc123" },
      },
      result: {},
      planned: 2,
      failures: [],
      ...extra,
    }),
  );
}

/**
 * A ledger root under a fresh cwd. `states` walks the run through the §4b
 * transitions after `openRun`; `persisted` (when given) is written as the
 * run's result; `events` are appended to its event log.
 */
async function harness({
  open = true,
  lifecycle = "ephemeral",
  states = [],
  persisted,
  events = [],
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-rs-read-"));
  roots.push(root);
  const ledgerRoot = path.join(root, ".tessera");
  await fs.mkdir(ledgerRoot, { recursive: true });
  if (open) {
    const ledger = createIntentLedger({ rootDir: ledgerRoot, now: NOW });
    await ledger.openRun({
      runId: RUN_ID,
      scope: "x_tessera_read",
      runner: "runner",
      lifecycle,
    });
    for (const state of states) await ledger.transition(RUN_ID, state);
    const log = createRunEventLog({ rootDir: ledgerRoot, now: NOW });
    for (const event of events) await log.appendEvent(RUN_ID, event);
    if (persisted !== undefined) await log.writeResult(RUN_ID, persisted);
  }
  const context = {
    now: NOW,
    actor: "test",
    cwd: root,
    env: {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  let out = [];
  let err = [];
  return {
    ledgerRoot,
    async run(argv) {
      out = [];
      err = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = () =>
        Promise.reject(new Error("these commands must not touch the network"));
      try {
        const code = await main(argv, context);
        return { code, out: out.join("\n"), err: err.join("\n") };
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  };
}

const FAILED = ["tearing-down", "failed"];
const DONE = ["tearing-down", "done"];

describe("tess status — refusals", () => {
  it("needs --run-id, and a value flag needs a non-blank value", async () => {
    const h = await harness();
    const bare = await h.run(["status"]);
    assert.equal(bare.code, EXIT_CODES.usage);
    assert.match(bare.err, /status needs --run-id <id>/);
    const blank = await h.run(["status", "--run-id", RUN_ID, "--since", " "]);
    assert.equal(blank.code, EXIT_CODES.usage);
    assert.match(blank.err, /--since expects a value/);
  });

  it("an unknown run under an existing ledger root is a usage error naming the root", async () => {
    const h = await harness({ open: false });
    const r = await h.run(["status", "--run-id", "run-nobody"]);
    assert.equal(r.code, EXIT_CODES.usage);
    assert.ok(
      r.err.includes(`no run "run-nobody" under ${h.ledgerRoot}`),
      r.err,
    );
  });
});

describe("tess status — text rendering", () => {
  it("a failed run with no result says so and points at cleanup", async () => {
    const h = await harness({ states: FAILED });
    const r = await h.run(["status", "--run-id", RUN_ID]);
    assert.equal(r.code, EXIT_CODES.ok, r.err);
    assert.match(r.out, new RegExp(`^run ${RUN_ID}: failed$`, "m"));
    assert.match(r.out, /^ {2}result: {3}none persisted$/m);
    assert.match(
      r.out,
      new RegExp(
        `^ {2}next: {5}tess cleanup --run-id ${RUN_ID} \\(§4b — failed runs`,
        "m",
      ),
    );
  });

  it("an abandoned run points at cleanup too; a done run does not", async () => {
    const abandoned = await harness({ states: ["abandoned"] });
    assert.match(
      (await abandoned.run(["status", "--run-id", RUN_ID])).out,
      /§4b — abandoned runs are re-entered by cleanup only/,
    );
    const done = await harness({ states: DONE, persisted: liveRecord() });
    const r = await done.run(["status", "--run-id", RUN_ID]);
    assert.doesNotMatch(r.out, /next:/);
    assert.match(r.out, /^ {2}result: {3}GO, exit 0, teardown completed$/m);
  });

  it("a non-terminal run with no result prints no result line", async () => {
    const h = await harness({ states: ["provisioning"] });
    const r = await h.run(["status", "--run-id", RUN_ID]);
    assert.equal(r.code, EXIT_CODES.ok, r.err);
    assert.doesNotMatch(r.out, /result:/);
  });

  it("a persisted result that is not a live record reads as none persisted", async () => {
    for (const persisted of [
      { kind: "something-else", verdict: {}, exitCode: 0 },
      liveRecord({ verdict: undefined }),
      liveRecord({ exitCode: "0" }),
      "a string",
    ]) {
      const h = await harness({ states: DONE, persisted });
      const r = await h.run(["status", "--run-id", RUN_ID]);
      assert.equal(r.code, EXIT_CODES.ok, r.err);
      assert.match(
        r.out,
        /^ {2}result: {3}none persisted$/m,
        JSON.stringify(persisted),
      );
    }
  });

  it("each event prints with its cursor, and its stage when the data names one", async () => {
    const h = await harness({
      states: ["provisioning"],
      events: [
        { type: "stage", data: { stage: "project" } },
        { type: "note", data: { stage: 7 } },
        { type: "bare" },
      ],
    });
    const r = await h.run(["status", "--run-id", RUN_ID]);
    const at = NOW().toISOString();
    assert.ok(r.out.includes(`stage (project)`), r.out);
    assert.match(r.out, new RegExp(`#\\d+ ${escape(at)} note$`, "m"));
    assert.match(r.out, new RegExp(`#\\d+ ${escape(at)} bare$`, "m"));
    assert.match(r.out, /cursor: {3}\d+ \(pass as --since to resume\)/);
  });
});

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("tess confirm — refusals", () => {
  it("needs --run-id, and an unknown run is a usage error", async () => {
    const h = await harness({ open: false });
    const bare = await h.run(["confirm"]);
    assert.equal(bare.code, EXIT_CODES.usage);
    assert.match(bare.err, /confirm needs --run-id <id>/);
    const unknown = await h.run(["confirm", "--run-id", "run-nobody"]);
    assert.equal(unknown.code, EXIT_CODES.usage);
    assert.ok(
      unknown.err.includes(`no run "run-nobody" under ${h.ledgerRoot}`),
      unknown.err,
    );
  });

  it("a persisted result that is not a live record — or carries an unknown exit code — is a fault", async () => {
    for (const persisted of [
      { kind: "something-else" },
      liveRecord({ verdict: undefined }),
      liveRecord({ exitCode: 99 }),
    ]) {
      const h = await harness({ states: DONE, persisted });
      const r = await h.run(["confirm", "--run-id", RUN_ID]);
      assert.equal(r.code, EXIT_CODES.fault, JSON.stringify(persisted));
      assert.match(
        r.err,
        /^INFRASTRUCTURE FAULT \(DEV-1\): the persisted result of run/,
      );
      assert.equal(r.out, "");
    }
  });
});

describe("tess confirm — text rendering", () => {
  it("a GO verdict prints its counts and confirm token, and exits with the record's code", async () => {
    const h = await harness({ states: DONE, persisted: liveRecord() });
    const r = await h.run(["confirm", "--run-id", RUN_ID]);
    assert.equal(r.code, EXIT_CODES.ok, r.err);
    assert.match(r.out, /^VERDICT: GO$/m);
    assert.match(
      r.out,
      /2 pass, 0 fail \(0 missing\), 0 inconclusive, 0 blocking/,
    );
    assert.match(r.out, /^ {2}confirm token: sha256:abc123$/m);
    assert.match(r.out, /^exit: 0$/m);
  });

  it("lists every non-pass row, each override and each failure (REFUSED vs FAULT)", async () => {
    const record = liveRecord({
      exitCode: EXIT_CODES.inconclusive,
      verdict: {
        status: "INCONCLUSIVE",
        counts: { pass: 1, fail: 1, missing: 0, inconclusive: 1, blocking: 0 },
        rows: [
          { status: "pass", spec: { id: "t.ok", path: "tests/ok.json" } },
          { status: "fail", spec: { id: "t.bad", path: "tests/bad.json" } },
          { status: "inconclusive", spec: { id: "t.q", path: "tests/q.json" } },
        ],
        overrides: [{ flag: "--allow-skipped", actor: "ops", affectedRows: 2 }],
      },
      failures: [
        { refused: true, stage: "guard", message: "production" },
        { refused: false, stage: "teardown", message: "timeout" },
      ],
    });
    const h = await harness({ states: DONE, persisted: record });
    const r = await h.run(["confirm", "--run-id", RUN_ID]);
    assert.equal(r.code, EXIT_CODES.inconclusive, r.err);
    assert.doesNotMatch(r.out, /t\.ok/);
    assert.match(r.out, /^ {2}- fail: t\.bad \(tests\/bad\.json\)$/m);
    assert.match(r.out, /^ {2}- inconclusive: t\.q \(tests\/q\.json\)$/m);
    assert.match(
      r.out,
      /^ {2}override: --allow-skipped by ops \(2 row\(s\)\)$/m,
    );
    assert.match(r.out, /^ {2}REFUSED at guard: production$/m);
    assert.match(r.out, /^ {2}FAULT at teardown: timeout$/m);
    assert.match(r.out, /confirm token: none — only a GO verdict carries one/);
    assert.match(r.out, new RegExp(`^exit: ${EXIT_CODES.inconclusive}$`, "m"));
  });
});

describe("tess cleanup — refusals before any instance is contacted", () => {
  it("a --runner profile with no instance is a usage error", async () => {
    const h = await harness({ open: false });
    const r = await h.run([
      "cleanup",
      "--run-id",
      RUN_ID,
      "--runner",
      "nosuchprofile",
    ]);
    assert.equal(r.code, EXIT_CODES.usage);
    assert.match(
      r.err,
      /--runner names the profile "nosuchprofile", but it has no instance/,
    );
  });

  it("a persistent run is refused (§4a) even when terminal — persistent definitions are never deleted", async () => {
    const h = await harness({ lifecycle: "persistent", states: FAILED });
    const r = await withRunnerProfile(() =>
      h.run([
        "cleanup",
        "--run-id",
        RUN_ID,
        "--runner",
        "runner",
        "--mode",
        "apply",
      ]),
    );
    assert.equal(r.code, EXIT_CODES.refused);
    assert.match(
      r.err,
      new RegExp(`REFUSED \\(§4a\\): run ${RUN_ID} is persistent`),
    );
    assert.match(r.err, /Nothing was deleted\./);
  });

  it("the text plan for an unrecorded, non-minted run id says apply would be refused", async () => {
    const h = await harness({ open: false });
    const r = await withRunnerProfile(() =>
      h.run(["cleanup", "--run-id", "smoke", "--runner", "runner"]),
    );
    assert.equal(r.code, EXIT_CODES.ok, r.err);
    assert.match(
      r.out,
      /^tess cleanup — plan for run smoke \(nothing written\)$/m,
    );
    assert.match(r.out, /^ {2}runner: {3}runner \(dev-read\.example\.com\)$/m);
    assert.match(
      r.out,
      /^ {2}REFUSED: {2}apply with no local record needs a Tessera-minted run id or --confirm-unrecorded smoke$/m,
    );
    assert.doesNotMatch(r.out, /Re-run with --mode apply/);
  });
});

const PROFILE_KEYS = [
  "SN_PROFILE_RUNNER_INSTANCE",
  "SN_PROFILE_RUNNER_USER",
  "SN_PROFILE_RUNNER_PASSWORD",
];

/** Bind a `runner` profile for the duration of `body`, then restore the env. */
async function withRunnerProfile(body) {
  const saved = new Map(PROFILE_KEYS.map((key) => [key, process.env[key]]));
  process.env.SN_PROFILE_RUNNER_INSTANCE = "dev-read.example.com";
  process.env.SN_PROFILE_RUNNER_USER = "tessera";
  process.env.SN_PROFILE_RUNNER_PASSWORD = "tessera";
  reloadCredentialsFromEnv();
  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadCredentialsFromEnv();
  }
}
