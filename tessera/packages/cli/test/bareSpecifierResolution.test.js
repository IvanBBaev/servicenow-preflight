// Every workspace package is importable by its own bare specifier.
//
// This pins RESOLUTION, nothing else. For most packages some other suite
// already imports them by name and would notice a broken `exports`/`main` or a
// missing `build/`; for a few, nothing would. `@tessera/mcp` is the extreme
// case — outside the lockfile, the root `build:all` script and a handful of
// `describe()` titles, no file in this tree names it as a specifier at all, so
// until this suite existed the fact that `import("@tessera/mcp")` resolves was
// asserted by nothing. `@tessera/parity`, `@tessera/reporter` and
// `@tessera/specs` each have exactly one importer, which is one deletion away
// from the same state; `@tessera/store` has none left since `@tessera/reporter`
// stopped depending on it, so this suite is the only thing that resolves it.
//
// The `"./*"` subpath wildcard is gone from every manifest: each `exports` map
// now carries only the `"."` entry (plus `@tessera/fake-instance`'s JSON
// fixtures, which are data, not code). So the `src/index.ts` barrel behind
// the bare specifier is the ONLY way into a package's code, and "resolves by
// its bare specifier" covers its whole public surface, not a sample of it.
//
// WHY @tessera/cli HOSTS IT. Two reasons read off the tree, not off taste.
// First, this package already declares 19 of the 22 workspaces — 18 as
// `dependencies`, `@tessera/fake-instance` as a `devDependency` — which is the
// smallest undeclared remainder of any package here: itself, `@tessera/mcp`
// and `@tessera/store`. Second, there is precedent: tablePathAgreement.test.js
// is a cross-package invariant hosted here for the same reason, that the
// composition root is the package that already sees the others.
//
// THE UNDECLARED EDGE, STATED PLAINLY. The two foreign names above are NOT in
// this package's manifest and must not be added. `@tessera/mcp` depends on
// `@tessera/cli`, so declaring it would invert the one edge the composition
// root is defined by; `@tessera/store` is a false edge — nothing in `src/`
// uses it. They resolve anyway because npm workspaces links every workspace
// into the root `node_modules/@tessera/`, and Node's lookup walks up to it
// from here. That was verified by running the import, not assumed.
//
// The cost of that is worth naming: because resolution goes through the
// workspace link farm rather than through this manifest, this suite CANNOT
// catch a missing `dependencies` entry. It catches a broken `exports` map, a
// `main` pointing at nothing, an unbuilt package and a build that produced an
// empty module. Every package here is `private: true` and never published, so
// the link farm is the real resolution mechanism and those are the real
// failure modes.
//
// It also deliberately does NOT snapshot export names — that is a different
// pin, and one owned elsewhere. The count is only a floor: a module that
// resolves to nothing has not really resolved.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/** The workspace root, resolved from this file so a moved checkout still finds it. */
const ROOT = new URL("../../../", import.meta.url);

/**
 * Every workspace package's `name`, read from the manifests the workspace
 * itself points at. Nothing here is transcribed: a hand-written list of twenty
 * names would go stale the first time a package is added, renamed or dropped,
 * and would go stale silently — which is the exact defect class this suite
 * exists to close.
 */
function workspacePackageNames() {
  const root = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
  const patterns = root.workspaces;
  assert.ok(
    Array.isArray(patterns) && patterns.length > 0,
    "the workspace root declares no `workspaces`",
  );

  const names = [];
  for (const pattern of patterns) {
    // Only the `<dir>/*` shape is understood. Anything else must fail loudly:
    // quietly yielding fewer packages would turn this suite into a pass.
    const match = /^(.+)\/\*$/.exec(pattern);
    assert.ok(
      match,
      `unsupported \`workspaces\` pattern ${JSON.stringify(pattern)} — this ` +
        "suite only expands `<dir>/*` and would otherwise skip it in silence",
    );
    const dir = new URL(`${match[1]}/`, ROOT);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = new URL(`${entry.name}/package.json`, dir);
      if (!existsSync(manifest)) continue;
      const name = JSON.parse(readFileSync(manifest, "utf8")).name;
      assert.ok(
        typeof name === "string" && name.length > 0,
        `${entry.name}/package.json has no usable \`name\``,
      );
      names.push(name);
    }
  }
  return names.sort();
}

const PACKAGE_NAMES = workspacePackageNames();

describe("every workspace package resolves by its bare specifier", () => {
  it("derived a usable package list from the workspace manifest", () => {
    // Without this, an empty expansion would report a green suite with zero
    // cases — the same silent pass the root `test:run` comment warns about.
    assert.ok(
      PACKAGE_NAMES.length > 0,
      "no packages were derived from the `workspaces` patterns, so every " +
        "case below would pass vacuously",
    );
    assert.equal(
      new Set(PACKAGE_NAMES).size,
      PACKAGE_NAMES.length,
      "two workspaces declare the same `name`, so one of them is untested " +
        "here no matter what the cases below report",
    );
  });

  for (const name of PACKAGE_NAMES) {
    it(`${name} resolves and is not an empty module`, async () => {
      let namespace;
      try {
        namespace = await import(name);
      } catch (error) {
        assert.fail(
          `import(${JSON.stringify(name)}) did not resolve: ` +
            `${error.code ?? "no error code"} — ` +
            `${error.message.split("\n")[0]}`,
        );
      }
      assert.ok(
        Object.keys(namespace).length > 0,
        `import(${JSON.stringify(name)}) resolved to a module with no ` +
          "exports at all",
      );
    });
  }
});
