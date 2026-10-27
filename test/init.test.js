/**
 * F-X-13: `init` — the pure plan, the write guard, the prompts and the CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  appendLines,
  applyInit,
  envHints,
  normaliseAnswers,
  planInit,
} from "../build/init.js";
import { promptInit } from "../build/init-prompt.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "bin", "servicenow-preflight.cjs");
const BASE = { auth: "basic", multi: false, ci: "none" };
const paths = (ops) => ops.map((op) => op.path);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "snpf-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run the CLI with every SNPF_* variable stripped; stdin is a pipe. */
function cli(args, cwd) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SNPF_")) delete env[key];
  }
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env,
    input: "",
    encoding: "utf8",
  });
}

test("the plan per CI provider", () => {
  const files = (ci) => paths(planInit({ ...BASE, ci }, "1.2.3"));
  assert.deepEqual(files("none"), ["preflight.config.json", ".gitignore"]);
  assert.deepEqual(files("github"), [
    "preflight.config.json",
    ".github/workflows/preflight.yml",
    ".gitignore",
  ]);
  assert.deepEqual(files("gitlab"), [
    "preflight.config.json",
    ".gitlab-ci.yml",
    ".gitignore",
  ]);
  assert.deepEqual(files("azure"), [
    "preflight.config.json",
    "azure-pipelines.yml",
    ".gitignore",
  ]);

  const [, github] = planInit({ ...BASE, ci: "github" }, "1.2.3");
  assert.match(
    github.content,
    /uses: IvanBBaev\/servicenow-preflight@v1\.2\.3/,
  );
  assert.match(github.content, /SNPF_PASS: \$\{\{ secrets\.SNPF_PASS \}\}/);
  const [, gitlab] = planInit({ ...BASE, ci: "gitlab" }, "1.2.3");
  assert.match(gitlab.content, /\/v1\.2\.3\/ci\/gitlab\//);
  assert.match(gitlab.content, /SNPF_VERSION: "1\.2\.3"/);
  const [, azure] = planInit({ ...BASE, ci: "azure" }, "1.2.3");
  assert.match(azure.content, /npx --yes servicenow-preflight@1\.2\.3 run/);
  assert.match(azure.content, /SNPF_PASS: \$\(SNPF_PASS\)/);
});

test("single mode writes the URL and scope into the config", () => {
  const answers = normaliseAnswers({
    ...BASE,
    instanceUrl: " https://acme.service-now.com/nav_to.do ",
    scope: "x_acme_app",
  });
  const [config] = planInit(answers, "1.2.3");
  assert.deepEqual(JSON.parse(config.content), {
    $schema:
      "./node_modules/servicenow-preflight/schemas/preflight.config.v1.json",
    instanceUrl: "https://acme.service-now.com",
    scope: "x_acme_app",
  });
  assert.deepEqual(envHints(answers), [
    "SNPF_USER=<user>",
    "SNPF_PASS=<password>",
  ]);
});

test("multi mode writes a one-instance registry and runs it in CI", () => {
  const answers = normaliseAnswers({
    ...BASE,
    multi: true,
    ci: "github",
    instanceUrl: "https://acme-dev.service-now.com",
    scope: "x_acme_app",
  });
  const ops = planInit(answers, "1.2.3");
  assert.deepEqual(paths(ops), [
    "preflight.config.json",
    ".preflight/instances.json",
    ".github/workflows/preflight.yml",
    ".gitignore",
  ]);
  assert.deepEqual(JSON.parse(ops[1].content), {
    version: 1,
    scope: "x_acme_app",
    instances: {
      dev: {
        url: "https://acme-dev.service-now.com",
        stage: "dev",
        promotesTo: null,
      },
    },
  });
  assert.equal(JSON.parse(ops[0].content).instanceUrl, undefined);
  assert.match(ops[2].content, /with:\n {10}instance: dev/);
});

test("answers are validated", () => {
  assert.throws(
    () => normaliseAnswers({ ...BASE, multi: true }),
    /needs the instance URL/,
  );
  assert.throws(
    () => normaliseAnswers({ ...BASE, instanceUrl: "ftp://acme" }),
    /must use https/,
  );
  assert.throws(
    () => normaliseAnswers({ ...BASE, instanceUrl: "https://u:p@acme" }),
    /must not carry credentials/,
  );
  assert.throws(
    () => normaliseAnswers({ ...BASE, scope: "x'; drop" }),
    /outside/,
  );
});

test("no op ever targets .env, and the env hints only name variables", () => {
  for (const auth of ["basic", "oauth-client", "bearer", "mtls"]) {
    for (const ci of ["github", "gitlab", "azure", "none"]) {
      for (const multi of [false, true]) {
        const answers = {
          auth,
          ci,
          multi,
          instanceUrl: "https://acme.service-now.com",
        };
        for (const op of planInit(answers, "1.2.3")) {
          assert.doesNotMatch(op.path, /(^|\/)\.env/);
        }
        for (const hint of envHints(answers)) {
          assert.match(hint, /^SNPF_[A-Z_]+=<[a-z ]+>$/);
        }
      }
    }
  }
});

test("an existing file without --force refuses the whole plan", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "preflight.config.json"), "{}\n");
  const ops = planInit({ ...BASE, ci: "github" }, "1.2.3");
  assert.throws(
    () => applyInit(dir, ops, { force: false }),
    /would overwrite preflight\.config\.json; pass --force/,
  );
  assert.equal(existsSync(join(dir, ".github")), false);
  assert.equal(existsSync(join(dir, ".gitignore")), false);

  const result = applyInit(dir, ops, { force: true });
  assert.deepEqual(result.overwritten, ["preflight.config.json"]);
  assert.deepEqual(result.created, [".github/workflows/preflight.yml"]);
});

