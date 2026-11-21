/**
 * RR-69: the release and CI gates fail closed.
 *  - REL-1: `ci/certification/scan.sh` exits 1 on any blocker (never the
 *    count, which wraps at 256) and scans paths that contain spaces.
 *  - REL-5: the composite action pins the npm package for every action ref.
 *  - REL-6: `release.yml` publishes a prerelease under the `next` dist-tag.
 * RR-14 (OPS-14): `release.yml` has a manual dry-run rehearsal path, runs one
 * release at a time and ignores floating major tags.
 * The workflow shell blocks run for real, with `npx` / `npm` stubbed on PATH.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const SCAN = join(ROOT, "ci", "certification", "scan.sh");
const noBash = spawnSync("bash", ["-c", "exit 0"]).status !== 0;
const skip = noBash ? "bash is not available" : false;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "snpf-rr69-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The body of the `run: |` block that follows `marker` in a workflow file,
 * dedented. Raw text, no YAML dependency (as in action.test.js).
 */
function runBlock(text, marker) {
  const at = text.indexOf(marker);
  assert.notEqual(at, -1, `no ${marker}`);
  const lines = text.slice(at).split("\n");
  const head = lines.findIndex((line) => /^\s*run: \|$/.test(line));
  assert.notEqual(head, -1, `no run block after ${marker}`);
  const body = [];
  let indent = -1;
  for (const line of lines.slice(head + 1)) {
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const width = line.length - line.trimStart().length;
    if (indent === -1) indent = width;
    if (width < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

/** A stub command on PATH that logs its argv (one per line) and exits 0. */
function stub(dir, name) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, `${name}.log`);
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit 0\n`);
  chmodSync(file, 0o755);
  return { bin, log };
}

// ---------- REL-1: scan.sh ----------

const TABNAB = '<x><a target="_blank" href="u">l</a></x>\n';

function scan(cwd, args) {
  return spawnSync("bash", [SCAN, "--mode", "blocking", ...args], {
    cwd,
    encoding: "utf8",
  });
}

test(
  "scan.sh exits 1, not the blocker count mod 256, on 256 blockers",
  { skip },
  (t) => {
    const dir = scratch(t);
    const files = [];
    for (let i = 1; i <= 256; i++) {
      const name = `f${i}.xml`;
      writeFileSync(join(dir, name), TABNAB);
      files.push(name);
    }
    const res = scan(dir, files);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /256 blocker\(s\)/);
    assert.match(
      readFileSync(join(dir, "cert-junit.xml"), "utf8"),
      /failures="256"/,
    );
  },
);

test(
  "scan.sh exits 1 on a single blocker and 0 on a clean tree",
  { skip },
  (t) => {
    const dir = scratch(t);
    writeFileSync(join(dir, "bad.xml"), TABNAB);
    writeFileSync(join(dir, "good.xml"), "<x>clean</x>\n");
    assert.equal(scan(dir, ["bad.xml"]).status, 1);
    assert.equal(scan(dir, ["good.xml"]).status, 0);
  },
);

test(
  "scan.sh applies the per-file rules to a path with spaces",
  { skip },
  (t) => {
    const dir = scratch(t);
    mkdirSync(join(dir, "my app"));
    writeFileSync(join(dir, "my app", "page.xml"), TABNAB);
    const res = scan(dir, ["my app/page.xml"]);
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /BLOCKER 7\.4/);
    assert.match(res.stdout, /my app\/page\.xml:1:/);
  },
);

test("scan.sh in advisory mode still exits 0", { skip }, (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "bad.xml"), TABNAB);
  const res = spawnSync("bash", [SCAN, "--mode", "advisory", "bad.xml"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
});

// ---------- REL-5: the action's package version ----------

const ACTION_RUN = runBlock(read("action.yml"), "- id: run");

/**
 * Runs the action's `run` step with `npx` stubbed. Returns the exit status,
 * stdout, the package spec npx was asked for (or null) and GITHUB_OUTPUT.
 */
function runAction(t, { ref, version = "", actionPkg }) {
  const dir = scratch(t);
  const { bin, log } = stub(dir, "npx");
  const actionPath = join(dir, "action");
  mkdirSync(actionPath);
  if (actionPkg !== undefined) {
    writeFileSync(join(actionPath, "package.json"), JSON.stringify(actionPkg));
  }
  const script = join(dir, "run.sh");
  writeFileSync(script, ACTION_RUN);
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    SNPF_ACTION_VERSION: version,
    SNPF_ACTION_REF: ref,
    SNPF_ACTION_PATH: actionPath,
    SNPF_ACTION_ARGS: "run",
    SNPF_ACTION_INSTANCE: "",
    SNPF_ACTION_CONFIG: "",
    SNPF_ACTION_ONLY: "",
    SNPF_ACTION_SKIP: "",
    SNPF_ACTION_FAIL_ON: "fail",
    SNPF_ACTION_SARIF: "false",
    SNPF_ACTION_SUMMARY: "true",
    SNPF_ACTION_REPLAY: "",
    SNPF_ACTION_TEMP: dir,
    GITHUB_OUTPUT: output,
  };
  const res = spawnSync("bash", [script], { cwd: dir, env, encoding: "utf8" });
  let pkg = null;
  if (existsSync(log)) {
    const argv = readFileSync(log, "utf8").split("\n");
    pkg = argv[argv.indexOf("--package") + 1];
  }
  return {
    status: res.status,
    stdout: res.stdout,
    pkg,
    output: readFileSync(output, "utf8"),
  };
}

const PKG = { name: "servicenow-preflight", version: "1.4.0" };

test("a release tag ref runs the tag's version", { skip }, (t) => {
  assert.equal(
    runAction(t, { ref: "v1.2.3", actionPkg: PKG }).pkg,
    "servicenow-preflight@1.2.3",
  );
  assert.equal(
    runAction(t, { ref: "v1.0.0-rc.1", actionPkg: PKG }).pkg,
    "servicenow-preflight@1.0.0-rc.1",
  );
});

test(
  "a SHA, major-tag or branch ref runs the action's package.json version, never latest",
  { skip },
  (t) => {
    for (const ref of [
      "3d3c42e5aac5ba805825da76410c181273ba90b1",
      "v1",
      "main",
      "",
    ]) {
      const res = runAction(t, { ref, actionPkg: PKG });
      assert.equal(res.status, 0, `${ref}: ${res.stdout}`);
      assert.equal(res.pkg, "servicenow-preflight@1.4.0", ref);
    }
  },
);

test(
  "an explicit version input wins, including an opt-in latest",
  { skip },
  (t) => {
    const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
    assert.equal(
      runAction(t, { ref: sha, version: "latest", actionPkg: PKG }).pkg,
      "servicenow-preflight@latest",
    );
    assert.equal(
      runAction(t, { ref: "v1.2.3", version: "2.0.0", actionPkg: PKG }).pkg,
      "servicenow-preflight@2.0.0",
    );
    assert.equal(
      runAction(t, { ref: sha, version: "./pkg", actionPkg: PKG }).pkg,
      "./pkg",
    );
  },
);

test(
  "an unpinnable ref with no version input fails before npx runs",
  { skip },
  (t) => {
    const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
    for (const actionPkg of [undefined, { name: "x" }, { version: "latest" }]) {
      const res = runAction(t, { ref: sha, actionPkg });
      assert.equal(res.status, 2, JSON.stringify(actionPkg));
      assert.equal(res.pkg, null, "npx must not run");
      assert.match(
        res.stdout,
        /::error::Cannot pin the servicenow-preflight version/,
      );
      assert.match(res.output, /^exit-code=2$/m);
    }
  },
);

// ---------- REL-6: the publish dist-tag ----------

function publish(t, version, env = {}) {
  const run = runBlock(
    read(".github/workflows/release.yml"),
    "- name: Publish to npm",
  );
  const dir = scratch(t);
  const { bin, log } = stub(dir, "npm");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  const script = join(dir, "publish.sh");
  writeFileSync(script, run);
  const res = spawnSync("bash", ["-e", script], {
    cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...env },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  return readFileSync(log, "utf8").trim().split("\n");
}

test(
  "the release workflow publishes a prerelease under next, a release under latest",
  { skip },
  (t) => {
    const tagOf = (argv) => argv[argv.indexOf("--tag") + 1];
    const rc = publish(t, "1.0.0-rc.1");
    assert.equal(rc[0], "publish");
    assert.ok(rc.includes("--provenance"));
    assert.equal(tagOf(rc), "next");
    assert.equal(tagOf(publish(t, "1.1.0-beta.0")), "next");
    assert.equal(tagOf(publish(t, "1.0.0")), "latest");
    assert.equal(tagOf(publish(t, "1.0.0+build-7")), "latest");
  },
);

test("the release workflow has exactly one npm publish, and it passes --tag", () => {
  const text = read(".github/workflows/release.yml");
  const publishes = [...text.matchAll(/^[^#\n]*\bnpm publish\b.*$/gm)].map(
    (m) => m[0],
  );
  assert.equal(publishes.length, 1, publishes.join("\n"));
  assert.match(publishes[0], /--tag "\$DIST_TAG"/);
});

// ---------- RR-14 (OPS-14): rehearsal path, concurrency, tag filter ----------

const RELEASE = ".github/workflows/release.yml";

/** The YAML text of one step, from its `- name:` line to the next step. */
function step(text, name) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(at, -1, `no step ${name}`);
  const indent = lines[at].length - lines[at].trimStart().length;
  const body = [lines[at]];
  for (const line of lines.slice(at + 1)) {
    const width = line.length - line.trimStart().length;
    if (line.trim() !== "" && width <= indent) break;
    body.push(line);
  }
  return body.join("\n");
}

/** GitHub's tag filter glob: `*` = any run of non-`/` chars, `[0-9]` = a digit. */
function globMatch(glob, ref) {
  const source = glob
    .split(/(\[[^\]]*\]|\*)/)
    .map((part) =>
      part === "*"
        ? "[^/]*"
        : part.startsWith("[")
          ? part
          : part.replace(/[.+?^${}()|\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`).test(ref);
}

