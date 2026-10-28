/**
 * F-X-12: the composite GitHub Action and the GitLab / Azure templates.
 * Raw-text assertions, no YAML dependency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const ACTION = read("action.yml");
const SNIPPETS = [
  "ci/gitlab/servicenow-preflight.gitlab-ci.yml",
  "ci/azure/servicenow-preflight.yml",
];

/** The keys of a top-level YAML block (two-space indented). */
function blockKeys(text, block) {
  const start = text.indexOf(`\n${block}:\n`);
  assert.notEqual(start, -1, `no ${block}: block`);
  const keys = [];
  for (const line of text.slice(start + block.length + 3).split("\n")) {
    if (/^\S/.test(line)) break;
    const match = /^ {2}([a-z][\w-]*):/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

const HELP = spawnSync(
  process.execPath,
  [join(ROOT, "bin", "servicenow-preflight.cjs"), "--help"],
  { encoding: "utf8" },
).stdout;

test("every input the action reads is declared, and no input carries a secret", () => {
  const inputs = blockKeys(ACTION, "inputs");
  assert.ok(inputs.length >= 13);
  const used = new Set(
    [...ACTION.matchAll(/\binputs\.([a-z][\w-]*)/g)].map((m) => m[1]),
  );
  for (const name of used) assert.ok(inputs.includes(name), name);
  for (const name of inputs) {
    assert.ok(used.has(name), `${name} is declared but unused`);
    assert.doesNotMatch(name, /password|secret|token|key/i);
  }
});

test("inputs reach the shell only through env, never inline in run", () => {
  const scripts = [...ACTION.matchAll(/run: \|\n((?: {8}.*\n|\n)+)/g)].map(
    (m) => m[1],
  );
  assert.ok(scripts.length >= 1);
  for (const script of scripts) assert.doesNotMatch(script, /\$\{\{/);
});

test("every uses: is pinned to a full commit SHA with a version comment", () => {
  for (const file of ["action.yml", ".github/workflows/action-selftest.yml"]) {
    const uses = [...read(file).matchAll(/uses: (\S+)(.*)/g)].filter(
      ([, ref]) => ref !== "./",
    );
    assert.ok(uses.length > 0, file);
    for (const [, ref, rest] of uses) {
      assert.match(ref, /@[0-9a-f]{40}$/, `${file}: ${ref}`);
      assert.match(rest, /# v\d+\.\d+\.\d+/, `${file}: ${ref}`);
    }
  }
});

test("outputs map to the run step's outputs", () => {
  const outputs = blockKeys(ACTION, "outputs");
  assert.deepEqual(outputs, [
    "ok",
    "pass",
    "warn",
    "fail",
    "sarif-file",
    "report-json",
    "exit-code",
  ]);
  for (const name of outputs) {
    assert.ok(
      ACTION.includes(`value: \${{ steps.run.outputs.${name} }}`),
      name,
    );
  }
});

test("the action and the templates use only flags the CLI has", () => {
  for (const file of ["action.yml", ...SNIPPETS]) {
    const flags = new Set(
      [...read(file).matchAll(/(?<![\w-])--([a-z][a-z-]+)/g)].map(
        (m) => `--${m[1]}`,
      ),
    );
    flags.delete("--yes");
    flags.delete("--package");
    assert.ok(flags.size > 0, file);
    for (const flag of flags)
      assert.ok(HELP.includes(flag), `${file}: ${flag}`);
  }
});

test("the templates take credentials from CI variables only", () => {
  for (const file of SNIPPETS) {
    const text = read(file);
    assert.doesNotMatch(text, /SNPF_PASSWORD/, file);
    assert.match(text, /SNPF_PASS/, file);
  }
  assert.match(read(SNIPPETS[1]), /SNPF_PASS: \$\(SNPF_PASS\)/);
});

test("the committed replay sample replays green without credentials", () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SNPF_")) delete env[key];
  }
  const res = spawnSync(
    process.execPath,
    [
      join(ROOT, "bin", "servicenow-preflight.cjs"),
      "--replay",
      join(ROOT, "test", "fixtures", "replay-sample"),
      "--only",
      "instance-url-configured,connectivity-auth,acl-role-sanity",
      "--format",
      "json",
      "--no-summary",
    ],
    { cwd: join(ROOT, "test", "fixtures"), env, encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  const [{ report }] = JSON.parse(res.stdout).runs;
  assert.deepEqual(report.summary, { pass: 2, warn: 1, fail: 0 });
});
