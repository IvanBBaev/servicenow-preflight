// `stage()` — the ledger root's lifetime, which is the part of staging that
// outlives the process and therefore the part that can litter a user's disk.
//
// Why this file exists: `preflight_run`'s tool contract told callers "it writes
// to the RUNNER and to nothing else", and that was not true. `stage()` creates
// the §4b ledger root unconditionally, at a point strictly BEFORE any gate has
// run — `runPipeline` asserts §11.5 runner-writability at its first statement
// and refuses concurrent runs immediately after, both before `openRun()`. So a
// refused run was not an unlikely route to a stray `.tessera/`; it was the most
// likely one. Under MCP the cwd belongs to whichever host launched the server,
// so the directory landed somewhere the caller never chose.
//
// The three cases below are the whole rule: remove what we created and nothing
// was written into, keep what a run actually wrote, and never touch what was
// already there. Only `--fake` (a `mkdtemp` root, removed recursively) and an
// explicit `--ledger-root` (the caller's directory, the caller's problem) are
// outside it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv, tableApi } from "@tessera/sn-client";

import { stage, stageDocsDir } from "../build/stage.js";

const LEDGER_DIR = ".tessera";

/** A real (non-`--fake`) staging with no explicit ledger root — the MCP shape. */
const stageInto = (cwd) =>
  stage(
    {
      instanceHost: "example.service-now.com",
      fake: false,
      variant: "correct",
      fakeProductionProperty: false,
      keepLedger: false,
    },
    cwd,
  );

const tempCwd = () => fs.mkdtemp(path.join(os.tmpdir(), "tessera-stage-"));

describe("stage — the ledger root a refused run must not leave behind", () => {
  it("removes the root it created when nothing was ever written into it", async (t) => {
    const cwd = await tempCwd();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const root = path.join(cwd, LEDGER_DIR);

    const harness = await stageInto(cwd);
    // Staging really does create it — asserted so this test cannot pass by the
    // directory never having existed, which would make the check below vacuous.
    assert.equal(existsSync(root), true);
    assert.equal(harness.ledgerRoot, root);
    // The fact `stage()` alone can answer, now reported instead of discarded.
    // It was computed here and thrown away, so the run report could say only
    // "ledger: <path>" — true whether or not this command put a directory on
    // the caller's disk, which is the one local side effect the tool contract
    // claims to bound.
    assert.equal(harness.ledgerRootPreexisted, false);

    harness.restore();

    assert.equal(
      existsSync(root),
      false,
      "a run that never opened must leave no trace in the caller's cwd",
    );
  });

  it("keeps a root the run actually wrote to", async (t) => {
    const cwd = await tempCwd();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const root = path.join(cwd, LEDGER_DIR);

    const harness = await stageInto(cwd);
    // Stands in for `openRun()`: the §4b write-ahead ledger is what makes a
    // crashed run recoverable, so restore() destroying it would remove the
    // guarantee the ledger exists to provide.
    await fs.writeFile(path.join(root, "ledger.jsonl"), "{}\n");

    harness.restore();

    assert.equal(existsSync(root), true);
    assert.equal(
      await fs.readFile(path.join(root, "ledger.jsonl"), "utf8"),
      "{}\n",
      "the ledger must survive byte-for-byte, not merely survive as a directory",
    );
  });

  it("never removes a root it did not create, even an empty one", async (t) => {
    const cwd = await tempCwd();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const root = path.join(cwd, LEDGER_DIR);
    await fs.mkdir(root);

    const harness = await stageInto(cwd);
    // The other value, from the one call that can still distinguish the two
    // cases: after the `mkdirSync` the directory exists either way, so a
    // consumer asking later can never be told the difference.
    assert.equal(harness.ledgerRootPreexisted, true);
    harness.restore();

    // Emptiness is not ownership. A `.tessera/` that was already there is
    // someone else's — a swept run directory, a root a user made deliberately —
    // and a staging that merely passed through it has no claim to delete it.
    assert.equal(existsSync(root), true);
  });
});

