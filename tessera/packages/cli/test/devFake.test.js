// `--fake` is honoured only inside the Tessera dev workspace (W6b finding 2).
//
// `@tessera/fake-instance` is a devDependency and the release staging
// (scripts/stage-tessera.mjs) deliberately leaves it out of the published tree.
// A bare `import("@tessera/fake-instance")` from the shipped cli would then
// resolve through ANY ancestor `node_modules` — a stale copy, or a package
// somebody planted there — and that module would stand in for the instance
// under test. So the resolution is checked, fail-closed, before anything is
// imported or staged:
//
//   - the cli package must itself sit at `<workspace>/packages/<dir>` under a
//     workspace root whose manifest declares `workspaces`;
//   - the resolved module's REALPATH must lie inside
//     `<workspace>/packages/fake-instance/`.
//
// Anything else is a usage error that says the flag is dev-only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveDevFakeInstance, stage } from "../build/stage.js";
import { main } from "../build/cli.js";

/** This checkout's workspace root and cli package, as real paths. */
const WORKSPACE = realpathSync(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const CLI_DIR = path.join(WORKSPACE, "packages", "cli");
const CLI_BUILD = path.join(CLI_DIR, "build");
const REAL_FAKE = path.join(WORKSPACE, "packages", "fake-instance");

/** The module URL `stage.js` has in this checkout — the default anchor. */
const IN_WORKSPACE_MODULE = pathToFileURL(
  path.join(CLI_BUILD, "stage.js"),
).href;

const tempDir = async (t) => {
  const dir = realpathSync(
    await fs.mkdtemp(path.join(os.tmpdir(), "tessera-devfake-")),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

/** Write a minimal fake `@tessera/fake-instance` under `<root>/node_modules`. */
async function plantFakeInstance(root) {
  const pkg = path.join(root, "node_modules", "@tessera", "fake-instance");
  await fs.mkdir(path.join(pkg, "build"), { recursive: true });
  await fs.writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@tessera/fake-instance", type: "module" }),
  );
  const entry = path.join(pkg, "build", "index.js");
  await fs.writeFile(entry, "export const planted = true;\n");
  return entry;
}

const assertDevOnlyRefusal = (fn) =>
  assert.throws(fn, (error) => {
    assert.equal(error.name, "UsageError");
    assert.match(error.message, /--fake/);
    assert.match(error.message, /dev(elopment)?[- ]only/i);
    return true;
  });

describe("resolveDevFakeInstance — where --fake may load the fake from", () => {
  it("returns the workspace fake-instance by default in this checkout", () => {
    const url = resolveDevFakeInstance();
    const file = fileURLToPath(url);
    assert.ok(
      file.startsWith(REAL_FAKE + path.sep),
      `${file} is not under ${REAL_FAKE}`,
    );
  });

  it("refuses a resolution that lands in an ancestor node_modules outside the workspace", async (t) => {
    const outside = await tempDir(t);
    const planted = await plantFakeInstance(outside);
    assertDevOnlyRefusal(() =>
      resolveDevFakeInstance({
        moduleUrl: IN_WORKSPACE_MODULE,
        resolve: () => pathToFileURL(planted).href,
      }),
    );
  });

  it("refuses a workspace-looking path that is a symlink to somewhere else", async (t) => {
    // The check is on the REALPATH: a link farm entry pointing out of the
    // workspace must not pass because its spelling looks right.
    const outside = await tempDir(t);
    const planted = await plantFakeInstance(outside);
    const link = path.join(outside, "link.js");
    await fs.symlink(planted, link);
    assertDevOnlyRefusal(() =>
      resolveDevFakeInstance({
        moduleUrl: IN_WORKSPACE_MODULE,
        resolve: () => pathToFileURL(link).href,
      }),
    );
  });

  it("refuses a sibling package whose name merely starts with fake-instance", async (t) => {
    // `packages/fake-instance-evil/…` shares the prefix string; the check is
    // on a path SEGMENT, not a string prefix.
    const ws = await tempDir(t);
    await fs.writeFile(
      path.join(ws, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    await fs.mkdir(path.join(ws, "packages", "cli", "build"), {
      recursive: true,
    });
    await fs.mkdir(path.join(ws, "packages", "fake-instance"), {
      recursive: true,
    });
    const evil = path.join(ws, "packages", "fake-instance-evil", "index.js");
    await fs.mkdir(path.dirname(evil), { recursive: true });
    await fs.writeFile(evil, "export {};\n");
    assertDevOnlyRefusal(() =>
      resolveDevFakeInstance({
        moduleUrl: pathToFileURL(
          path.join(ws, "packages", "cli", "build", "stage.js"),
        ).href,
        resolve: () => pathToFileURL(evil).href,
      }),
    );
  });

  it("refuses when the cli itself is the staged/published copy, even if a fake sits beside it", async (t) => {
    // The published layout: <pkg>/build/tessera/node_modules/@tessera/cli.
    // There is no workspace here, so no resolution is trusted — including one
    // into the very node_modules the staged cli lives in.
    const root = await tempDir(t);
    const staged = path.join(root, "build", "tessera");
    const cliBuild = path.join(
      staged,
      "node_modules",
      "@tessera",
      "cli",
      "build",
    );
    await fs.mkdir(cliBuild, { recursive: true });
    const planted = await plantFakeInstance(staged);
    assertDevOnlyRefusal(() =>
      resolveDevFakeInstance({
        moduleUrl: pathToFileURL(path.join(cliBuild, "stage.js")).href,
        resolve: () => pathToFileURL(planted).href,
      }),
    );
  });

  for (const [label, manifest] of [
    ["no workspaces key", {}],
    ["an empty workspaces array", { workspaces: [] }],
  ]) {
    it(`refuses when the workspace root manifest has ${label}`, async (t) => {
      const ws = await tempDir(t);
      await fs.writeFile(
        path.join(ws, "package.json"),
        JSON.stringify(manifest),
      );
      const cliBuild = path.join(ws, "packages", "cli", "build");
      await fs.mkdir(cliBuild, { recursive: true });
      const entry = path.join(ws, "packages", "fake-instance", "index.js");
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.writeFile(entry, "export {};\n");
      assertDevOnlyRefusal(() =>
        resolveDevFakeInstance({
          moduleUrl: pathToFileURL(path.join(cliBuild, "stage.js")).href,
          resolve: () => pathToFileURL(entry).href,
        }),
      );
    });
  }

  it("accepts a well-formed workspace's own fake-instance", async (t) => {
    const ws = await tempDir(t);
    await fs.writeFile(
      path.join(ws, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    const cliBuild = path.join(ws, "packages", "cli", "build");
    await fs.mkdir(cliBuild, { recursive: true });
    const entry = path.join(
      ws,
      "packages",
      "fake-instance",
      "build",
      "index.js",
    );
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, "export {};\n");
    const url = resolveDevFakeInstance({
      moduleUrl: pathToFileURL(path.join(cliBuild, "stage.js")).href,
      resolve: () => pathToFileURL(entry).href,
    });
    assert.equal(url, pathToFileURL(entry).href);
  });

  it("turns an unresolvable fake-instance into the same dev-only refusal", () => {
    assertDevOnlyRefusal(() =>
      resolveDevFakeInstance({
        moduleUrl: IN_WORKSPACE_MODULE,
        resolve: () => {
          const error = new Error(
            "Cannot find package '@tessera/fake-instance'",
          );
          error.code = "ERR_MODULE_NOT_FOUND";
          throw error;
        },
      }),
    );
  });
});

describe("stage --fake — the refusal happens before anything is staged", () => {
  it("rejects and leaves the environment and the disk untouched", async (t) => {
    const cwd = await tempDir(t);
    const before = { ...process.env };
    const outside = await tempDir(t);
    const planted = await plantFakeInstance(outside);
    await assert.rejects(
      stage(
        {
          instanceHost: "fake.service-now.com",
          fake: true,
          variant: "correct",
          fakeProductionProperty: false,
          keepLedger: false,
        },
        cwd,
        {
          fakeInstance: {
            moduleUrl: IN_WORKSPACE_MODULE,
            resolve: () => pathToFileURL(planted).href,
          },
        },
      ),
      (error) => error.name === "UsageError",
    );
    assert.deepEqual({ ...process.env }, before);
    assert.deepEqual(await fs.readdir(cwd), []);
  });

  it("loads the module it checked, never the bare specifier again", async (t) => {
    // A well-formed workspace whose fake-instance is a marker module: if
    // `stage` re-imported `@tessera/fake-instance` by name it would get this
    // checkout's real fake and succeed; loading the checked URL hits the marker.
    const ws = await tempDir(t);
    await fs.writeFile(
      path.join(ws, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    const cliBuild = path.join(ws, "packages", "cli", "build");
    await fs.mkdir(cliBuild, { recursive: true });
    const entry = path.join(ws, "packages", "fake-instance", "index.js");
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(
      entry,
      'export function createFakeInstance() { throw new Error("checked-module-loaded"); }\n',
    );
    const cwd = await tempDir(t);
    const before = { ...process.env };
    t.after(() => {
      for (const key of Object.keys(process.env))
        if (!(key in before)) delete process.env[key];
      Object.assign(process.env, before);
    });
    await assert.rejects(
      stage(
        {
          instanceHost: "fake.service-now.com",
          fake: true,
          variant: "correct",
          fakeProductionProperty: false,
          keepLedger: false,
          ledgerRoot: path.join(cwd, "ledger"),
          docsDir: path.join(cwd, "docs"),
        },
        cwd,
        {
          fakeInstance: {
            moduleUrl: pathToFileURL(path.join(cliBuild, "stage.js")).href,
            resolve: () => pathToFileURL(entry).href,
          },
        },
      ),
      /checked-module-loaded/,
    );
  });
});

describe("tess run --skeleton --fake — end to end", () => {
  it("still runs against the workspace fake from this checkout", async (t) => {
    const ledgerRoot = await tempDir(t);
    const out = [];
    const err = [];
    const code = await main(
      ["run", "--skeleton", "--fake", "--ledger-root", ledgerRoot, "--json"],
      {
        now: () => new Date("2026-09-26T00:00:00Z"),
        actor: "test",
        cwd: ledgerRoot,
        env: {},
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      },
    );
    assert.equal(code, 0, err.join("\n"));
  });

  it("is refused with exit 2 from a staged copy of the cli, even with a fake in an ancestor node_modules", async (t) => {
    // A faithful miniature of the published tree: the cli is a real COPY (so
    // its realpath is outside the workspace), its @tessera/* dependencies are
    // links into this workspace, and an ancestor node_modules carries a
    // @tessera/fake-instance — here the genuine one, which is the stale-copy
    // case; a planted one is the attacker case and is refused the same way.
    const root = await tempDir(t);
    const scope = path.join(root, "node_modules", "@tessera");
    await fs.mkdir(scope, { recursive: true });
    const packages = await fs.readdir(path.join(WORKSPACE, "packages"));
    for (const dir of packages) {
      if (dir === "cli") continue;
      const manifest = path.join(WORKSPACE, "packages", dir, "package.json");
      if (!existsSync(manifest)) continue;
      const { name } = JSON.parse(await fs.readFile(manifest, "utf8"));
      await fs.symlink(
        path.join(WORKSPACE, "packages", dir),
        path.join(root, "node_modules", ...name.split("/")),
      );
    }
    const cliCopy = path.join(scope, "cli");
    await fs.mkdir(cliCopy);
    await fs.cp(
      path.join(CLI_DIR, "package.json"),
      path.join(cliCopy, "package.json"),
    );
    await fs.cp(path.join(CLI_DIR, "bin"), path.join(cliCopy, "bin"), {
      recursive: true,
    });
    await fs.cp(CLI_BUILD, path.join(cliCopy, "build"), { recursive: true });

    const ledgerRoot = path.join(root, "ledger");
    const result = spawnSync(
      process.execPath,
      [
        path.join(cliCopy, "bin", "tess.mjs"),
        "run",
        "--skeleton",
        "--fake",
        "--ledger-root",
        ledgerRoot,
      ],
      { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /--fake/);
    assert.match(result.stderr, /dev(elopment)?[- ]only/i);
    assert.doesNotMatch(result.stderr, /INFRASTRUCTURE FAULT/);
  });
});
