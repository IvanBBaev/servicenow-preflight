// Ported from github.com/IvanBBaev/syncrona @ 73cae76
// (packages/core/src/tests/fileUtilsPure.test.ts, fileUtilsWrite.test.ts,
// fileUtilsDepth.test.ts). GPL-3.0 upstream; dual-licensed for this use by the
// sole author/copyright owner (ADR-002 option 4).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Adaptations: jest → node:test/assert. Upstream mocked the ConfigManager
// module (jest.unstable_mockModule) because FileUtils read config singletons;
// the vendored copy takes a `createFileUtils(options)` factory, so the config
// accessors are passed as plain stubs and no module mocking is needed. The
// fs.promises.writeFile retry spy uses node:test's mock.method — it patches the
// same `fs.promises` object the vendored module aliases as `fsp`.
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isUnderPath,
  toAbsolutePath,
  splitEncodedPaths,
  summarizeFile,
  appendToPath,
  withRetry,
  writeFileForce,
  createFileUtils,
} from "../build/FileUtils.js";
import { PATH_DELIMITER } from "../build/support.js";

const quietLogger = { warn: () => {}, debug: () => {} };

/** Factory handle whose four config accessors all point at `root`. */
function utilsAt(root) {
  return createFileUtils({
    getManifestPath: () => path.join(root, "syncrona.manifest.json"),
    getSourcePath: () => root,
    getBuildPath: () => root,
    getManifest: () => undefined,
    logger: quietLogger,
  });
}

describe("isUnderPath", () => {
  it("returns true when the child sits under the parent", () => {
    const parent = path.join(path.sep, "a", "b");
    const child = path.join(path.sep, "a", "b", "c", "d");
    assert.equal(isUnderPath(parent, child), true);
  });

  it("returns false when the child diverges from the parent", () => {
    const parent = path.join(path.sep, "a", "b");
    const child = path.join(path.sep, "a", "x");
    assert.equal(isUnderPath(parent, child), false);
  });

  it("treats an identical path as under itself", () => {
    const p = path.join(path.sep, "a", "b");
    assert.equal(isUnderPath(p, p), true);
  });

  it("ignores a trailing separator on the parent", () => {
    const parent = path.join(path.sep, "a", "b") + path.sep;
    const child = path.join(path.sep, "a", "b", "c");
    assert.equal(isUnderPath(parent, child), true);
  });

  it("ignores doubled separators in either path", () => {
    const parent = `${path.sep}a${path.sep}${path.sep}b`;
    const child = path.join(path.sep, "a", "b", "c");
    assert.equal(isUnderPath(parent, child), true);
  });

  // #19: Windows path normalization, made portable by feeding literal
  // Windows-shaped inputs (backslashes, drive letters, mixed separators). These
  // used to hinge on path.sep, so on a POSIX host a "\\"-separated path
  // collapsed into one token and containment silently misfired. They now split
  // on either separator, so the same logic holds on both platforms.
  describe("cross-platform separators (#19)", () => {
    it("recognizes containment for pure backslash (Windows) paths", () => {
      assert.equal(
        isUnderPath("C:\\proj\\src", "C:\\proj\\src\\table\\rec.js"),
        true,
      );
    });

    it("rejects a divergent branch under a backslash parent", () => {
      assert.equal(
        isUnderPath("C:\\proj\\src", "C:\\proj\\other\\rec.js"),
        false,
      );
    });

    it("matches a parent and child that mix separators (git '/' under Node '\\')", () => {
      // git and globs emit forward slashes even on Windows, where Node builds
      // paths with backslashes — the two must still line up.
      assert.equal(
        isUnderPath("C:\\proj\\src", "C:/proj/src/table/rec.js"),
        true,
      );
      assert.equal(
        isUnderPath("C:/proj/src", "C:\\proj\\src\\table\\rec.js"),
        true,
      );
    });

    it("ignores a trailing backslash on the parent", () => {
      assert.equal(
        isUnderPath("C:\\proj\\src\\", "C:\\proj\\src\\table\\rec.js"),
        true,
      );
    });
  });
});

