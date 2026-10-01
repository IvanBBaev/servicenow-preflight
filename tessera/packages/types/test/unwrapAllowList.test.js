// TM-1 enforcement — which files may open the door (delegated decision
// 2026-09-23, TODO "TM-1 enforcement — a gate change").
//
// `unwrapUntrusted` is the one door out of `Untrusted<T>`, and every call is
// meant to read as a sentence explaining why THAT hostile string may cross
// THAT boundary. Until this suite, which files held such a call was upheld by
// review only: an eighth call site could appear silently, and so could the
// case review never catches — a call that was fine on the day it was written,
// in a file that later starts reading instance text. So the set of call sites
// is declared below, and adding one means adding a line here, in front of a
// reviewer.
//
// Each call must also pass a NAMED boundary constant (an UPPER_SNAKE
// identifier declared with `const` in the same file) rather than an inline
// literal: the constant is what a reviewer reads, and a literal buried in an
// argument list is the one nobody greps for.
//
// Scope and exemption, both deliberate:
//   - The scan walks `packages/*/src/**/*.ts` — the code that ships. Tests
//     unwrap freely to assert what came out of the door.
//   - The defining module, `packages/types/src/untrusted.ts`, is exempt:
//     `mapUntrusted` routes through the door with a fixed literal by design
//     (its doc comment says what that does and does not buy), and the module
//     that implements the door is not a consumer of it.
//
// Unlike every other suite in this package, this one reads SOURCE, and reads
// it sideways across the workspace — a call site is a source-level fact that
// tsc may rewrite (an aliased import compiles to a different spelling).
// Aliasing is refused outright for the same reason: `import { unwrapUntrusted
// as open }` would hide a call site from a grep, and from this suite.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));

/** The defining module: exempt, see the header. Relative to `packages/`. */
const EXEMPT = new Set(["types/src/untrusted.ts"]);

/**
 * Every unwrap in shipped code, as `<file relative to packages/> <boundary
 * constant>`, one entry per call. Sorted. Adding a call site means adding a
 * line here — that is the point.
 */
const ALLOWED_UNWRAPS = [
  // `tess run --live` (delegated decision 2026-09-23): a repo spec body is
  // unwrapped only as `verdict.cleared.source`, after the TM-3 gate passed it,
  // to become the ATF step script the store projects — the writer.ts pattern.
  "cli/src/liveSpecs.ts PROJECTION_BOUNDARY",
  "generate/src/gate.ts GATE_BOUNDARY",
  "generate/src/prompt.ts PROMPT_BOUNDARY",
  "generate/src/provider.ts PARSE_BOUNDARY",
  "generate/src/quality.ts QUALITY_BOUNDARY",
  "generate/src/writer.ts WRITE_BOUNDARY",
  "impact/src/scan.ts SCAN_BOUNDARY",
];

/** Every `.ts` file under `dir`, recursively. */
function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * Comments are not call sites: many files explain the door in prose. A crude
 * strip — block comments, then `//` comments not preceded by `:` (a URL) or
 * a quote. Crude in the safe direction: anything it fails to strip shows up
 * as an extra call site, loudly, never as a missing one.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * Scan `packagesDir/*\/src` for unwraps. Returns the sorted call-site list in
 * the ALLOWED_UNWRAPS format plus a list of rule violations (aliased import,
 * literal boundary, undeclared constant, unparsable call).
 */