// ── the DEV-15 write journal's anchor ───────────────────────────────────────
//
// The property: the audit trail lands in ONE place, and that place is the
// project — not the directory `tess` was invoked from.
//
// The transport is vendored (ADR-002) and defaults `SN_DOCS_DIR` to
// `path.resolve(process.cwd(), "docs/instance")`, so before this staging existed
// two runs of the same project from two directories produced two journals,
// neither naming the other, with no error and no warning: `appendWriteJournal`
// swallows every failure into `logger.warn`. That is not a partial audit trail,
// it is one that cannot be read, because no reader can know the other half
// exists. It has already happened in this repository.
//
// So these tests move the process's REAL cwd, not just the injected one: the
// default under repair reads `process.cwd()` and nothing else, and a test that
// varied only the argument would pass with the defect still in place. Each case
// then performs a REAL write through the vendored transport against the QA-18
// fake, because the journal is written by the transport, deep under
// `snRequest` — asserting on the staged env var instead would assert our own
// arithmetic rather than where the bytes landed.
describe("stage — where the DEV-15 write journal lands", () => {
  const HOST = "dev-stage.service-now.com";
  const PROPERTY = "1111111111111111111111111111aaaa";
  const JOURNAL = "write-journal.jsonl";
  const PROFILE = "default";

  /** Everything the vendored transport reads, cleared and restored per test. */
  const ENV_KEYS = [
    "SN_INSTANCE",
    "SN_USER",
    "SN_PASSWORD",
    "SN_AUTH",
    "SN_DOCS_DIR",
    "SN_ACTIVE_PROFILE",
    "SN_READONLY",
    "SN_MAX_RETRIES",
    "SN_ALLOWED_HOSTS",
    "SN_HOST_POLICY",
    "SN_TABLES_ALLOW",
    "SN_TABLES_DENY",
  ];

  /**
   * Credentials the fake ignores but the transport insists on — and, crucially,
   * NO `SN_DOCS_DIR`: an ambient one would stage the answer these tests are
   * asking for.
   */
  function transportEnv(t) {
    const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.SN_AUTH = "basic";
    process.env.SN_USER = "tessera";
    process.env.SN_PASSWORD = "tessera";
    // A retry would turn a single-fire fault into a hang.
    process.env.SN_MAX_RETRIES = "0";
    reloadCredentialsFromEnv();
    t.after(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    });
  }

  /** Every write journal anywhere under `root`, as paths relative to it. */
  async function journalsUnder(root) {
    const found = [];
    const walk = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name === JOURNAL) found.push(path.relative(root, full));
      }
    };
    await walk(root);
    return found.sort();
  }

  /**
   * Stage from `cwd` — with the process's real cwd moved there as well —
   * perform one real write through the vendored transport, and restore
   * everything, in the order a `finally` would.
   */
  async function writeFrom(cwd, options = {}) {
    const fake = createFakeInstance({
      host: HOST,
      state: {
        sys_properties: [
          { sys_id: PROPERTY, name: "sn_atf.runner.enabled", value: "false" },
        ],
      },
    });
    const realFetch = globalThis.fetch;
    const realCwd = process.cwd();
    globalThis.fetch = (input, init) => fake.fetch(input, init);
    process.chdir(cwd);
    const harness = await stage(
      {
        instanceHost: HOST,
        fake: false,
        variant: "correct",
        fakeProductionProperty: false,
        keepLedger: false,
        ...options,
      },
      cwd,
    );
    try {
      await tableApi.updateRecord("sys_properties", PROPERTY, {
        value: "true",
      });
    } finally {
      harness.restore();
      process.chdir(realCwd);
      globalThis.fetch = realFetch;
    }
    return harness;
  }

  it("writes one journal for two runs of the same project from two directories", async (t) => {
    transportEnv(t);
    // realpath: on macOS the temp root is a symlink, and `process.chdir` reports
    // the resolved path — comparing the two would fail for the wrong reason.
    const root = await fs.realpath(await tempCwd());
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "tessera.config.json"), "{}\n");
    const nested = path.join(root, "packages", "foo");
    await fs.mkdir(nested, { recursive: true });

    await writeFrom(root);
    await writeFrom(nested);

    // The whole property in one assertion: ONE journal in the entire tree.
    // Before the anchor there were two — `<root>/docs/instance/...` and
    // `<root>/packages/foo/docs/instance/...` — and this is deliberately a
    // whole-tree search rather than a lookup at the expected path, so the
    // second journal cannot hide from it.
    assert.deepEqual(await journalsUnder(root), [
      path.join("sn-docs", PROFILE, JOURNAL),
    ]);

    const entries = (
      await fs.readFile(path.join(root, "sn-docs", PROFILE, JOURNAL), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    // Both writes are IN that one journal — an audit trail that dropped the
    // second run would also satisfy the count above.
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => [entry.action, entry.table, entry.sys_id]),
      [
        ["update", "sys_properties", PROPERTY],
        ["update", "sys_properties", PROPERTY],
      ],
    );
  });

  it("falls back to the ledger root when the project has no config file", async (t) => {
    transportEnv(t);
    const cwd = await fs.realpath(await tempCwd());
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));

    await writeFrom(cwd);

    // No `tessera.config.json` anywhere above a temp directory, so the anchor
    // is the ledger root — still a fixed place, still not `docs/instance` in
    // the caller's source tree.
    assert.deepEqual(await journalsUnder(cwd), [
      path.join(LEDGER_DIR, "sn-docs", PROFILE, JOURNAL),
    ]);
  });

  it("still lets --docs-dir name the directory outright", async (t) => {
    transportEnv(t);
    const root = await fs.realpath(await tempCwd());
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "tessera.config.json"), "{}\n");
    const chosen = path.join(root, "elsewhere");

    await writeFrom(root, { docsDir: chosen });

    // The anchor is a default, not a policy: an operator who names a directory
    // gets that directory, config file or not.
    assert.deepEqual(await journalsUnder(root), [
      path.join("elsewhere", PROFILE, JOURNAL),
    ]);
  });
});