test("the .gitignore append is idempotent and keeps existing lines", (t) => {
  assert.equal(appendLines("", ["a"]), "a\n");
  assert.equal(appendLines("x", ["a"]), "x\na\n");
  assert.equal(appendLines("a\r\nb\n", ["a", "b"]), "a\r\nb\n");

  const dir = tempDir(t);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env\n");
  const ops = planInit(BASE, "1.2.3");
  applyInit(dir, ops, { force: false });
  const once = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.equal(
    once,
    "node_modules/\n.env\n.preflight/fixtures/\n.preflight/trace*.ndjson\n",
  );
  const again = applyInit(dir, ops.slice(1), { force: false });
  assert.deepEqual(again.appended, []);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), once);
});

test("the interactive flow gives the same plan as the flag form", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.end(
    "https://acme-dev.service-now.com\nx_acme_app\noauth-client\ny\ngitlab\n",
  );
  const prompted = await promptInit(BASE, { input, output });
  const flags = {
    instanceUrl: "https://acme-dev.service-now.com",
    scope: "x_acme_app",
    auth: "oauth-client",
    multi: true,
    ci: "gitlab",
  };
  assert.deepEqual(
    planInit(normaliseAnswers(prompted), "1.2.3"),
    planInit(normaliseAnswers(flags), "1.2.3"),
  );
  assert.match(String(output.read()), /Instance URL/);
});

test("blank answers and the end of input keep the defaults", async () => {
  const input = new PassThrough();
  input.end("\n");
  const defaults = { ...BASE, scope: "x_acme_app", ci: "azure" };
  const answers = await promptInit(defaults, {
    input,
    output: new PassThrough(),
  });
  assert.deepEqual(answers, defaults);
});

test("init --yes --ci github, then config validate and a replay, exit 0", (t) => {
  const dir = tempDir(t);
  const init = cli(["init", "--yes", "--ci", "github"], dir);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /Created preflight\.config\.json/);
  assert.match(init.stdout, /SNPF_INSTANCE=<instance url>/);
  assert.equal(existsSync(join(dir, ".env")), false);

  const validate = cli(["config", "validate"], dir);
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);

  const run = cli(
    [
      "run",
      "--replay",
      join(ROOT, "test", "fixtures", "replay-sample"),
      "--only",
      "instance-url-configured,connectivity-auth,acl-role-sanity",
      "--no-summary",
    ],
    dir,
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);

  const again = cli(["init", "--yes", "--ci", "github"], dir);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /preflight\.config\.json, \.github/);
});

test("a non-TTY init never prompts, and init flags stay on init", (t) => {
  const dir = tempDir(t);
  const res = cli(["init"], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, "");
  assert.doesNotMatch(res.stdout, /\[|\?/);

  const misplaced = cli(["run", "--ci", "github"], dir);
  assert.equal(misplaced.status, 2);
  assert.match(misplaced.stderr, /apply to init only/);
  const extra = cli(["init", "dev"], dir);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /no positional arguments/);
  const unknown = cli(["init", "--ci", "jenkins"], dir);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown --ci "jenkins"/);
});
