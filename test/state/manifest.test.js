import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  STATE_DIR,
  manifestPath,
  slugify,
  logicalId,
  emptyManifest,
  loadManifest,
  writeManifest,
  mergeManifest,
} from "../../build/state/manifest.js";
import { PREFLIGHT_DIR } from "../../build/registry.js";

/** Make a fresh temp dir; caller removes it. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), "snpf-manifest-"));
}

// --- STATE_DIR -------------------------------------------------------------

test("STATE_DIR is the `state` sub-directory name", () => {
  assert.equal(STATE_DIR, "state");
});

// --- slugify ---------------------------------------------------------------

test("slugify lowercases and replaces spaces with hyphens", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("slugify collapses runs of punctuation into a single hyphen", () => {
  assert.equal(slugify("foo & bar -- baz"), "foo-bar-baz");
});

test("slugify strips leading and trailing separators and trims", () => {
  assert.equal(slugify("  --Foo Bar--  "), "foo-bar");
});

test("slugify keeps digits and drops other non-word characters", () => {
  assert.equal(slugify("Test #42: Login!"), "test-42-login");
});

test("slugify passes an already-slugified value through unchanged", () => {
  assert.equal(slugify("already-slug"), "already-slug");
});

test("slugify returns an empty string for empty or punctuation-only input", () => {
  assert.equal(slugify(""), "");
  assert.equal(slugify("   "), "");
  assert.equal(slugify("---"), "");
  assert.equal(slugify("***"), "");
});

test("slugify collapses non-ascii-word characters to hyphens", () => {
  // Only [a-z0-9] survive; accented/unicode letters collapse to a single hyphen.
  assert.equal(slugify("Café Münchén"), "caf-m-nch-n");
});

// --- logicalId -------------------------------------------------------------

test("logicalId prefixes the slug with the scope", () => {
  assert.equal(logicalId("x_acme_app", "My Test"), "x_acme_app/my-test");
});

test("logicalId omits the scope segment when scope is undefined", () => {
  assert.equal(logicalId(undefined, "My Test"), "my-test");
});

test("logicalId falls back to `unnamed` when the name yields no slug", () => {
  assert.equal(logicalId("x_acme_app", "***"), "x_acme_app/unnamed");
  assert.equal(logicalId(undefined, ""), "unnamed");
});

// --- emptyManifest ---------------------------------------------------------

test("emptyManifest returns an instance-only manifest with empty collections", () => {
  const m = emptyManifest("dev");
  assert.equal(m.instance, "dev");
  assert.equal(m.url, undefined);
  assert.equal(m.scope, undefined);
  assert.deepEqual(m.tests, []);
  assert.deepEqual(m.suites, []);
});

test("emptyManifest carries the optional url and scope", () => {
  const m = emptyManifest("dev", "https://dev.service-now.com", "x_acme_app");
  assert.deepEqual(m, {
    instance: "dev",
    url: "https://dev.service-now.com",
    scope: "x_acme_app",
    tests: [],
    suites: [],
  });
});

// --- manifestPath ----------------------------------------------------------

test("manifestPath composes under .preflight/state with a .state.json suffix", () => {
  const p = manifestPath("dev", "/work/repo");
  assert.equal(
    p,
    resolve("/work/repo", PREFLIGHT_DIR, STATE_DIR, "dev.state.json"),
  );
  assert.ok(isAbsolute(p));
  assert.ok(p.endsWith(join(PREFLIGHT_DIR, STATE_DIR, "dev.state.json")));
});

test("manifestPath defaults the cwd to process.cwd()", () => {
  const p = manifestPath("prod");
  assert.equal(
    p,
    resolve(process.cwd(), PREFLIGHT_DIR, STATE_DIR, "prod.state.json"),
  );
});

test("manifestPath resolves a relative cwd against process.cwd()", () => {
  const p = manifestPath("dev", "sub/dir");
  assert.equal(
    p,
    resolve(
      process.cwd(),
      "sub/dir",
      PREFLIGHT_DIR,
      STATE_DIR,
      "dev.state.json",
    ),
  );
});

test("manifestPath rejects an instance name with a path separator (CC-14)", () => {
  // The name becomes the `<name>.state.json` path segment; a separator would
  // escape the state directory. Old code interpolated it blindly.
  assert.throws(
    () => manifestPath("../etc/passwd", "/work/repo"),
    /path separators or ".."/,
  );
  assert.throws(() => manifestPath("a/b", "/work/repo"), /path separators/);
});

test("manifestPath rejects an instance name with surrounding whitespace (CC-14)", () => {
  assert.throws(
    () => manifestPath(" dev ", "/work/repo"),
    /leading or trailing whitespace/,
  );
});

// --- loadManifest ----------------------------------------------------------

test("loadManifest returns undefined when the manifest has never been synced", async () => {
  const dir = tempDir();
  try {
    assert.equal(await loadManifest("dev", dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest round-trips a manifest written by writeManifest", async () => {
  const dir = tempDir();
  try {
    const manifest = {
      instance: "dev",
      url: "https://dev.service-now.com",
      scope: "x_acme_app",
      syncedAt: "2026-07-04T00:00:00.000Z",
      tests: [
        {
          id: "x_acme_app/login",
          sysId: "sys-1",
          name: "Login",
          covers: { type: "client_script", name: "LoginCS" },
          active: true,
          lastRun: {
            at: "2026-07-03T10:00:00.000Z",
            status: "pass",
            resultId: "r1",
          },
        },
      ],
      suites: [
        {
          id: "x_acme_app/smoke",
          sysId: "suite-1",
          name: "Smoke",
          testIds: ["x_acme_app/login"],
        },
      ],
    };
    const path = await writeManifest(manifest, dir);
    assert.ok(path.endsWith("dev.state.json"));
    const loaded = await loadManifest("dev", dir);
    assert.deepEqual(loaded, manifest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest defaults missing tests/suites to empty arrays", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      manifestPathWithMkdir(dir, "dev"),
      JSON.stringify({ instance: "dev" }),
    );
    const loaded = await loadManifest("dev", dir);
    assert.equal(loaded.instance, "dev");
    assert.deepEqual(loaded.tests, []);
    assert.deepEqual(loaded.suites, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest falls back to the requested instance name when the file omits it", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      manifestPathWithMkdir(dir, "dev"),
      JSON.stringify({ tests: [], suites: [] }),
    );
    const loaded = await loadManifest("dev", dir);
    assert.equal(loaded.instance, "dev");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest rejects a manifest whose declared instance differs from the load name (CC-36)", async () => {
  const dir = tempDir();
  try {
    // The file at prod.state.json declares instance "staging" — it was copied or
    // renamed. Trusting it would let staging coverage masquerade as prod's.
    writeFileSync(
      manifestPathWithMkdir(dir, "prod"),
      JSON.stringify({ instance: "staging", tests: [], suites: [] }),
    );
    await assert.rejects(
      () => loadManifest("prod", dir),
      (err) => {
        assert.match(err.message, /declares instance "staging"/);
        assert.match(err.message, /loaded as\s+"prod"/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest rejects a test element missing a non-empty string id (CC-18)", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      manifestPathWithMkdir(dir, "dev"),
      JSON.stringify({
        instance: "dev",
        tests: [{ id: "x/ok", name: "Ok" }, { name: "No id here" }],
        suites: [],
      }),
    );
    await assert.rejects(
      () => loadManifest("dev", dir),
      (err) => {
        // The error must name both the file and the offending index.
        assert.match(
          err.message,
          /tests\[1\] is missing a non-empty string "id"/,
        );
        assert.match(err.message, /dev\.state\.json/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest rejects a suite element with a blank id (CC-18)", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      manifestPathWithMkdir(dir, "dev"),
      JSON.stringify({
        instance: "dev",
        tests: [],
        suites: [{ id: "", name: "Blank id suite", testIds: [] }],
      }),
    );
    await assert.rejects(
      () => loadManifest("dev", dir),
      /suites\[0\] is missing a non-empty string "id"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest coerces non-array tests/suites fields to empty arrays", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      manifestPathWithMkdir(dir, "dev"),
      JSON.stringify({ instance: "dev", tests: "nope", suites: {} }),
    );
    const loaded = await loadManifest("dev", dir);
    assert.deepEqual(loaded.tests, []);
    assert.deepEqual(loaded.suites, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest throws on a present-but-malformed JSON file", async () => {
  const dir = tempDir();
  try {
    writeFileSync(manifestPathWithMkdir(dir, "dev"), "{ not valid json ");
    await assert.rejects(() => loadManifest("dev", dir), /is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest throws when the top-level JSON value is an array", async () => {
  const dir = tempDir();
  try {
    writeFileSync(manifestPathWithMkdir(dir, "dev"), "[1, 2, 3]");
    await assert.rejects(
      () => loadManifest("dev", dir),
      /is not a JSON object/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest throws when the JSON value is null", async () => {
  const dir = tempDir();
  try {
    writeFileSync(manifestPathWithMkdir(dir, "dev"), "null");
    await assert.rejects(
      () => loadManifest("dev", dir),
      /is not a JSON object/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest honours an absolute explicitPath (ignoring cwd)", async () => {
  const dir = tempDir();
  try {
    const abs = join(dir, "elsewhere.json");
    writeFileSync(
      abs,
      JSON.stringify({ instance: "dev", tests: [], suites: [] }),
    );
    const loaded = await loadManifest("dev", "/nonexistent-cwd", abs);
    assert.equal(loaded.instance, "dev");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadManifest resolves a relative explicitPath against cwd", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "custom.json"),
      JSON.stringify({ instance: "dev", tests: [], suites: [] }),
    );
    const loaded = await loadManifest("dev", dir, "custom.json");
    assert.equal(loaded.instance, "dev");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- writeManifest ---------------------------------------------------------

test("writeManifest creates the parent .preflight/state directory and returns the path", async () => {
  const dir = tempDir();
  try {
    const p = await writeManifest(emptyManifest("dev"), dir);
    assert.equal(p, manifestPath("dev", dir));
    assert.ok(existsSync(p));
    assert.ok(existsSync(join(dir, PREFLIGHT_DIR, STATE_DIR)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeManifest writes atomically via a temp-file rename, leaving no .tmp behind (CC-17)", async () => {
  const dir = tempDir();
  try {
    const p = await writeManifest(emptyManifest("dev"), dir);
    const inoFirst = statSync(p).ino;
    // A second write must swap a freshly-renamed sibling into place, so the
    // destination inode CHANGES. The old in-place writeFile truncated and
    // rewrote the SAME inode, so this assertion is red against that behaviour.
    await writeManifest(
      { instance: "dev", tests: [{ id: "x/t", name: "T" }], suites: [] },
      dir,
    );
    const inoSecond = statSync(p).ino;
    assert.notEqual(
      inoSecond,
      inoFirst,
      "atomic rename must replace the file (new inode), not overwrite in place",
    );

    // No orphaned temp file must remain in the state directory after a write.
    const stateDir = join(dir, PREFLIGHT_DIR, STATE_DIR);
    const leftovers = readdirSync(stateDir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], `unexpected temp leftovers: ${leftovers}`);
    // The final content reflects the second write.
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    assert.deepEqual(
      parsed.tests.map((t) => t.id),
      ["x/t"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeManifest emits pretty-printed JSON ending in a trailing newline", async () => {
  const dir = tempDir();
  try {
    const p = await writeManifest(emptyManifest("dev"), dir);
    const text = readFileSync(p, "utf8");
    assert.ok(text.endsWith("}\n"));
    // Two-space indent on nested fields.
    assert.match(text, /\n {2}"instance": "dev"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeManifest sorts tests and suites (and testIds) by id for a stable diff", async () => {
  const dir = tempDir();
  try {
    const manifest = {
      instance: "dev",
      tests: [
        { id: "s/zebra", name: "Zebra" },
        { id: "s/apple", name: "Apple" },
      ],
      suites: [
        { id: "s/beta", name: "Beta", testIds: ["s/zebra", "s/apple"] },
        { id: "s/alpha", name: "Alpha", testIds: [] },
      ],
    };
    const path = await writeManifest(manifest, dir);
    const text = readFileSync(path, "utf8");
    assert.ok(text.indexOf('"s/apple"') < text.indexOf('"s/zebra"'));
    const parsed = JSON.parse(text);
    assert.deepEqual(
      parsed.tests.map((t) => t.id),
      ["s/apple", "s/zebra"],
    );
    assert.deepEqual(
      parsed.suites.map((s) => s.id),
      ["s/alpha", "s/beta"],
    );
    assert.deepEqual(parsed.suites[1].testIds, ["s/apple", "s/zebra"]);
    // `instance` is emitted first.
    assert.equal(Object.keys(parsed)[0], "instance");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeManifest omits absent optional fields from the serialized output", async () => {
  const dir = tempDir();
  try {
    const path = await writeManifest(
      { instance: "dev", tests: [{ id: "s/t", name: "T" }], suites: [] },
      dir,
    );
    const text = readFileSync(path, "utf8");
    for (const field of [
      '"url"',
      '"scope"',
      '"syncedAt"',
      '"sysId"',
      '"covers"',
      '"active"',
      '"lastRun"',
    ]) {
      assert.doesNotMatch(text, new RegExp(field));
    }
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed.tests[0], { id: "s/t", name: "T" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeManifest keeps active:false (only undefined is dropped)", async () => {
  const dir = tempDir();
  try {
    const path = await writeManifest(
      {
        instance: "dev",
        tests: [{ id: "s/t", name: "T", active: false }],
        suites: [],
      },
      dir,
    );
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.tests[0].active, false);
    const loaded = await loadManifest("dev", dir);
    assert.equal(loaded.tests[0].active, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeManifest drops a lastRun.resultId only when it is absent", async () => {
  const dir = tempDir();
  try {
    const path = await writeManifest(
      {
        instance: "dev",
        tests: [
          {
            id: "s/t",
            name: "T",
            lastRun: { at: "2026-07-04T00:00:00.000Z", status: "fail" },
          },
        ],
        suites: [],
      },
      dir,
    );
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(parsed.tests[0].lastRun, {
      at: "2026-07-04T00:00:00.000Z",
      status: "fail",
    });
    assert.ok(!("resultId" in parsed.tests[0].lastRun));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeManifest honours an absolute explicitPath", async () => {
  const dir = tempDir();
  try {
    const abs = join(dir, "explicit.json");
    const p = await writeManifest(
      emptyManifest("dev"),
      "/nonexistent-cwd",
      abs,
    );
    assert.equal(p, abs);
    assert.ok(existsSync(abs));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeManifest resolves a relative explicitPath against cwd", async () => {
  const dir = tempDir();
  try {
    const p = await writeManifest(emptyManifest("dev"), dir, "custom.json");
    assert.equal(p, resolve(dir, "custom.json"));
    assert.ok(existsSync(join(dir, "custom.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- mergeManifest ---------------------------------------------------------

test("mergeManifest keeps the incoming ids when there is no existing manifest", () => {
  const incoming = {
    instance: "dev",
    tests: [{ id: "x/login", sysId: "s1", name: "Login", active: true }],
    suites: [
      { id: "x/smoke", sysId: "su1", name: "Smoke", testIds: ["x/login"] },
    ],
  };
  const merged = mergeManifest(undefined, incoming);
  assert.equal(merged.tests[0].id, "x/login");
  assert.equal(merged.suites[0].id, "x/smoke");
});

test("mergeManifest adds a brand-new test verbatim (no committed match)", () => {
  const existing = {
    instance: "dev",
    tests: [{ id: "x/a", sysId: "s1", name: "A" }],
    suites: [],
  };
  const incoming = {
    instance: "dev",
    tests: [
      { id: "x/a", sysId: "s1", name: "A" },
      { id: "x/b", sysId: "s2", name: "B" },
    ],
    suites: [],
  };
  const merged = mergeManifest(existing, incoming);
  assert.equal(merged.tests.length, 2);
  assert.deepEqual(
    merged.tests.find((t) => t.name === "B"),
    { id: "x/b", sysId: "s2", name: "B" },
  );
});

test("mergeManifest preserves the committed logical id when matched by sysId", () => {
  const existing = {
    instance: "prod",
    tests: [{ id: "committed/login", sysId: "shared-sys", name: "Login" }],
    suites: [],
  };
  // A fresh sync computed a different logical id but the same sys_id, and renamed.
  const incoming = {
    instance: "prod",
    tests: [
      {
        id: "fresh/login",
        sysId: "shared-sys",
        name: "Login Renamed",
        active: true,
      },
    ],
    suites: [],
  };
  const merged = mergeManifest(existing, incoming);
  assert.deepEqual(merged.tests, [
    {
      id: "committed/login",
      sysId: "shared-sys",
      name: "Login Renamed",
      active: true,
    },
  ]);
});

test("mergeManifest matches by name and keeps the committed id while updating sysId", () => {
  const existing = {
    instance: "dev",
    tests: [{ id: "committed/login", sysId: "old-sys", name: "Login" }],
    suites: [],
  };
  // Same test on another instance: same name, a per-instance sys_id, fresh id.
  const incoming = {
    instance: "prod",
    tests: [{ id: "prod/login", sysId: "new-sys", name: "Login" }],
    suites: [],
  };
  const merged = mergeManifest(existing, incoming);
  assert.deepEqual(merged.tests, [
    { id: "committed/login", sysId: "new-sys", name: "Login" },
  ]);
});

test("mergeManifest sysId match wins over a competing same-name candidate", () => {
  const existing = {
    instance: "dev",
    tests: [
      { id: "committed/by-name", name: "Same", sysId: "name-sys" },
      { id: "committed/by-sysid", name: "Different", sysId: "target-sys" },
    ],
    suites: [],
  };
  const incoming = {
    instance: "prod",
    // name "Same" would match committed/by-name, but sysId points at the other one.
    tests: [{ id: "prod/x", name: "Same", sysId: "target-sys" }],
    suites: [],
  };
  const merged = mergeManifest(existing, incoming);
  assert.equal(merged.tests[0].id, "committed/by-sysid");
});

test("mergeManifest disambiguates duplicate names by coverage", () => {
  const existing = {
    instance: "prod",
    tests: [
      {
        id: "committed/dup-a",
        name: "Dup",
        covers: { type: "business_rule", name: "BrA" },
      },
      {
        id: "committed/dup-b",
        name: "Dup",
        covers: { type: "business_rule", name: "BrB" },
      },
    ],
    suites: [],
  };
  const incoming = {
    instance: "prod",
    tests: [
      {
        id: "prod/dup",
        sysId: "s-new",
        name: "Dup",
        covers: { type: "business_rule", name: "BrB" },
      },
    ],
    suites: [],
  };
  const merged = mergeManifest(existing, incoming);
  // Coverage BrB => matches committed/dup-b, not the first same-name test.
  assert.equal(merged.tests[0].id, "committed/dup-b");
  assert.equal(merged.tests[0].sysId, "s-new");
});

test("mergeManifest falls back to the first same-name test when coverage does not match", () => {
  const existing = {
    instance: "prod",
    tests: [
      {
        id: "committed/dup-a",
        name: "Dup",
        covers: { type: "business_rule", name: "BrA" },
      },
      {
        id: "committed/dup-b",
        name: "Dup",
        covers: { type: "business_rule", name: "BrB" },
      },
    ],
    suites: [],
  };
  const incoming = {
    instance: "prod",
    tests: [
      {
        id: "prod/dup",
        name: "Dup",
        covers: { type: "business_rule", name: "BrZ" },
      },
    ],
    suites: [],
  };
  const merged = mergeManifest(existing, incoming);
  // No coverage match among the same-name candidates => the first one wins.
  assert.equal(merged.tests[0].id, "committed/dup-a");
});

test("mergeManifest drops a committed test that is absent from the fresh sync", () => {
  const existing = {
    instance: "dev",
    tests: [
      { id: "x/keep", sysId: "s1", name: "Keep" },
      { id: "x/gone", sysId: "s2", name: "Gone" },
    ],
    suites: [],
  };
  const incoming = {
    instance: "dev",
    tests: [{ id: "x/keep", sysId: "s1", name: "Keep" }],
    suites: [],
  };
  const merged = mergeManifest(existing, incoming);
  // The merged set is exactly the incoming set; existing-only tests are dropped.
  assert.deepEqual(
    merged.tests.map((t) => t.id),
    ["x/keep"],
  );
});

test("mergeManifest carries volatile fields (active, covers, lastRun) from incoming", () => {
  const existing = {
    instance: "dev",
    tests: [
      {
        id: "committed/login",
        sysId: "shared",
        name: "Login",
        active: true,
        lastRun: { at: "2026-01-01T00:00:00.000Z", status: "pass" },
      },
    ],
    suites: [],
  };
  const incoming = {
    instance: "prod",
    tests: [
      {
        id: "fresh/login",
        sysId: "shared",
        name: "Login",
        active: false,
        covers: { type: "script_include", name: "LoginSI" },
        lastRun: {
          at: "2026-07-04T00:00:00.000Z",
          status: "fail",
          resultId: "r9",
        },
      },
    ],
    suites: [],
  };
  const merged = mergeManifest(existing, incoming);
  assert.deepEqual(merged.tests[0], {
    id: "committed/login",
    sysId: "shared",
    name: "Login",
    active: false,
    covers: { type: "script_include", name: "LoginSI" },
    lastRun: { at: "2026-07-04T00:00:00.000Z", status: "fail", resultId: "r9" },
  });
});

test("mergeManifest reconciles suites by sysId then name and preserves the committed id", () => {
  const existing = {
    instance: "dev",
    tests: [],
    suites: [
      {
        id: "committed/smoke",
        sysId: "suite-shared",
        name: "Smoke",
        testIds: [],
      },
      { id: "committed/regress", name: "Regression", testIds: [] },
    ],
  };
  const incoming = {
    instance: "prod",
    tests: [],
    suites: [
      // Matched by sysId even though the name changed.
      {
        id: "prod/smoke",
        sysId: "suite-shared",
        name: "Smoke Renamed",
        testIds: [],
      },
      // Matched by name (no sysId on either side).
      { id: "prod/regress", name: "Regression", testIds: [] },
    ],
  };
  const merged = mergeManifest(existing, incoming);
  const bySmoke = merged.suites.find((s) => s.name === "Smoke Renamed");
  const byRegress = merged.suites.find((s) => s.name === "Regression");
  assert.equal(bySmoke.id, "committed/smoke");
  assert.equal(byRegress.id, "committed/regress");
});

test("mergeManifest keeps a fresh suite id when there is no committed match", () => {
  const existing = { instance: "dev", tests: [], suites: [] };
  const incoming = {
    instance: "dev",
    tests: [],
    suites: [
      { id: "prod/new-suite", sysId: "s-new", name: "New", testIds: [] },
    ],
  };
  const merged = mergeManifest(existing, incoming);
  assert.equal(merged.suites[0].id, "prod/new-suite");
});

test("mergeManifest remaps suite testIds through the reconciled test ids", () => {
  const existing = {
    instance: "dev",
    tests: [{ id: "committed/login", sysId: "shared", name: "Login" }],
    suites: [],
  };
  const incoming = {
    instance: "prod",
    tests: [{ id: "fresh/login", sysId: "shared", name: "Login" }],
    // The suite references the fresh test id; merge must remap it to the committed id.
    suites: [{ id: "prod/smoke", name: "Smoke", testIds: ["fresh/login"] }],
  };
  const merged = mergeManifest(existing, incoming);
  assert.equal(merged.tests[0].id, "committed/login");
  assert.deepEqual(merged.suites[0].testIds, ["committed/login"]);
});

test("mergeManifest leaves a suite testId untouched when it was not remapped", () => {
  const existing = {
    instance: "dev",
    tests: [{ id: "committed/login", sysId: "shared", name: "Login" }],
    suites: [],
  };
  const incoming = {
    instance: "prod",
    tests: [
      { id: "committed/login", sysId: "shared", name: "Login" },
      { id: "prod/newtest", sysId: "s-new", name: "New Test" },
    ],
    suites: [
      {
        id: "prod/smoke",
        name: "Smoke",
        testIds: ["committed/login", "prod/newtest"],
      },
    ],
  };
  const merged = mergeManifest(existing, incoming);
  // The login id was already stable; the new test keeps its fresh id.
  assert.deepEqual(merged.suites[0].testIds, [
    "committed/login",
    "prod/newtest",
  ]);
});

test("mergeManifest prefers incoming url/scope/syncedAt but falls back to existing for each (CC-38)", () => {
  const existing = {
    instance: "dev",
    url: "https://old.service-now.com",
    scope: "x_old",
    syncedAt: "2026-01-01T00:00:00.000Z",
    tests: [],
    suites: [],
  };
  const incomingWithBoth = {
    instance: "dev",
    url: "https://new.service-now.com",
    scope: "x_new",
    syncedAt: "2026-07-04T00:00:00.000Z",
    tests: [],
    suites: [],
  };
  // A fresh sync that stamps syncedAt still wins over the committed one.
  const merged1 = mergeManifest(existing, incomingWithBoth);
  assert.equal(merged1.url, "https://new.service-now.com");
  assert.equal(merged1.scope, "x_new");
  assert.equal(merged1.syncedAt, "2026-07-04T00:00:00.000Z");

  // CC-38: a library caller that pulls WITHOUT `opts.now` produces a snapshot
  // with no `syncedAt`. Taking it verbatim (the old behaviour) would erase the
  // last-known sync time and make the manifest read as never-synced, failing the
  // freshness gate. The committed value must be preserved instead.
  const incomingWithout = { instance: "dev", tests: [], suites: [] };
  const merged2 = mergeManifest(existing, incomingWithout);
  assert.equal(merged2.url, "https://old.service-now.com");
  assert.equal(merged2.scope, "x_old");
  assert.equal(merged2.syncedAt, "2026-01-01T00:00:00.000Z");
});

test("mergeManifest takes the instance from incoming", () => {
  const existing = { instance: "dev", tests: [], suites: [] };
  const incoming = { instance: "prod", tests: [], suites: [] };
  assert.equal(mergeManifest(existing, incoming).instance, "prod");
});

test("mergeManifest result round-trips through write/load with stable ids", async () => {
  const dir = tempDir();
  try {
    const existing = {
      instance: "dev",
      tests: [{ id: "committed/login", sysId: "shared", name: "Login" }],
      suites: [
        { id: "committed/smoke", name: "Smoke", testIds: ["committed/login"] },
      ],
    };
    const incoming = {
      instance: "dev",
      syncedAt: "2026-07-04T00:00:00.000Z",
      tests: [{ id: "fresh/login", sysId: "shared", name: "Login" }],
      suites: [{ id: "fresh/smoke", name: "Smoke", testIds: ["fresh/login"] }],
    };
    const merged = mergeManifest(existing, incoming);
    await writeManifest(merged, dir);
    const loaded = await loadManifest("dev", dir);
    assert.equal(loaded.tests[0].id, "committed/login");
    assert.equal(loaded.suites[0].id, "committed/smoke");
    assert.deepEqual(loaded.suites[0].testIds, ["committed/login"]);
    assert.equal(loaded.syncedAt, "2026-07-04T00:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Write helper: compute the canonical manifest path and ensure its parent dir
 * exists so a raw `writeFileSync` (bypassing `writeManifest`) can drop a
 * hand-crafted file there.
 */
function manifestPathWithMkdir(dir, instance) {
  const p = manifestPath(instance, dir);
  mkdirSync(join(dir, PREFLIGHT_DIR, STATE_DIR), { recursive: true });
  return p;
}