// `stageDocsDir()` on its own — the half `tess preflight` needs and `stage()`
// does not lend it. Preflight has no ledger root, so it cannot call `stage()`
// to get a journal home; until this function existed it staged nothing, and
// `--docs-dir` was a flag the command parsed, validated, echoed back with its
// provenance and never read.
//
// Note what made that invisible for so long: every preflight test sets
// `SN_DOCS_DIR` in its own harness, so the suite supplied the exact fact the
// code failed to supply. A test that stages the environment under test cannot
// observe the code failing to stage it.
describe("stageDocsDir — the journal's home without a ledger", () => {
  const withoutDocsDir = (body) => {
    const saved = process.env.SN_DOCS_DIR;
    delete process.env.SN_DOCS_DIR;
    try {
      body();
    } finally {
      if (saved === undefined) delete process.env.SN_DOCS_DIR;
      else process.env.SN_DOCS_DIR = saved;
    }
  };

  it("resolves a relative --docs-dir against the caller's cwd, not process.cwd()", () => {
    withoutDocsDir(() => {
      const caller = path.join(os.tmpdir(), "tessera-caller-cwd");
      const restore = stageDocsDir({ cwd: caller, docsDir: "audit" });
      // Both halves matter. The first says it used the caller's directory; the
      // second says it did not fall through to the vendored `getDocsDir()`,
      // which resolves against `process.cwd()` — and under MCP `process.cwd()`
      // is the host's directory, not the caller's.
      assert.equal(process.env.SN_DOCS_DIR, path.join(caller, "audit"));
      assert.notEqual(
        process.env.SN_DOCS_DIR,
        path.resolve(process.cwd(), "audit"),
      );
      restore();
    });
  });

  it("restores an absent SN_DOCS_DIR to absent, never to an empty string", () => {
    withoutDocsDir(() => {
      const restore = stageDocsDir({ cwd: os.tmpdir(), docsDir: "audit" });
      restore();
      // `""` is not a restoration: the vendored `getDocsDir()` treats a blank
      // value as unset and falls to its own cwd-relative default, so the next
      // reader in this process would silently get the second journal this
      // function exists to prevent.
      assert.equal("SN_DOCS_DIR" in process.env, false);
    });
  });

  it("restores a previously staged value verbatim", () => {
    const saved = process.env.SN_DOCS_DIR;
    process.env.SN_DOCS_DIR = path.join(os.tmpdir(), "already-here");
    const restore = stageDocsDir({ cwd: os.tmpdir(), docsDir: "audit" });
    restore();
    assert.equal(
      process.env.SN_DOCS_DIR,
      path.join(os.tmpdir(), "already-here"),
    );
    if (saved === undefined) delete process.env.SN_DOCS_DIR;
    else process.env.SN_DOCS_DIR = saved;
  });

  it("treats a blank --docs-dir as absent and falls back", async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-blank-"));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    withoutDocsDir(() => {
      // A blank flag value is the shape an empty line in an env template or a
      // `--docs-dir ""` produces. Honouring it would name the process's own
      // directory as the audit directory.
      const restore = stageDocsDir({ cwd, docsDir: "   " });
      assert.equal(
        process.env.SN_DOCS_DIR,
        path.join(cwd, LEDGER_DIR, "sn-docs"),
      );
      restore();
    });
  });

  it("answers the same directory stage() would when nothing is configured", async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-anchor-"));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    withoutDocsDir(() => {
      const restore = stageDocsDir({ cwd });
      assert.equal(
        process.env.SN_DOCS_DIR,
        path.join(cwd, LEDGER_DIR, "sn-docs"),
      );
      restore();
    });
    // And it put nothing on disk doing it: a command with no ledger must not
    // acquire a `.tessera/` just to learn where its journal would go.
    assert.equal(existsSync(path.join(cwd, LEDGER_DIR)), false);
  });
});