test("release.yml starts only on a vMAJOR.MINOR.PATCH tag, never on a floating v1", () => {
  const text = read(RELEASE);
  const block = /^ {2}push:\n {4}tags:\n((?: {6}.*\n)+)/m.exec(text);
  assert.ok(block, "no push.tags block");
  const globs = [...block[1].matchAll(/^ {6}- "([^"]+)"$/gm)].map((m) => m[1]);
  assert.deepEqual(globs, ["v[0-9]*.[0-9]*.[0-9]*"]);
  const starts = (ref) => globs.some((g) => globMatch(g, ref));
  for (const ref of ["v1.0.0", "v1.0.0-rc.1", "v10.2.33", "v1.0.0+build.7"])
    assert.ok(starts(ref), ref);
  for (const ref of ["v1", "v1.0", "vnext", "release-1.0.0", "1.0.0"])
    assert.ok(!starts(ref), ref);
});

test("release.yml has a manual dry-run trigger, on by default, and a release concurrency group", () => {
  const text = read(RELEASE);
  assert.match(
    text,
    /^ {2}workflow_dispatch:\n {4}inputs:\n {6}dry_run:\n(?: {8}.*\n)*? {8}type: boolean\n {8}default: true\n/m,
  );
  assert.match(text, /^ {6}version:\n(?: {8}.*\n)*? {8}type: string\n/m);
  assert.match(
    text,
    /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false\n/m,
  );
  assert.match(
    text,
    /^ {6}DRY_RUN: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.dry_run \}\}$/m,
  );
});

