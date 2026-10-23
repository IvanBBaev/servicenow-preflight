import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyBaseline,
  baselineFromReport,
  baselinePath,
  readBaseline,
  writeBaseline,
  BASELINE_ROW,
} from "../build/index.js";
import { UsageError } from "../build/config.js";
import { reportOf } from "./helpers/json-report.js";

const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);

function runCli(args, { cwd } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SNPF_")) delete env[key];
  }
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? tmpdir(),
    env,
    encoding: "utf8",
  });
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "snpf-baseline-"));
}

const NOW = new Date("2026-10-22T12:00:00Z");

function report(results) {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const r of results) summary[r.status] += 1;
  return { ok: summary.fail === 0, results, summary };
}

const ACL_MSG = "2 custom table(s) lack CRUD ACLs: x_a, x_b";

function baseline(entries) {
  return { version: 1, generatedAt: "2026-10-01T00:00:00Z", entries };
}

test("applyBaseline demotes a matched fail to warn with the prefix", () => {
  const r = report([
    { name: "table-crud-acl", status: "fail", message: ACL_MSG },
    { name: "connectivity-auth", status: "pass", message: "ok" },
  ]);
  const out = applyBaseline(
    r,
    baseline([
      {
        check: "table-crud-acl",
        status: "fail",
        message: ACL_MSG,
        reason: "legacy tables, ACME-123",
        expires: "2027-01-31",
      },
    ]),
    NOW,
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.summary, { pass: 1, warn: 1, fail: 0 });
  assert.equal(out.results[0].status, "warn");
  assert.equal(
    out.results[0].message,
    `Baselined (legacy tables, ACME-123 until 2027-01-31): ${ACL_MSG}`,
  );
  assert.equal(out.results[1].message, "ok");
  // Pure: the input report is untouched.
  assert.equal(r.results[0].status, "fail");
  assert.equal(r.ok, false);
});

test("applyBaseline uses accepted/revoked defaults and keeps a warn a warn", () => {
  const out = applyBaseline(
    report([{ name: "portal-roles", status: "warn", message: "w" }]),
    baseline([
      { check: "portal-roles", status: "warn", message: "w", reason: "" },
    ]),
    NOW,
  );
  assert.equal(out.results[0].status, "warn");
  assert.equal(out.results[0].message, "Baselined (accepted until revoked): w");
});

test("applyBaseline flags a changed message but still demotes", () => {
  const out = applyBaseline(
    report([
      { name: "table-crud-acl", status: "fail", message: "3 tables: x_c" },
    ]),
    baseline([{ check: "table-crud-acl", status: "fail", message: ACL_MSG }]),
    NOW,
  );
  assert.equal(out.ok, true);
  assert.equal(out.results[0].status, "warn");
  assert.equal(
    out.results[0].message,
    "Baselined but CHANGED since 2026-10-01T00:00:00Z: 3 tables: x_c",
  );
});

test("applyBaseline ignores an expired entry and appends a baseline warn row", () => {
  const out = applyBaseline(
    report([{ name: "table-crud-acl", status: "fail", message: ACL_MSG }]),
    baseline([
      {
        check: "table-crud-acl",
        status: "fail",
        message: ACL_MSG,
        expires: "2026-10-21",
      },
    ]),
    NOW,
  );
  assert.equal(out.ok, false);
  assert.deepEqual(out.summary, { pass: 0, warn: 1, fail: 1 });
  assert.equal(out.results[0].status, "fail");
  assert.equal(out.results[0].message, ACL_MSG);
  assert.deepEqual(out.results[1], {
    name: BASELINE_ROW,
    status: "warn",
    kind: "baseline",
    message:
      "Baseline entry for table-crud-acl expired on 2026-10-21; the finding fails again next run if still present.",
  });
});

test("a date-only expires is valid through the end of that day", () => {
  const entry = {
    check: "x",
    status: "fail",
    message: "m",
    expires: "2026-10-22",
  };
  const r = report([{ name: "x", status: "fail", message: "m" }]);
  assert.equal(applyBaseline(r, baseline([entry]), NOW).ok, true);
  const nextDay = new Date("2026-10-23T00:00:00Z");
  assert.equal(applyBaseline(r, baseline([entry]), nextDay).ok, false);
  // A full timestamp expires at that instant.
  const ts = { ...entry, expires: "2026-10-22T11:00:00Z" };
  assert.equal(applyBaseline(r, baseline([ts]), NOW).ok, false);
});