describe("toAbsolutePath", () => {
  it("returns an absolute path unchanged", () => {
    const abs = path.join(path.sep, "already", "absolute");
    assert.equal(toAbsolutePath(abs), abs);
  });

  it("resolves a relative path against the cwd", () => {
    assert.equal(
      toAbsolutePath("rel/dir"),
      path.join(process.cwd(), "rel/dir"),
    );
  });
});

describe("splitEncodedPaths", () => {
  it("splits on the delimiter and drops empty segments", () => {
    const encoded = ["/a", "", "/b", "/c"].join(PATH_DELIMITER);
    assert.deepEqual(splitEncodedPaths(encoded), ["/a", "/b", "/c"]);
  });

  it("returns an empty array for an empty string", () => {
    assert.deepEqual(splitEncodedPaths(""), []);
  });
});

describe("summarizeFile", () => {
  it("renders table/record/sys_id", () => {
    const ctx = {
      tableName: "sys_script_include",
      name: "MyUtil",
      sys_id: "abc123",
    };
    assert.equal(summarizeFile(ctx), "sys_script_include/MyUtil/abc123");
  });
});

describe("appendToPath", () => {
  it("joins a suffix onto the curried prefix", () => {
    assert.equal(appendToPath("base")("leaf"), path.join("base", "leaf"));
  });
});

describe("writeSNFileCurry", () => {
  it("does not overwrite existing file when checkExists=true", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-fileutils-"));
    const filePath = path.join(root, "script.js");
    fs.writeFileSync(filePath, "original");

    const writeIfMissing = utilsAt(root).writeSNFileCurry(true);
    await writeIfMissing(
      { name: "script", type: "js", content: "new-content" },
      root,
    );

    assert.equal(fs.readFileSync(filePath, "utf8"), "original");
  });

  it("overwrites existing file when checkExists=false", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-fileutils-"));
    const filePath = path.join(root, "script.js");
    fs.writeFileSync(filePath, "original");

    const writeAlways = utilsAt(root).writeSNFileCurry(false);
    await writeAlways(
      { name: "script", type: "js", content: "new-content" },
      root,
    );

    assert.equal(fs.readFileSync(filePath, "utf8"), "new-content");
  });

  it("refuses a write that escapes the source root (INJ-1)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-fileutils-"));
    const sourceRoot = path.join(root, "src");
    const outside = path.join(root, "outside");
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(outside);

    const handle = createFileUtils({
      getManifestPath: () => path.join(root, "syncrona.manifest.json"),
      getSourcePath: () => sourceRoot,
      getBuildPath: () => sourceRoot,
      getManifest: () => undefined,
      logger: quietLogger,
    });

    // parentPath sits outside the loaded source root, so the anchor (the source
    // root) rejects the resolved target even though the parent itself exists.
    await assert.rejects(
      handle.writeSNFileForce(
        { name: "evil", type: "js", content: "x" },
        outside,
      ),
      /outside the workspace source root/,
    );
    assert.equal(fs.existsSync(path.join(outside, "evil.js")), false);
  });
});

describe("withRetry", () => {
  it("retries transient failure and succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("transient");
        }
        return "ok";
      },
      3,
      0,
    );

    assert.equal(result, "ok");
    assert.equal(attempts, 3);
  });

  it("throws after retry budget is exhausted", async () => {
    await assert.rejects(
      withRetry(
        async () => {
          throw new Error("fail");
        },
        1,
        0,
      ),
      /fail/,
    );
  });
});

describe("writeFileForce", () => {
  it("retries write operation on transient failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-fileutils-"));
    const filePath = path.join(root, "retry.txt");
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    let attempts = 0;

    const spy = mock.method(fs.promises, "writeFile", async (...args) => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("busy");
      }
      return realWriteFile(...args);
    });

    try {
      await writeFileForce(filePath, "hello");
    } finally {
      spy.mock.restore();
    }

    assert.equal(attempts, 2);
    assert.equal(fs.readFileSync(filePath, "utf8"), "hello");
  });
});

describe("getPathsInPath depth guard", () => {
  it("does not traverse deeper than 20 levels", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-depth-"));
    const handle = utilsAt(root);

    const shallowFile = path.join(root, "level0.txt");
    fs.writeFileSync(shallowFile, "ok", "utf8");

    let current = root;
    for (let i = 1; i <= 25; i += 1) {
      current = path.join(current, `d${i}`);
      fs.mkdirSync(current, { recursive: true });
    }

    const deepFile = path.join(current, "too-deep.txt");
    fs.writeFileSync(deepFile, "skip", "utf8");

    const found = await handle.getPathsInPath(root);

    assert.ok(found.includes(path.resolve(shallowFile)));
    assert.ok(!found.includes(path.resolve(deepFile)));
  });
});