test("a dry run skips only the ancestry and tag checks; the 0.x guard and the gate still run", () => {
  const text = read(RELEASE);
  for (const name of [
    "Verify tagged commit is an ancestor of main",
    "Verify tag matches package.json version",
  ])
    assert.match(step(text, name), /^\s+if: env\.DRY_RUN != 'true'$/m, name);
  for (const name of [
    "Refuse a 0.x version from the 1.0.0 train",
    "Tessera workspace gate",
    "SDIST smoke (packed tarball, offline install)",
    "Publish to npm",
  ])
    assert.doesNotMatch(step(text, name), /^\s+if:/m, name);
});

test(
  "a dry run publishes with --dry-run and the explicit dist-tag, and logs the listing",
  { skip },
  (t) => {
    const temp = scratch(t);
    const argv = publish(t, "1.0.0-rc.1", {
      DRY_RUN: "true",
      RUNNER_TEMP: temp,
    });
    assert.equal(argv[0], "publish");
    assert.ok(argv.includes("--dry-run"), argv.join(" "));
    assert.ok(argv.includes("--provenance"));
    assert.equal(argv[argv.indexOf("--tag") + 1], "next");
    assert.ok(existsSync(join(temp, "npm-publish.log")));
    for (const env of [{}, { DRY_RUN: "false" }])
      assert.ok(!publish(t, "1.0.0", env).includes("--dry-run"));
  },
);

