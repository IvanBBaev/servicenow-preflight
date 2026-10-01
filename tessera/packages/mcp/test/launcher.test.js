// The shipped `bin/` launcher must still resolve against the built output.
//
// `packages/mcp/package.json` publishes `tessera-mcp` as `bin/tessera-mcp.mjs`,
// and that file is a single named import away from being dead: `import { run }
// from "../build/server.js"`. Nothing else in the gate looks at it. The package
// tsconfig includes `src/**/*` only, so tsc never sees `bin/`; the suites here
// import from `../build/index.js`, never from `build/server.js`; and ESLint —
// which does lint the launcher — checks syntax, not whether an imported symbol
// exists. So renaming `run` in `src/server.ts` leaves the whole workspace green
// while the host's `tessera-mcp` dies on its first line with `SyntaxError: …
// does not provide an export named 'run'` — and a host that cannot start the
// server sees exactly the silent channel this package is built to avoid.
//
// The property asserted here is "every named import in the shipped launcher
// resolves to a function in the built output". The specifier and the imported
// names are PARSED OUT of the launcher rather than written here as literals:
// a test spelling `"../build/server.js"` and `"run"` would pin today's
// behaviour instead of the property, and would keep passing the moment the
// launcher started importing something else.
//
// Deliberately a copy of `cli/test/launcher.test.js` rather than a shared
// helper: each package has to be able to fail on ITS OWN launcher with only
// its own files, and the only surface `@tessera/cli` exports is its `build/`,
// which is precisely the thing under test here.
//
// This reads `build/`, which is this workspace's test convention (README.md:50
// — "build before testing"). A missing `build/` is therefore reported as a
// missing build, in those words, and never as a missing export.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** This package's root, resolved from this file so a moved checkout still finds it. */
const PKG = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", PKG), "utf8"));

/**
 * Line comments, blanked where they START a line. Deliberately not a general
 * comment stripper: blanking `//` wherever it appeared would eat the `//` of a
 * URL-shaped specifier. The launchers are a header comment plus one statement;
 * anything needing more parsing than this belongs in `src/`, which is typed.
 */
const uncommented = (text) =>
  text
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");

/** Static `import <clause> from "<specifier>"` statements, in source order. */
function staticImports(text) {
  const statements = /\bimport\s+([^;]*?)\s+from\s+["']([^"']+)["']/g;
  return [...uncommented(text).matchAll(statements)].map((m) => ({
    clause: m[1].trim(),
    specifier: m[2],
  }));
}

/** The `{ a, b as c }` part of a clause, as `imported`/`local` pairs. */
function namedBindings(clause) {
  const braces = /\{([^}]*)\}/.exec(clause);
  if (!braces) return [];
  return braces[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [imported, local] = entry.split(/\s+as\s+/).map((s) => s.trim());
      return { imported, local: local ?? imported };
    });
}

/** Every (launcher, specifier, named bindings) triple this package ships. */
const LAUNCHERS = Object.entries(pkg.bin ?? {}).flatMap(([command, rel]) => {
  const url = new URL(rel, PKG);
  return staticImports(readFileSync(url, "utf8")).map((statement) => ({
    command,
    rel,
    url,
    ...statement,
    named: namedBindings(statement.clause),
  }));
});

describe("the shipped bin launcher", () => {
  it("has a named import to check — otherwise this suite asserts nothing", () => {
    assert.ok(
      Object.keys(pkg.bin ?? {}).length > 0,
      `${pkg.name} declares no "bin" — this suite's premise is gone, not satisfied`,
    );
    const named = LAUNCHERS.flatMap((l) => l.named);
    assert.ok(
      named.length > 0,
      `no named import was parsed out of ${LAUNCHERS.map((l) => l.rel).join(", ") || "(no launcher)"} — ` +
        `a launcher rewritten to a default or namespace import makes the checks below vacuous; extend the parser`,
    );
  });

  for (const launcher of LAUNCHERS) {
    const { command, rel, url, specifier, named } = launcher;
    it(`${command}: every named import ${rel} takes from "${specifier}" is a function there`, async () => {
      // A relative specifier is resolved against the LAUNCHER, not this file —
      // that is the resolution Node performs when the bin is invoked. A bare
      // specifier is imported as written; this file sits in the same package,
      // so it sees the same node_modules chain the launcher would.
      const relative = specifier.startsWith(".") || specifier.startsWith("/");
      const target = relative ? new URL(specifier, url) : specifier;
      if (relative) {
        assert.ok(
          existsSync(target),
          `${rel} imports "${specifier}", which resolves to ${fileURLToPath(target)} — no such file. ` +
            `If build/ is missing, build before testing (README.md:50); these suites read the built output.`,
        );
      }
      const module = await import(relative ? target.href : target);
      const exported = Object.keys(module).sort();
      for (const { imported } of named) {
        assert.ok(
          imported in module,
          `${rel} imports { ${imported} } from "${specifier}", which exports no "${imported}" — ` +
            `the launcher throws on its first line. "${specifier}" exports: ${exported.join(", ") || "(nothing)"}`,
        );
        assert.equal(
          typeof module[imported],
          "function",
          `${rel} calls ${imported}(), but "${imported}" from "${specifier}" is a ${typeof module[imported]}`,
        );
      }
    });
  }
});