// W5a finding 2: the INJ-1 guard was lexical only, and fsp.writeFile follows
// symlinks, so a symlinked directory (or leaf) inside the source root carried
// server-controlled content outside it. Each case below reproduces that and
// failed before the fix (review-w5a/sym1.mjs).
describe("writeSNFileCurry symlink containment (W5a #2)", () => {
  /** A temp tree `<base>/ws/src` (source root) plus a sibling `<base>/outside`. */
  function tree() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-sym-"));
    const sourceRoot = path.join(base, "ws", "src");
    const outside = path.join(base, "outside");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(outside);
    return { base, sourceRoot, outside, handle: utilsAt(sourceRoot) };
  }

  it("refuses a write through a symlinked directory inside the source root", async () => {
    const { sourceRoot, outside, handle } = tree();
    const linkedDir = path.join(sourceRoot, "x_acme");
    fs.symlinkSync(outside, linkedDir, "dir");

    await assert.rejects(
      handle.writeSNFileForce(
        { name: "pwned", type: "js", content: "server-controlled content" },
        linkedDir,
      ),
      /outside the workspace source root/,
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  it("refuses a write through a symlinked directory nested below the source root", async () => {
    const { sourceRoot, outside, handle } = tree();
    fs.symlinkSync(outside, path.join(sourceRoot, "x_acme"), "dir");
    fs.mkdirSync(path.join(outside, "sys_script_include"));
    const parent = path.join(sourceRoot, "x_acme", "sys_script_include");

    await assert.rejects(
      handle.writeSNFileIfNotExists(
        { name: "pwned", type: "js", content: "x" },
        parent,
      ),
      /outside the workspace source root/,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(outside, "sys_script_include")),
      [],
    );
  });

  it("refuses to follow a symlink at the leaf (force write)", async () => {
    const { sourceRoot, outside, handle } = tree();
    const target = path.join(outside, "victim.js");
    fs.writeFileSync(target, "untouched");
    fs.symlinkSync(target, path.join(sourceRoot, "script.js"));

    await assert.rejects(
      handle.writeSNFileForce(
        { name: "script", type: "js", content: "server-controlled" },
        sourceRoot,
      ),
    );
    assert.equal(fs.readFileSync(target, "utf8"), "untouched");
  });

  it("refuses to follow a leaf symlink to an empty file when checkExists=true", async () => {
    // SNFileExists treats a zero-byte target as missing, so the write proceeds —
    // and must still not land on the symlink's target.
    const { sourceRoot, outside, handle } = tree();
    const target = path.join(outside, "empty.js");
    fs.writeFileSync(target, "");
    fs.symlinkSync(target, path.join(sourceRoot, "script.js"));

    await assert.rejects(
      handle.writeSNFileIfNotExists(
        { name: "script", type: "js", content: "server-controlled" },
        sourceRoot,
      ),
    );
    assert.equal(fs.readFileSync(target, "utf8"), "");
  });

  it("refuses a dangling leaf symlink that points outside the root", async () => {
    const { sourceRoot, outside, handle } = tree();
    const target = path.join(outside, "created-by-follow.js");
    fs.symlinkSync(target, path.join(sourceRoot, "script.js"));

    await assert.rejects(
      handle.writeSNFileIfNotExists(
        { name: "script", type: "js", content: "server-controlled" },
        sourceRoot,
      ),
    );
    assert.equal(fs.existsSync(target), false);
  });

  it("still writes when the source root itself is reached through a symlink", async () => {
    const { base, sourceRoot } = tree();
    const aliasRoot = path.join(base, "alias");
    fs.symlinkSync(sourceRoot, aliasRoot, "dir");
    fs.mkdirSync(path.join(sourceRoot, "tbl"));

    await utilsAt(aliasRoot).writeSNFileForce(
      { name: "script", type: "js", content: "ok" },
      path.join(aliasRoot, "tbl"),
    );
    assert.equal(
      fs.readFileSync(path.join(sourceRoot, "tbl", "script.js"), "utf8"),
      "ok",
    );
  });

  it("does not clobber a file that appears after the existence check (checkExists=true)", async () => {
    // Simulates the race: SNFileExists sees nothing, then another writer puts real
    // content at the leaf before the open. The exclusive (O_EXCL) create must lose
    // that race rather than truncate the newcomer.
    const { sourceRoot, handle } = tree();
    const filePath = path.join(sourceRoot, "script.js");
    fs.writeFileSync(filePath, "arrived first");
    const realStat = fs.promises.stat;
    const statSpy = mock.method(fs.promises, "stat", async (p, ...rest) => {
      if (path.basename(String(p)) === "script.js") {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return realStat.call(fs.promises, p, ...rest);
    });
    try {
      await handle.writeSNFileIfNotExists(
        { name: "script", type: "js", content: "server-controlled" },
        sourceRoot,
      );
    } finally {
      statSpy.mock.restore();
    }
    assert.equal(fs.readFileSync(filePath, "utf8"), "arrived first");
  });

  it("still fills a zero-byte placeholder when checkExists=true", async () => {
    const { sourceRoot, handle } = tree();
    const filePath = path.join(sourceRoot, "script.js");
    fs.writeFileSync(filePath, "");

    await handle.writeSNFileIfNotExists(
      { name: "script", type: "js", content: "fetched" },
      sourceRoot,
    );
    assert.equal(fs.readFileSync(filePath, "utf8"), "fetched");
  });

  it("creates a missing file when checkExists=true", async () => {
    const { sourceRoot, handle } = tree();
    await handle.writeSNFileIfNotExists(
      { name: "fresh", type: "js", content: "new" },
      sourceRoot,
    );
    assert.equal(
      fs.readFileSync(path.join(sourceRoot, "fresh.js"), "utf8"),
      "new",
    );
  });
});

// W5a finding 5 (FileUtils half): the manifest temp file was named only by pid,
// so two writes in one process shared it, and a pre-planted file (or symlink)
// at that predictable name was written through and then renamed into place.
describe("writeManifestFile temp file (W5a #5)", () => {
  it("never writes through a pre-planted file at the old pid-only temp name", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-man-"));
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(outside, "untouched");
    const manifestPath = path.join(root, "syncrona.manifest.json");
    fs.symlinkSync(outside, `${manifestPath}.${process.pid}.tmp`);

    await utilsAt(root).writeManifestFile({ scope: "x_demo", tables: {} });

    assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
    assert.equal(fs.lstatSync(manifestPath).isSymbolicLink(), false);
    assert.equal(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")).scope,
      "x_demo",
    );
  });

  it("opens the temp file exclusively (wx) under a per-write unique name", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-man-"));
    const manifestPath = path.join(root, "syncrona.manifest.json");
    const seen = [];
    const realWriteFile = fs.promises.writeFile;
    const spy = mock.method(fs.promises, "writeFile", (p, data, opts) => {
      seen.push({ p: String(p), opts });
      return realWriteFile.call(fs.promises, p, data, opts);
    });
    try {
      const handle = utilsAt(root);
      await handle.writeManifestFile({ scope: "a", tables: {} });
      await handle.writeManifestFile({ scope: "b", tables: {} });
    } finally {
      spy.mock.restore();
    }
    const temps = seen.filter((c) => c.p.startsWith(`${manifestPath}.`));
    assert.equal(temps.length, 2);
    assert.notEqual(temps[0].p, temps[1].p);
    for (const t of temps) assert.equal(t.opts?.flag, "wx");
  });

  it("keeps concurrent writes in one process apart and leaves no temp behind", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-man-"));
    const handle = utilsAt(root);
    const scopes = Array.from({ length: 16 }, (_, i) => `x_scope_${i}`);

    await Promise.all(
      scopes.map((scope) => handle.writeManifestFile({ scope, tables: {} })),
    );

    const manifestPath = path.join(root, "syncrona.manifest.json");
    const written = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.ok(scopes.includes(written.scope));
    assert.deepEqual(
      fs.readdirSync(root).filter((n) => n.endsWith(".tmp")),
      [],
    );
  });
});