test("a dry run never receives the npm token and uploads the listing", () => {
  const text = read(RELEASE);
  assert.match(
    step(text, "Publish to npm"),
    /^\s+NODE_AUTH_TOKEN: \$\{\{ env\.DRY_RUN != 'true' && secrets\.NPM_TOKEN \|\| '' \}\}$/m,
  );
  const upload = step(text, "Upload the dry-run tarball listing");
  assert.match(upload, /^\s+if: env\.DRY_RUN == 'true'$/m);
  assert.match(upload, /uses: actions\/upload-artifact@[0-9a-f]{40} # v\d/);
  assert.match(upload, /path: \$\{\{ runner\.temp \}\}\/npm-publish\.log/);
  assert.match(upload, /if-no-files-found: error/);
});

function manualInputs(t, env) {
  const run = runBlock(read(RELEASE), "- name: Check the manual-run inputs");
  const dir = scratch(t);
  const script = join(dir, "inputs.sh");
  writeFileSync(script, run);
  return spawnSync("bash", ["-e", script], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, ...env },
    encoding: "utf8",
  });
}

test(
  "manual runs: a dry run takes a semver version; a real publish needs a tag and no version",
  { skip },
  (t) => {
    const ok = (env) =>
      assert.equal(manualInputs(t, env).status, 0, JSON.stringify(env));
    const refused = (env, message) => {
      const res = manualInputs(t, env);
      assert.equal(res.status, 1, JSON.stringify(env));
      assert.match(res.stdout, message);
    };
    const dry = { DRY_RUN: "true", GITHUB_REF: "refs/heads/main" };
    ok(dry);
    ok({ ...dry, REHEARSAL_VERSION: "1.0.0-rc.1" });
    ok({ ...dry, REHEARSAL_VERSION: "1.0.0+build.7" });
    for (const bad of [
      "1.0",
      "v1.0.0",
      "1.0.0; rm -rf /",
      "1.0.0\nx",
      "latest",
    ])
      refused({ ...dry, REHEARSAL_VERSION: bad }, /is not a semver version/);
    ok({ DRY_RUN: "false", GITHUB_REF: "refs/tags/v1.0.0" });
    refused(
      { DRY_RUN: "false", GITHUB_REF: "refs/heads/main" },
      /must run on a version tag, not refs\/heads\/main/,
    );
    refused(
      {
        DRY_RUN: "false",
        GITHUB_REF: "refs/tags/v1.0.0",
        REHEARSAL_VERSION: "1.0.0",
      },
      /for dry runs only/,
    );
  },
);

test(
  "the rehearsal version step runs only in a dry run and never commits or tags",
  { skip },
  (t) => {
    const text = read(RELEASE);
    const rehearse = step(text, "Rehearse as the requested version (dry run)");
    assert.match(
      rehearse,
      /^\s+if: env\.DRY_RUN == 'true' && inputs\.version != ''$/m,
    );
    const dir = scratch(t);
    const { bin, log } = stub(dir, "npm");
    const script = join(dir, "rehearse.sh");
    writeFileSync(
      script,
      runBlock(text, "- name: Rehearse as the requested version"),
    );
    const res = spawnSync("bash", ["-e", script], {
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        REHEARSAL_VERSION: "1.0.0-rc.1",
      },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const argv = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(argv.slice(0, 2), ["version", "1.0.0-rc.1"]);
    for (const flag of ["--no-git-tag-version", "--ignore-scripts"])
      assert.ok(argv.includes(flag), flag);
  },
);
