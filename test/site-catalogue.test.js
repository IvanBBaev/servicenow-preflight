import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultChecks, describeChecks } from "../build/index.js";
import { renderSiteCatalogue, toSiteEntries } from "../scripts/gen-site.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "gen-site.mjs");
const KEYS = ["code", "name", "tag", "desc", "fail", "warn", "pass"];

/** Evaluate generated catalogue source the way the browser would. */
function load(source) {
  const window = {};
  new Function("window", source)(window);
  return window.PREFLIGHT_CHECKS;
}

const FAKE = [
  {
    name: "alpha",
    description: "Alpha description.",
    meta: {
      requires: "ALWAYS",
      summary: "Alpha summary.",
      verdicts: { pass: "A pass.", warn: "A warn.", fail: "A fail." },
    },
    inDefaultSuite: true,
  },
  {
    name: "beta",
    description: "Beta description.",
    meta: {},
    inDefaultSuite: false,
  },
];

test("a two-check list renders deterministic, valid browser JS", () => {
  const first = renderSiteCatalogue(FAKE);
  assert.equal(renderSiteCatalogue(FAKE), first);
  assert.deepEqual(load(first), [
    {
      code: "01",
      name: "alpha",
      tag: "ALWAYS",
      desc: "Alpha summary.",
      fail: "A fail.",
      warn: "A warn.",
      pass: "A pass.",
    },
    {
      code: "02",
      name: "beta",
      tag: "",
      desc: "Beta description.",
      fail: "",
      warn: "",
      pass: "",
    },
  ]);
});

test("every default check yields a complete site entry", () => {
  const entries = toSiteEntries(describeChecks(defaultChecks));
  assert.equal(entries.length, defaultChecks.length);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry), KEYS, entry.name);
    for (const key of KEYS) {
      assert.ok(entry[key].length > 0, `${entry.name} has an empty ${key}`);
    }
  }
});

test("the committed site/checks.generated.js matches the registry", () => {
  const committed = readFileSync(join(ROOT, "site", "checks.generated.js"), {
    encoding: "utf8",
  });
  assert.equal(committed, renderSiteCatalogue(describeChecks(defaultChecks)));
});

test("--check passes on a fresh file and detects drift on a stale copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-gen-site-"));
  try {
    const out = join(dir, "checks.generated.js");
    const run = (...args) =>
      spawnSync(process.execPath, [SCRIPT, "--out", out, ...args], {
        encoding: "utf8",
      });

    const missing = run("--check");
    assert.equal(missing.status, 1, missing.stderr);

    const write = run();
    assert.equal(write.status, 0, write.stderr);
    assert.equal(load(readFileSync(out, "utf8")).length, defaultChecks.length);
    assert.equal(run("--check").status, 0);

    writeFileSync(out, readFileSync(out, "utf8").replace('"01"', '"99"'));
    const stale = run("--check");
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /out of date/);
    assert.match(stale.stderr, /npm run gen:site/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--out without a path is a usage error", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--out"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--out needs a path/);
});
