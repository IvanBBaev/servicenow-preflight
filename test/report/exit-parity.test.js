// RR-70: the reporters tell the same verdict as the exit code.
//   REL-2 / CLI-13 — `--fail-on warn` exits 1, so JUnit, SARIF and `github`
//                    must render the gating warn as a failure;
//   REL-3          — an unknown status counts as a failure in the summary, so
//                    it must not render as a passing testcase / level-less result;
//   REL-4          — SARIF carries one result per finding, each with a stable
//                    fingerprint and a logical location;
//   REL-8          — a row without a message renders instead of throwing;
//   REL-9          — Markdown neutralises link/image/emphasis/mention markup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatGitHubAnnotations,
  formatGitHubAnnotationsAll,
  formatJUnit,
  formatJUnitSuites,
  formatMarkdown,
  formatSarif,
} from "../../build/api/report.js";

const BIN = fileURLToPath(
  new URL("../../bin/servicenow-preflight.cjs", import.meta.url),
);

function report(results, ok) {
  const summary = { pass: 0, warn: 0, fail: 0, error: 0 };
  for (const r of results) {
    const key = r.status in summary ? r.status : "fail";
    summary[key] += 1;
  }
  return { ok: ok ?? summary.fail === 0, results, summary };
}

const WARN_ONLY = report(
  [
    { name: "a", status: "pass", message: "fine" },
    { name: "b", status: "warn", message: "soft problem" },
  ],
  false, // what applyFailOn leaves under --fail-on warn
);

const failuresAttr = (xml) =>
  [...xml.matchAll(/failures="(\d+)"/g)].map((m) => Number(m[1]));

test("REL-2/CLI-13: --fail-on warn renders a gating warn as a JUnit failure", () => {
  const xml = formatJUnit(WARN_ONLY, { failOn: "warn" });
  assert.deepEqual(failuresAttr(xml), [1, 1]);
  assert.match(xml, /<testcase [^>]*name="b"[^>]*>\s*<failure /);
  // Without the option the warn stays a note (the default threshold).
  const plain = formatJUnit(WARN_ONLY);
  assert.deepEqual(failuresAttr(plain), [0, 0]);
  assert.doesNotMatch(plain, /<failure /);
});

test("REL-2: --fail-on warn renders a gating warn as SARIF error and ::error", () => {
  const sarif = JSON.parse(
    formatSarif(WARN_ONLY, undefined, { failOn: "warn" }),
  );
  assert.deepEqual(
    sarif.runs[0].results.map((r) => r.level),
    ["error"],
  );
  const gh = formatGitHubAnnotations(WARN_ONLY, undefined, { failOn: "warn" });
  assert.match(gh, /^::error title=b::soft problem$/m);
  assert.doesNotMatch(gh, /::warning/);
  assert.match(gh, /failing: --fail-on warn/);
});

test("REL-2: a baselined warn never gates, so it stays a warning", () => {
  const r = report(
    [{ name: "b", status: "warn", message: "known", kind: "baseline" }],
    true,
  );
  assert.deepEqual(failuresAttr(formatJUnit(r, { failOn: "warn" })), [0, 0]);
  const sarif = JSON.parse(formatSarif(r, undefined, { failOn: "warn" }));
  assert.equal(sarif.runs[0].results[0].level, "warning");
  assert.match(
    formatGitHubAnnotations(r, undefined, { failOn: "warn" }),
    /::warning/,
  );
});

test("REL-2: multi-instance reporters honour each instance's own failOn", () => {
  const named = [
    { name: "dev", report: WARN_ONLY, failOn: "warn" },
    { name: "test", report: { ...WARN_ONLY, ok: true }, failOn: "fail" },
  ];
  assert.deepEqual(failuresAttr(formatJUnitSuites(named)), [1, 1, 0]);
  const gh = formatGitHubAnnotationsAll(named);
  assert.match(gh, /^::error title=b \(dev\)::/m);
  assert.match(gh, /^::warning title=b \(test\)::/m);
});

test("REL-3: an unknown status renders as a failure, not a pass", () => {
  const r = report([{ name: "odd", status: "skipped", message: "?" }]);
  assert.equal(r.ok, false);
  const xml = formatJUnit(r);
  assert.deepEqual(failuresAttr(xml), [1, 1]);
  assert.match(xml, /<failure /);
  const sarif = JSON.parse(formatSarif(r));
  assert.equal(sarif.runs[0].results.length, 1);
  assert.equal(sarif.runs[0].results[0].level, "error");
  assert.match(formatGitHubAnnotations(r), /^::error title=odd::/m);
});