function scanUnwraps(packagesDir) {
  const sites = [];
  const violations = [];
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(packagesDir, pkg.name, "src");
    let files;
    try {
      files = tsFiles(src);
    } catch {
      continue; // a package without src/ holds no call sites
    }
    for (const file of files) {
      const rel = relative(packagesDir, file).split(sep).join("/");
      if (EXEMPT.has(rel)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (/\bunwrapUntrusted\s+as\b/.test(code)) {
        violations.push(`${rel}: aliased import of unwrapUntrusted`);
      }
      for (const match of code.matchAll(/\bunwrapUntrusted\s*\(/g)) {
        const call = code.slice(match.index + match[0].length);
        const args = /^\s*[^,()]+?\s*,\s*([^,()]+?)\s*,?\s*\)/.exec(call);
        if (args === null) {
          violations.push(`${rel}: unparsable unwrapUntrusted call`);
          sites.push(`${rel} <unparsed>`);
          continue;
        }
        const boundary = args[1];
        sites.push(`${rel} ${boundary}`);
        if (!/^[A-Z][A-Z0-9_]*$/.test(boundary)) {
          violations.push(
            `${rel}: boundary ${boundary} is not a named UPPER_SNAKE constant`,
          );
        } else if (!new RegExp(`\\bconst ${boundary}\\s*=`).test(code)) {
          violations.push(
            `${rel}: boundary ${boundary} is not declared with const in this file`,
          );
        }
      }
    }
  }
  return { sites: sites.sort(), violations };
}

/** The assertion the real suite makes, shared with the negative fixtures. */
function assertAllowed(packagesDir) {
  const { sites, violations } = scanUnwraps(packagesDir);
  assert.deepEqual(violations, [], "unwrapUntrusted call-site rule violated");
  assert.deepEqual(
    sites,
    ALLOWED_UNWRAPS,
    "unwrapUntrusted call sites differ from ALLOWED_UNWRAPS (TM-1)",
  );
}

describe("TM-1 unwrap call-site allow-list", () => {
  it("every unwrapUntrusted call in packages/*/src is declared", () => {
    assertAllowed(PACKAGES);
  });

  it("the allow-list is sorted and has no duplicate lines", () => {
    // Duplicates are legal in principle (two calls, one file, one constant),
    // but none exist today; a duplicate line is far more likely a merge slip.
    assert.deepEqual(ALLOWED_UNWRAPS, [...new Set(ALLOWED_UNWRAPS)].sort());
  });

  // The negative fixtures run the SAME scanner against a throwaway copy of
  // the workspace shape in the OS temp dir, so no other package's `src/` is
  // ever touched by a test run. Each is created and removed in one process,
  // with the removal in a `finally`.
  const cases = [
    [
      "an undeclared eighth call site",
      'import { unwrapUntrusted } from "@tessera/types";\nconst ROGUE_BOUNDARY = "x";\nexport const f = (v) => unwrapUntrusted(v, ROGUE_BOUNDARY);\n',
      /differ from ALLOWED_UNWRAPS/,
    ],
    [
      "an inline literal boundary",
      'import { unwrapUntrusted } from "@tessera/types";\nexport const f = (v) => unwrapUntrusted(v, "because");\n',
      /not a named UPPER_SNAKE constant/,
    ],
    [
      "an aliased import",
      'import { unwrapUntrusted as open } from "@tessera/types";\nexport const f = (v) => open(v, "x");\n',
      /aliased import/,
    ],
  ];
  for (const [label, rogue, expected] of cases) {
    it(`fails on ${label}`, () => {
      const root = mkdtempSync(join(tmpdir(), "tessera-unwrap-"));
      try {
        // Mirror the real call sites so only the rogue file differs.
        for (const line of ALLOWED_UNWRAPS) {
          const [file, boundary] = line.split(" ");
          const path = join(root, ...file.split("/"));
          mkdirSync(join(path, ".."), { recursive: true });
          writeFileSync(
            path,
            `const ${boundary} = "b";\nexport const f = (v) => unwrapUntrusted(v, ${boundary});\n`,
          );
        }
        assertAllowed(root); // the mirror alone is clean
        const rogueDir = join(root, "rogue", "src");
        mkdirSync(rogueDir, { recursive: true });
        writeFileSync(join(rogueDir, "leak.ts"), rogue);
        assert.throws(() => assertAllowed(root), { message: expected });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("does not count prose about the door as a call site", () => {
    const root = mkdtempSync(join(tmpdir(), "tessera-unwrap-"));
    try {
      const dir = join(root, "prose", "src");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "notes.ts"),
        "// never call unwrapUntrusted(x, y) here\n/* nor unwrapUntrusted(a, b) */\nexport {};\n",
      );
      assert.deepEqual(scanUnwraps(root), { sites: [], violations: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