test("applyBaseline ignores unmatched entries and status mismatches", () => {
  const r = report([{ name: "a", status: "fail", message: "m" }]);
  const out = applyBaseline(
    r,
    baseline([
      { check: "skipped-check", status: "fail", message: "m" },
      { check: "a", status: "warn", message: "m" },
    ]),
    NOW,
  );
  assert.equal(out.ok, false);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].message, "m");
});

test("baselineFromReport records non-pass rows only", () => {
  const b = baselineFromReport(
    report([
      { name: "a", status: "pass", message: "fine" },
      { name: "b", status: "warn", message: "meh" },
      { name: "c", status: "fail", message: "bad" },
    ]),
    "dev",
    NOW,
  );
  assert.deepEqual(b, {
    version: 1,
    generatedAt: NOW.toISOString(),
    instance: "dev",
    entries: [
      { check: "b", status: "warn", message: "meh", reason: "" },
      { check: "c", status: "fail", message: "bad", reason: "" },
    ],
  });
  const single = baselineFromReport(report([]), undefined, NOW);
  assert.equal("instance" in single, false);
  assert.deepEqual(single.entries, []);
});

test("baselinePath picks the shared or per-instance file", () => {
  assert.equal(
    baselinePath("/repo"),
    join("/repo", ".preflight", "baseline.json"),
  );
  assert.equal(
    baselinePath("/repo", "dev"),
    join("/repo", ".preflight", "baseline.dev.json"),
  );
});

