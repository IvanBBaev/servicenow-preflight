// Export-list snapshot (A-3): every value and type the package exports, per
// entry point, is pinned in test/fixtures/public-api.txt. Adding, removing or
// moving a symbol fails here until the snapshot is updated on purpose:
//
//   npm run build && UPDATE_API_SNAPSHOT=1 node --test test/api-surface.test.js
//
// Types are read from the emitted declarations with the TypeScript compiler
// (already a dev dependency), values from the modules themselves, imported
// through the package's own `exports` map.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = join(ROOT, "test", "fixtures", "public-api.txt");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Code entry points: exports with a `types` condition (not JSON files). */
const ENTRIES = Object.entries(PKG.exports)
  .filter(([, target]) => typeof target === "object" && target.types)
  .map(([subpath, target]) => ({
    subpath,
    specifier: subpath === "." ? PKG.name : `${PKG.name}/${subpath.slice(2)}`,
    dts: join(ROOT, target.types),
  }));

/** Every export of each entry's declaration file, classified value / type. */
function declaredExports() {
  const program = ts.createProgram(
    ENTRIES.map((e) => e.dts),
    {
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      noEmit: true,
    },
  );
  const checker = program.getTypeChecker();
  const out = new Map();
  for (const entry of ENTRIES) {
    const source = program.getSourceFile(entry.dts);
    assert.ok(source, `${entry.dts} is missing; run npm run build first`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    const rows = [];
    for (const sym of checker.getExportsOfModule(moduleSymbol)) {
      const target =
        sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
      // `export type { X }` re-exports stay type-only even if X is a value.
      const typeOnly = (sym.declarations ?? []).some(
        (d) =>
          ts.isExportSpecifier(d) &&
          (d.isTypeOnly || d.parent.parent.isTypeOnly),
      );
      const isValue = !typeOnly && (target.flags & ts.SymbolFlags.Value) !== 0;
      rows.push({ name: sym.getName(), kind: isValue ? "value" : "type" });
    }
    out.set(entry.subpath, rows);
  }
  return out;
}

function render(declared) {
  const lines = [];
  for (const [subpath, rows] of declared) {
    for (const row of [...rows].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      lines.push(`${subpath} ${row.kind} ${row.name}`);
    }
  }
  return lines.join("\n") + "\n";
}

const declared = declaredExports();

test("the export list matches the committed snapshot", () => {
  const actual = render(declared);
  if (process.env.UPDATE_API_SNAPSHOT === "1") {
    writeFileSync(SNAPSHOT, actual);
    return;
  }
  const expected = readFileSync(SNAPSHOT, "utf8");
  assert.equal(
    actual,
    expected,
    "Public API changed. If intended, rerun with UPDATE_API_SNAPSHOT=1 and record the change in CHANGELOG.md.",
  );
});

test("each entry point resolves through the exports map with the declared values", async () => {
  for (const entry of ENTRIES) {
    const mod = await import(entry.specifier);
    const runtime = Object.keys(mod).sort();
    const values = declared
      .get(entry.subpath)
      .filter((r) => r.kind === "value")
      .map((r) => r.name)
      .sort();
    assert.deepEqual(runtime, values, entry.specifier);
  }
});

test("the package root stays a curated core", () => {
  const root = declared.get(".");
  assert.ok(root.length <= 40, `root exports ${root.length} symbols`);
  const names = new Set(root.map((r) => r.name));
  for (const leaked of [
    "closestNames",
    "RULE_TITLES",
    "parseSeverityFlag",
    "slugify",
    "Auth",
  ]) {
    assert.ok(
      !names.has(leaked),
      `${leaked} must not be exported from the root`,
    );
  }
});
