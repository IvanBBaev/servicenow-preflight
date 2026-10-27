import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function runCli(args, cwd) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SNPF_")) delete env[key];
  }
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

/** Run `fn(dir)` in a temp dir holding `files` (name -> content). */
function withProject(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "snpf-config-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(
        join(dir, name),
        typeof content === "string"
          ? content
          : JSON.stringify(content, null, 2),
      );
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LEGACY = {
  instanceUrl: "https://dev1.service-now.com",
  options: { requiredApps: [{ id: "x_app" }], custom: true },
};

test("config schema prints the committed schema, or writes it with --out", () => {
  const committed = readFileSync(
    join(ROOT, "schemas", "preflight.config.v1.json"),
    "utf8",
  );
  withProject({}, (dir) => {
    const res = runCli(["config", "schema"], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, committed);
    const out = runCli(["config", "schema", "--out", "nested/s.json"], dir);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "");
    assert.equal(
      readFileSync(join(dir, "nested", "s.json"), "utf8"),
      committed,
    );
  });
});

test("config validate exits 0 on a clean file and 2 listing every problem", () => {
  withProject(
    {
      "preflight.config.json": {
        $schema: "./schemas/preflight.config.v1.json",
        instanceUrl: "https://dev1.service-now.com",
        checks: { "scoped-app-deps": { requiredApps: [{ id: "x_app" }] } },
      },
    },
    (dir) => {
      const res = runCli(["config", "validate"], dir);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, "preflight.config.json: valid.\n");
    },
  );
  withProject(
    {
      "bad.json": {
        options: { langauges: ["fr"] },
        failOn: "warning",
      },
    },
    (dir) => {
      const res = runCli(["config", "validate", "--config", "bad.json"], dir);
      assert.equal(res.status, 2);
      assert.equal(res.stdout, "");
      assert.match(
        res.stderr,
        /bad\.json: options\.langauges: unknown key \(did you mean languages\?\)/,
      );
      assert.match(
        res.stderr,
        /bad\.json: failOn: expected one of "fail", "warn", got "warning"/,
      );
      assert.match(res.stderr, /bad\.json: 2 problems found\./);
    },
  );
});

test("config validate still applies the load-time guards", () => {
  withProject(
    { "preflight.config.json": { scope: "x^ORsys_id!=0" } },
    (dir) => {
      const res = runCli(["config", "validate"], dir);
      assert.equal(res.status, 2);
      assert.doesNotMatch(res.stdout, /valid/);
    },
  );
});

test("config validate without a config file is a usage error", () => {
  withProject({}, (dir) => {
    const res = runCli(["config", "validate"], dir);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /No config file found/);
  });
});

test("config migrate prints a diff, and --write rewrites the file", () => {
  withProject({ "preflight.config.json": LEGACY }, (dir) => {
    const file = join(dir, "preflight.config.json");
    const before = readFileSync(file, "utf8");
    const diff = runCli(["config", "migrate"], dir);
    assert.equal(diff.status, 0, diff.stderr);
    assert.match(
      diff.stdout,
      /^--- preflight\.config\.json\n\+\+\+ preflight\.config\.json \(migrated\)\n@@ /,
    );
    assert.match(diff.stdout, /^\+ {4}"scoped-app-deps": \{$/m);
    assert.equal(readFileSync(file, "utf8"), before);

    const write = runCli(["config", "migrate", "--write"], dir);
    assert.equal(write.status, 0, write.stderr);
    assert.equal(
      write.stdout,
      "Migrated preflight.config.json: requiredApps -> scoped-app-deps.\n",
    );
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      instanceUrl: "https://dev1.service-now.com",
      options: { custom: true },
      checks: { "scoped-app-deps": { requiredApps: [{ id: "x_app" }] } },
    });

    const again = runCli(["config", "migrate"], dir);
    assert.equal(again.status, 0);
    assert.equal(
      again.stdout,
      "preflight.config.json is already in the checks layout.\n",
    );
  });
});

test("config migrate refuses a JavaScript config", () => {
  withProject(
    { "preflight.config.mjs": "export default { options: {} };\n" },
    (dir) => {
      const res = runCli(["config", "migrate"], dir);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /supports JSON configs only/);
    },
  );
});

test("config action and flag misuse are usage errors", () => {
  withProject({}, (dir) => {
    const cases = [
      [["config"], /config takes one action/],
      [
        ["config", "validte"],
        /Unknown config action "validte".*Did you mean: validate/,
      ],
      [["config", "schema", "extra"], /config takes one action/],
      [
        ["config", "validate", "--write"],
        /--write applies to config migrate only/,
      ],
      [
        ["config", "migrate", "--out", "x.json"],
        /--out applies to config schema only/,
      ],
      [["run", "--write"], /--out \/ --write apply to config only, not run/],
      [["list", "--out", "x"], /apply to config only, not list/],
    ];
    for (const [args, pattern] of cases) {
      const res = runCli(args, dir);
      assert.equal(res.status, 2, args.join(" "));
      assert.match(res.stderr, pattern, args.join(" "));
    }
  });
});

test("run prints config problems as warnings and still runs", () => {
  withProject(
    {
      "preflight.config.json": {
        instanceUrl: "https://dev1.service-now.com",
        select: { only: ["instance-url-configured"] },
        options: { langauges: ["fr"] },
      },
    },
    (dir) => {
      const res = runCli(["--format", "json"], dir);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(
        res.stderr,
        "servicenow-preflight: config warning: options.langauges: unknown key (did you mean languages?)\n",
      );
    },
  );
});

test("help lists the config subcommand", () => {
  withProject({}, (dir) => {
    const res = runCli(["--help"], dir);
    assert.match(res.stdout, /config schema \[--out <file>\]/);
    assert.match(res.stdout, /config validate/);
    assert.match(res.stdout, /config migrate \[--write\]/);
  });
});