test("REL-8: a row without a message renders in every format", () => {
  const r = report([{ name: "quiet", status: "fail" }]);
  assert.match(formatJUnit(r), /<failure message=""[ >]/);
  const sarif = JSON.parse(formatSarif(r));
  assert.equal(sarif.runs[0].results[0].message.text, "");
  assert.match(formatGitHubAnnotations(r), /^::error title=quiet::$/m);
  assert.match(formatMarkdown(r), /`quiet`/);
});

const loc = (sysId, field) => ({
  table: "sys_script",
  sysId,
  recordName: `BR ${sysId}`,
  field,
});

test("REL-4: SARIF emits one result per finding with a fingerprint", () => {
  const r = report([
    {
      name: "script-scan",
      status: "fail",
      message: "2 risky scripts",
      findings: [
        {
          id: "f1:aaaaaaaaaaaaaaaa",
          kind: "eval",
          message: "eval in BR 1",
          location: loc("s1", "script"),
        },
        {
          id: "f1:bbbbbbbbbbbbbbbb",
          kind: "eval",
          message: "eval in BR 2",
          location: loc("s2", "script"),
        },
      ],
    },
  ]);
  const { results } = JSON.parse(formatSarif(r)).runs[0];
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((x) => x.partialFingerprints["findingId/v1"]),
    ["f1:aaaaaaaaaaaaaaaa", "f1:bbbbbbbbbbbbbbbb"],
  );
  assert.deepEqual(
    results.map((x) => x.message.text),
    ["eval in BR 1", "eval in BR 2"],
  );
  assert.ok(
    results.every((x) => x.ruleId === "script-scan" && x.level === "error"),
  );
  assert.deepEqual(
    results.map((x) => x.locations[0].logicalLocations[0].fullyQualifiedName),
    ["sys_script/s1.script", "sys_script/s2.script"],
  );
});

test("REL-4: a pass finding is dropped and a truncated tail keeps a row result", () => {
  const r = report([
    {
      name: "script-scan",
      status: "warn",
      message: "many",
      findings: [
        {
          id: "f1:cccccccccccccccc",
          kind: "eval",
          message: "one",
          status: "warn",
          location: loc("s3"),
        },
        {
          id: "f1:dddddddddddddddd",
          kind: "eval",
          message: "ok",
          status: "pass",
          location: loc("s4"),
        },
      ],
      findingsTruncated: 5,
    },
  ]);
  const { results } = JSON.parse(formatSarif(r)).runs[0];
  assert.deepEqual(
    results.map((x) => x.message.text),
    ["one", "many (5 more finding(s) not listed)"],
  );
  assert.ok(results.every((x) => x.level === "warning"));
});

test("REL-9: Markdown neutralises link, image, emphasis and mention markup", () => {
  const r = report([
    {
      name: "x_check",
      status: "fail",
      message:
        "![img](http://e.x/a.png) [link](http://e.x) **bold** _it_ @team <b>",
    },
  ]);
  const md = formatMarkdown(r);
  const row = md.split("\n").find((l) => l.includes("x_check"));
  assert.ok(row, md);
  assert.ok(!row.includes("](http"), row);
  assert.ok(!row.includes("**bold**"), row);
  assert.ok(!/(^|[^\\])_it/.test(row), row);
  assert.ok(!row.includes("@team"), row);
  assert.ok(!row.includes("<b>"), row);
  // The check name sits in a code span, where escapes would show literally.
  assert.ok(row.includes("`x_check`"), row);
});

async function startWarnInstance() {
  // On an http loopback URL `instance-url-configured` warns; nothing else runs.
  const server = createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "x-total-count": "0",
    });
    res.end(JSON.stringify({ result: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}

function runCli(args, cwd) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SNPF_") || key === "GITHUB_ACTIONS") delete env[key];
  }
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...env, SNPF_USER: "u", SNPF_PASS: "p" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("CLI-13: `run --fail-on warn` writes failing JUnit/SARIF/github output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-rr70-"));
  const instance = await startWarnInstance();
  try {
    const base = [
      "run",
      "--instance",
      instance.url,
      "--only",
      "instance-url-configured",
      "--fail-on",
      "warn",
      "--format",
    ];
    const junit = await runCli([...base, "junit"], dir);
    assert.equal(junit.status, 1, junit.stderr);
    assert.ok(
      failuresAttr(junit.stdout).every((n) => n === 1),
      junit.stdout,
    );

    const sarif = await runCli([...base, "sarif"], dir);
    assert.equal(sarif.status, 1, sarif.stderr);
    const log = JSON.parse(sarif.stdout);
    assert.deepEqual(
      log.runs[0].results.map((r) => r.level),
      ["error"],
    );

    const gh = await runCli([...base, "github"], dir);
    assert.equal(gh.status, 1, gh.stderr);
    assert.match(gh.stdout, /^::error title=instance-url-configured::/m);
  } finally {
    instance.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
