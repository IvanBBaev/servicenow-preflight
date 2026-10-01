// Every workspace barrel names its public surface; none of it arrives through
// a bare `export * from`.
//
// This pins the PROPERTY, not the current list of names. The explicit barrels
// state the reason (packages/generate/src/index.ts): the exports are listed one
// by one "so the public surface is a decision made here and not a side effect
// of what a module happened to export". A bare `export *` re-opens exactly that
// side effect, so every re-export must carry an export clause. `export * as ns`
// has one — a namespace export is a single name chosen here — and passes.
//
// Only the parser is used, not a type-checked program: the property is purely
// syntactic, so this suite needs no build and cannot be satisfied by one.
//
// WHY @tessera/cli HOSTS IT: the same reasons bareSpecifierResolution.test.js
// gives — the composition root already hosts the cross-package invariants.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import ts from "typescript";

/** The workspace root, resolved from this file so a moved checkout still finds it. */
const ROOT = new URL("../../../", import.meta.url);

/**
 * Every workspace package directory, read from the root `workspaces` globs.
 * Nothing is transcribed, so a new package is covered the day it is added.
 */
function workspacePackageDirs() {
  const root = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
  const patterns = root.workspaces;
  assert.ok(
    Array.isArray(patterns) && patterns.length > 0,
    "the workspace root declares no `workspaces`",
  );

  const dirs = [];
  for (const pattern of patterns) {
    // Only the `<dir>/*` shape is understood. Anything else must fail loudly:
    // quietly yielding fewer packages would turn this suite into a pass.
    const match = /^(.+)\/\*$/.exec(pattern);
    assert.ok(
      match,
      `unsupported \`workspaces\` pattern ${JSON.stringify(pattern)} — this ` +
        "suite only expands `<dir>/*` and would otherwise skip it in silence",
    );
    const parent = new URL(`${match[1]}/`, ROOT);
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = new URL(`${entry.name}/`, parent);
      if (existsSync(new URL("package.json", dir))) {
        dirs.push({ label: `${match[1]}/${entry.name}`, dir });
      }
    }
  }
  return dirs.sort((a, b) => (a.label < b.label ? -1 : 1));
}

const PACKAGES = workspacePackageDirs();

describe("every workspace barrel lists its exports explicitly", () => {
  it("derived a usable package list from the workspace manifest", () => {
    // Without this, an empty expansion would report a green suite with zero
    // cases — a vacuous pass.
    assert.ok(
      PACKAGES.length > 0,
      "no packages were derived from the `workspaces` patterns, so every " +
        "case below would pass vacuously",
    );
  });

  for (const { label, dir } of PACKAGES) {
    it(`${label}/src/index.ts has no bare \`export * from\``, () => {
      const file = new URL("src/index.ts", dir);
      assert.ok(existsSync(file), `${label} has no src/index.ts barrel`);
      const source = ts.createSourceFile(
        file.pathname,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );

      let inspected = 0;
      const bare = [];
      for (const statement of source.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) {
          continue;
        }
        inspected++;
        if (!statement.exportClause) {
          const { line } = source.getLineAndCharacterOfPosition(
            statement.getStart(source),
          );
          bare.push(`line ${line + 1}: ${statement.getText(source)}`);
        }
      }

      // A barrel with no re-exports at all would pass the check below for
      // free; every barrel here re-exports, so zero means the parse went wrong.
      assert.ok(inspected > 0, `${label}: no re-export declaration inspected`);
      assert.deepEqual(
        bare,
        [],
        `${label}/src/index.ts re-exports through a bare \`export *\`, so its ` +
          "public surface is whatever those modules happen to export",
      );
    });
  }
});