test("writeBaseline round-trips and refuses to overwrite without force", () => {
  const dir = tempDir();
  try {
    const path = join(dir, ".preflight", "baseline.json");
    const b = {
      version: 1,
      generatedAt: "2026-10-22T00:00:00Z",
      instance: "dev",
      entries: [
        {
          check: "a",
          status: "fail",
          message: "m",
          reason: "r",
          expires: "2027-01-31",
        },
      ],
    };
    writeBaseline(path, b);
    assert.deepEqual(readBaseline(path), b);
    assert.throws(
      () => writeBaseline(path, b, {}),
      (err) => err instanceof UsageError && /--force/.test(err.message),
    );
    writeBaseline(path, { ...b, entries: [] }, { force: true });
    assert.deepEqual(readBaseline(path).entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBaseline rejects each malformed shape with UsageError", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "b.json");
    const entry = { check: "a", status: "fail", message: "m" };
    const cases = [
      ["not json", /not valid JSON/],
      [[], /must be a JSON object/],
      [{ version: 2, generatedAt: "x", entries: [] }, /"version": 1/],
      [{ version: 1, entries: [] }, /generatedAt/],
      [{ version: 1, generatedAt: "x", instance: 5, entries: [] }, /instance/],
      [{ version: 1, generatedAt: "x", entries: {} }, /"entries" array/],
      [{ version: 1, generatedAt: "x", entries: [null] }, /entries\[0\]/],
      [baseline([entry, { ...entry, check: "" }]), /entries\[1\].*check/],
      [baseline([{ ...entry, status: "pass" }]), /entries\[0\].*status/],
      [baseline([{ ...entry, message: 1 }]), /entries\[0\].*message/],
      [baseline([{ ...entry, reason: 1 }]), /entries\[0\].*reason/],
      [baseline([{ ...entry, expires: "soon" }]), /entries\[0\].*expires/],
      [baseline([{ ...entry, expires: 20270131 }]), /entries\[0\].*expires/],
      [baseline([{ ...entry, expires: "2027-13-45" }]), /expires/],
    ];
    for (const [content, pattern] of cases) {
      writeFileSync(
        path,
        typeof content === "string" ? content : JSON.stringify(content),
      );
      assert.throws(
        () => readBaseline(path),
        (err) => err instanceof UsageError && pattern.test(err.message),
        `expected ${pattern} for ${JSON.stringify(content)}`,
      );
    }
    assert.throws(
      () => readBaseline(join(dir, "missing.json")),
      (err) => err instanceof UsageError && /not found/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI ---------------------------------------------------------------------

test("CLI: --baseline with a missing file exits 2 naming the path", () => {
  const dir = tempDir();
  try {
    const res = runCli(["run", "--baseline", "missing.json"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /missing\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --baseline together with --write-baseline exits 2", () => {
  const res = runCli(["run", "--baseline", "--write-baseline"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /choose one/);
});

test("CLI: --help lists the baseline flags", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0);
  for (const flag of ["--baseline", "--write-baseline", "--force"]) {
    assert.ok(res.stdout.includes(flag), flag);
  }
});

test("CLI: --write-baseline then --baseline turns a known fail into a pass", () => {
  const dir = tempDir();
  try {
    // instance-url-configured fails offline when no instance is given.
    const only = ["--only", "instance-url-configured"];
    const first = runCli(["run", ...only, "--write-baseline"], { cwd: dir });
    assert.equal(first.status, 1, first.stderr);
    assert.match(first.stderr, /Wrote baseline with 1 entry/);
    const path = join(dir, ".preflight", "baseline.json");
    assert.equal(
      readBaseline(path).entries[0].check,
      "instance-url-configured",
    );

    const again = runCli(["run", ...only, "--write-baseline"], { cwd: dir });
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already exists/);
    const forced = runCli(["run", ...only, "--write-baseline", "--force"], {
      cwd: dir,
    });
    assert.equal(forced.status, 1);

    const applied = runCli(["run", ...only, "--baseline", "--json"], {
      cwd: dir,
    });
    assert.equal(applied.status, 0, applied.stderr);
    const out = reportOf(applied.stdout);
    assert.equal(out.ok, true);
    assert.match(
      out.results[0].message,
      /^Baselined \(accepted until revoked\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: config baseline key enables the file; flag path wins; bad type exits 2", () => {
  const dir = tempDir();
  try {
    const only = ["--only", "instance-url-configured"];
    mkdirSync(join(dir, "alt"));
    const alt = join(dir, "alt", "accepted.json");
    assert.equal(
      runCli(["run", ...only, "--write-baseline=alt/accepted.json"], {
        cwd: dir,
      }).status,
      1,
    );
    assert.ok(existsSync(alt));

    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({ baseline: "alt/accepted.json" }),
    );
    assert.equal(runCli(["run", ...only], { cwd: dir }).status, 0);

    // The flag outranks the config key: the default file does not exist.
    const flagWins = runCli(["run", ...only, "--baseline"], { cwd: dir });
    assert.equal(flagWins.status, 2);
    assert.match(flagWins.stderr, /baseline\.json/);

    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({ baseline: 5 }),
    );
    const bad = runCli(["run", ...only], { cwd: dir });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Config baseline must be/);

    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({ baseline: false }),
    );
    assert.equal(runCli(["run", ...only], { cwd: dir }).status, 1);
    assert.match(readFileSync(alt, "utf8"), /instance-url-configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: per-instance baseline file is preferred, with a shared fallback", () => {
  const dir = tempDir();
  try {
    mkdirSync(join(dir, ".preflight"));
    writeFileSync(
      join(dir, ".preflight", "instances.json"),
      JSON.stringify({
        instances: { dev: { url: "https://dev1.service-now.com" } },
      }),
    );
    // Only file resolution is asserted here: each case stops at the baseline
    // usage error before any network call is made.
    const only = ["--only", "instance-url-configured"];
    const shared = runCli(["run", "dev", ...only, "--baseline"], {
      cwd: dir,
    });
    assert.equal(shared.status, 2);
    assert.match(shared.stderr, /baseline\.json/);

    writeFileSync(
      join(dir, ".preflight", "baseline.dev.json"),
      JSON.stringify({ version: 1, generatedAt: "x", entries: "bad" }),
    );
    const own = runCli(["run", "dev", ...only, "--baseline"], { cwd: dir });
    assert.equal(own.status, 2);
    assert.match(own.stderr, /baseline\.dev\.json/);

    const wrote = runCli(["run", "dev", ...only, "--write-baseline"], {
      cwd: dir,
    });
    assert.equal(wrote.status, 2);
    assert.match(wrote.stderr, /baseline\.dev\.json already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: baseline flags are refused outside run and with --all + a path", () => {
  const drift = runCli(["drift", "dev", "prod", "--baseline"]);
  assert.equal(drift.status, 2);
  assert.match(drift.stderr, /run only/);
  const all = runCli(["run", "--all", "--write-baseline", "x.json"]);
  assert.equal(all.status, 2);
  assert.match(all.stderr, /--all/);
  const empty = runCli(["run", "--baseline="]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /needs a path/);
});
