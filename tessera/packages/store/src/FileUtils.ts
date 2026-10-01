// Vendored from github.com/IvanBBaev/syncrona @ 73cae76 (packages/core/src/FileUtils.ts).
// GPL-3.0 upstream; dual-licensed for this use by the sole author/copyright owner (ADR-002 option 4).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Adaptations (see VENDORED.md): upstream reads the ConfigManager and Logger
// module singletons; here every config-dependent function lives on a
// `createFileUtils(options)` factory with the four config accessors and the
// logger injected. Pure path/fs helpers stay module-level exports. Unused catch
// bindings are dropped (this workspace lints with caughtErrors: "all"), and the
// manifest lookups are guarded explicitly to satisfy noUncheckedIndexedAccess.
// In `getFileContextFromPath` the explicit guard reproduces upstream's
// `undefined` for an absent table or record — upstream reached the same answer
// by letting the index throw inside `try {…} catch { return undefined; }`. That
// wrapper is not carried over, so the two diverge for anything else that threw
// inside it: a table entry whose `records` map is missing, or a record whose
// `files` is not an array, returned `undefined` upstream and throws a
// `TypeError` out of this copy. Nothing in this workspace calls
// `getFileContextFromPath`, so that divergence is a re-vendoring hazard rather
// than a live defect. Behaviour is likewise NOT identical in
// `getBuildExt`: upstream indexed `.tables[table].records[recordName]` unguarded
// and outside any catch, so an absent table or record threw a `TypeError`; the
// optional chain here reaches the `Error("Unable to find file")` that upstream
// raised only for an absent field. Nothing in this package calls `getBuildExt`,
// so no caller observes the difference — but a future reconciliation with
// upstream would, which is why the blanket equivalence claim is gone.

import { randomUUID } from "crypto";
import fs, { promises as fsp } from "fs";
import path from "path";
import { SN, Sync } from "./types.js";
import {
  PATH_DELIMITER,
  FLAT_FIELD_SEPARATOR,
  isFlatEncoded,
  isSafePathComponent,
  StoreLogger,
} from "./support.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const withRetry = async <T>(
  task: () => Promise<T>,
  retries = 2,
  waitMs = 50,
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < retries && waitMs > 0) {
        await sleep(waitMs);
      }
    }
  }
  throw lastError;
};

export const SNFileExists =
  (parentDirPath: string) =>
  async (file: SN.File): Promise<boolean> => {
    // Check for the exact file the writer produces (`<name>.<type>`). A prefix
    // regex like /^name\..*$/ also matched unrelated files that merely share the
    // stem (e.g. field `foo` matching `foo.min.js`), wrongly reporting them as
    // already present and skipping the real download.
    const expected = path.join(parentDirPath, `${file.name}.${file.type}`);
    try {
      const stats = await fsp.stat(expected);
      // Treat zero-byte placeholder files as missing so their content gets
      // (re)fetched on refresh instead of being skipped as "already present".
      return stats.size > 0;
    } catch {
      return false;
    }
  };

export const createDirRecursively = async (path: string): Promise<void> => {
  await fsp.mkdir(path, { recursive: true });
};

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await fsp.access(path, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const appendToPath =
  (prefix: string) =>
  (suffix: string): string =>
    path.join(prefix, suffix);

/**
 * Detects if a path is under a parent directory
 * @param parentPath full path to parent directory
 * @param potentialChildPath full path to child directory
 */
export const isUnderPath = (
  parentPath: string,
  potentialChildPath: string,
): boolean => {
  // Split on EITHER separator: on Windows a mix of "\\" (Node) and "/" (git,
  // globs, config) is routine, and keying solely off path.sep would fail to
  // tokenize the foreign separator and misjudge containment. Drop empty
  // segments so a trailing/doubled separator (".../src/") does not introduce a
  // phantom "" token that never matches the child.
  const splitSegments = (p: string): string[] =>
    p.split(/[/\\]/).filter((token) => token !== "");
  const parentTokens = splitSegments(parentPath);
  const childTokens = splitSegments(potentialChildPath);
  return parentTokens.every((token, index) => token === childTokens[index]);
};

const getFileExtension = (filePath: string): string => {
  try {
    return path.extname(filePath);
  } catch {
    return "";
  }
};

// Basename that tolerates EITHER separator. path.basename() only recognizes the
// current platform's separator, so a Windows-shaped path fed to a POSIX runtime
// (git output on Windows, or the reverse in tests) would not be trimmed and the
// whole path would leak into the field name. Splitting on /[/\\]/ makes it robust.
const basenameAnySep = (filePath: string, ext: string): string => {
  const last =
    filePath
      .split(/[/\\]/)
      .filter((token) => token !== "")
      .pop() || "";
  return ext && last.endsWith(ext) ? last.slice(0, -ext.length) : last;
};

const getTargetFieldFromPath = (
  filePath: string,
  table: string,
  ext: string,
): string => {
  return table === "sys_atf_step"
    ? "inputs.script"
    : basenameAnySep(filePath, ext);
};

export const toAbsolutePath = (p: string): string =>
  path.isAbsolute(p) ? p : path.join(process.cwd(), p);

export const isDirectory = async (p: string): Promise<boolean> => {
  const stats = await fsp.stat(p);
  return stats.isDirectory();
};

export const splitEncodedPaths = (encodedPaths: string): string[] =>
  encodedPaths.split(PATH_DELIMITER).filter((p) => p && p !== "");

export const isValidPath = async (path: string): Promise<boolean> => {
  return pathExists(path);
};

export const summarizeFile = (ctx: Sync.FileContext): string => {
  const { tableName, name: recordName, sys_id } = ctx;
  return `${tableName}/${recordName}/${sys_id}`;
};

export const writeFileForce = (
  filePath: fs.PathLike,
  data: string | NodeJS.ArrayBufferView,
) => withRetry(() => fsp.writeFile(filePath, data));

export const writeBuildFile = async (
  folderPath: string,
  newPath: string,
  fileContents: string,
) => {
  try {
    await fsp.access(folderPath, fs.constants.F_OK);
  } catch {
    await fsp.mkdir(folderPath, { recursive: true });
  }
  await writeFileForce(newPath, fileContents);
};

// Declared as property-typed functions, not method shorthand: they are injected
// standalone functions that are destructured off the options object and never
// call through it, so they must not carry a `this` binding.
export interface FileUtilsOptions {
  /** Absolute path of the manifest file (upstream: ConfigManager.getManifestPath). */
  getManifestPath: () => string;
  /**
   * Workspace source root. May throw when no project is loaded — the INJ-1
   * containment guard then anchors to the caller-supplied parent path, exactly
   * as upstream did (upstream: ConfigManager.getSourcePath).
   */
  getSourcePath: () => string;
  /** Build output root (upstream: ConfigManager.getBuildPath). */
  getBuildPath: () => string;
  /** The loaded manifest, or undefined when none is (upstream: ConfigManager.getManifest). */
  getManifest: () => SN.AppManifest | undefined;
  logger: StoreLogger;
}

export interface FileUtilsHandle {
  writeManifestFile(man: SN.AppManifest): Promise<void>;
  writeSNFileCurry(
    checkExists: boolean,
  ): (file: SN.File, parentPath: string) => Promise<void>;
  writeFlatSNFileCurry(
    checkExists: boolean,
  ): (file: SN.File, tableDirPath: string, recordName: string) => Promise<void>;
  writeSNFileIfNotExists(file: SN.File, parentPath: string): Promise<void>;
  writeSNFileForce(file: SN.File, parentPath: string): Promise<void>;
  getBuildExt(table: string, recordName: string, field: string): string;
  getFileContextFromPath(filePath: string): Sync.FileContext | undefined;
  getPathsInPath(p: string): Promise<string[]>;
  encodedPathsToFilePaths(encodedPaths: string): Promise<string[]>;
}

// Lexical containment: `child` is `root` itself or strictly below it.
const isContainedIn = (root: string, child: string): boolean =>
  child === root ||
  child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// Delegated decision 2026-09-26 (W5a #2): write the leaf without ever following a
// symlink there. `O_NOFOLLOW` makes open() fail (ELOOP) on a symlinked leaf, dangling
// or not. On a platform whose fs.constants lacks it (Windows) the leaf is lstat'ed
// first and a symlink refused — best effort, racy, but still fail-closed on what it
// can see.
//
// `exclusive` (the checkExists writer) adds O_EXCL: the file is created only if
// nothing is there. The one existing file that writer is allowed to fill is a
// zero-byte placeholder (SNFileExists reports it as missing), so on EEXIST the leaf
// is lstat'ed and only a regular, still-empty file is reopened for truncation —
// again with O_NOFOLLOW. Fail-closed: anything else that appeared at the leaf in the
// meantime (non-empty content, a symlink, a directory) is left untouched and the
// write is skipped, exactly as if SNFileExists had seen it.
async function writeLeafNoFollow(
  leaf: string,
  content: string,
  exclusive: boolean,
): Promise<void> {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL } = fs.constants;
  const noFollow: number | undefined = (fs.constants as { O_NOFOLLOW?: number })
    .O_NOFOLLOW;
  const refuseSymlinkLeaf = async (): Promise<void> => {
    if (noFollow !== undefined) {
      return;
    }
    try {
      if ((await fsp.lstat(leaf)).isSymbolicLink()) {
        throw Object.assign(
          new Error(`Refusing to write through a symlink at "${leaf}".`),
          { code: "ELOOP" },
        );
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
  };
  const writeWith = async (flags: number): Promise<void> => {
    await refuseSymlinkLeaf();
    const handle = await fsp.open(leaf, flags | (noFollow ?? 0), 0o666);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
  };
  if (!exclusive) {
    await writeWith(O_WRONLY | O_CREAT | O_TRUNC);
    return;
  }
  try {
    await writeWith(O_WRONLY | O_CREAT | O_EXCL);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      throw e;
    }
  }
  const stats = await fsp.lstat(leaf);
  if (stats.isSymbolicLink()) {
    throw Object.assign(
      new Error(`Refusing to write through a symlink at "${leaf}".`),
      { code: "ELOOP" },
    );
  }
  if (stats.isFile() && stats.size === 0) {
    await writeWith(O_WRONLY | O_TRUNC);
  }
}

export function createFileUtils(options: FileUtilsOptions): FileUtilsHandle {
  const { getManifestPath, getSourcePath, getBuildPath, getManifest, logger } =
    options;

  const writeManifestFile = async (man: SN.AppManifest): Promise<void> => {
    const manifestPath = getManifestPath();
    // Write to a sibling temp file then rename — rename is atomic on the same
    // filesystem, so a crash mid-write can never leave a truncated/corrupt
    // manifest (the previous version stays intact until the rename completes).
    //
    // Delegated decision 2026-09-26 (W5a #5): the temp name was `<manifest>.<pid>.tmp`,
    // so two writes in one process shared one temp file (interleaved bytes, or a
    // rename that moved the other write's half-file), and a pre-planted file or
    // symlink at that predictable name was written through and then renamed into
    // place. Each attempt now takes a fresh `<pid>.<uuid>` name and opens it `wx`
    // (O_CREAT|O_EXCL: never an existing file, never through a symlink). Fail-closed:
    // a collision is an error, not an overwrite; a failed attempt removes its own
    // temp so a retry never trips over it.
    const serialized = JSON.stringify(man, null, 2);
    return withRetry(async () => {
      const tmpPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fsp.writeFile(tmpPath, serialized, { flag: "wx" });
        await fsp.rename(tmpPath, manifestPath);
      } catch (e) {
        await fsp.unlink(tmpPath).catch(() => undefined);
        throw e;
      }
    });
  };

  const writeSNFileCurry =
    (checkExists: boolean) =>
    async (file: SN.File, parentPath: string): Promise<void> => {
      const { name, type } = file;
      let { content = "" } = file;
      // content can sometimes be null
      if (!content) {
        content = "";
      } else if (typeof content !== "string") {
        try {
          content = JSON.stringify(content, null, 2);
        } catch {
          content = String(content);
        }
      }
      const write = async () => {
        const fullPath = path.join(parentPath, `${name}.${type}`);
        const resolvedFull = path.resolve(fullPath);
        // INJ-1 containment guard. Anchor to the workspace source ROOT whenever one
        // is loaded, not merely to the caller-supplied parentPath. If parentPath
        // were itself already escaped (e.g. built from an unsanitized "../evil"
        // table name or a scoped "../../.zshrc" record name), a guard anchored to
        // parentPath would pass every write that stayed under that escaped parent.
        // The download/refresh path — the only one that consumes server- or
        // manifest-supplied names — always has a source root loaded, so the
        // stronger anchor applies exactly when a tampered manifest is a risk. When
        // no project is loaded (isolated writes with no source root) fall back to
        // containing the write to its parentPath.
        let anchor: string;
        try {
          const sourceRoot = getSourcePath();
          anchor =
            typeof sourceRoot === "string" && sourceRoot.length > 0
              ? path.resolve(sourceRoot)
              : path.resolve(parentPath);
        } catch {
          anchor = path.resolve(parentPath);
        }
        const refuse = (): Error =>
          new Error(
            `Refusing to write "${name}.${type}" outside the workspace source root.`,
          );
        if (!isContainedIn(anchor, resolvedFull)) {
          throw refuse();
        }
        // Delegated decision 2026-09-26 (W5a #2): the lexical check above cannot see
        // symlinks, and fsp.writeFile follows them, so a symlinked directory inside
        // the root carried server content outside it. Compare REAL paths too: the
        // parent directory as the kernel will resolve it against the real anchor.
        // Fail-closed: if either realpath cannot be taken (missing dir, EACCES) the
        // write is refused rather than falling back to the lexical verdict.
        // Residual: a component swapped for a symlink between this check and the
        // open below is not caught (TOCTOU); the leaf itself is covered by
        // O_NOFOLLOW in openLeafNoFollow.
        let realAnchor: string;
        let realParent: string;
        try {
          [realAnchor, realParent] = await Promise.all([
            fsp.realpath(anchor),
            fsp.realpath(path.dirname(resolvedFull)),
          ]);
        } catch {
          throw refuse();
        }
        if (!isContainedIn(realAnchor, realParent)) {
          throw refuse();
        }
        const leaf = path.join(realParent, path.basename(resolvedFull));
        return await withRetry(() =>
          writeLeafNoFollow(leaf, content, checkExists),
        );
      };
      if (checkExists) {
        const exists = await SNFileExists(parentPath)(file);
        if (!exists) {
          await write();
        }
      } else {
        await write();
      }
    };

  // DX17: write a record's field file in the flat layout — a single file named
  // `<record>~<field>.<ext>` directly under the table directory, instead of a
  // per-record folder. Reuses writeSNFileCurry (and its zero-byte / already-exists
  // checks) by composing the flat base name, so flat and folder layouts share one
  // writer and stay byte-for-byte identical apart from the path.
  const writeFlatSNFileCurry =
    (checkExists: boolean) =>
    (
      file: SN.File,
      tableDirPath: string,
      recordName: string,
    ): Promise<void> => {
      const flatFile: SN.File = {
        ...file,
        name: `${recordName}${FLAT_FIELD_SEPARATOR}${file.name}`,
      };
      return writeSNFileCurry(checkExists)(flatFile, tableDirPath);
    };

  const getBuildExt = (
    table: string,
    recordName: string,
    field: string,
  ): string => {
    const manifest = getManifest();
    if (!manifest) {
      throw new Error("Failed to retrieve manifest");
    }
    const record = manifest.tables[table]?.records[recordName];
    const file = record?.files.find((f) => f.name === field);
    if (!file) {
      throw new Error("Unable to find file");
    }
    // REV-209: this value is interpolated into a filename and joined onto the build
    // root by pushPipeline (`${relPathNoExt}.${buildExt}` → path.join(buildPath, ...)
    // → writeFileForce), and writeFileForce is a bare fsp.writeFile with no
    // containment check of any kind. The source-tree writer received the INJ-1
    // containment guard (writeSNFileCurry above) exactly because manifest-supplied
    // names are treated as untrusted there — but the build-tree writer was left
    // unguarded, so the same threat model was only half enforced. A manifest `type`
    // of "js/../../../../evil" escapes the build directory AND the workspace.
    //
    // Validate here rather than at the write site: this is the single point where the
    // untrusted value leaves the manifest, so both build layouts and any other future
    // caller are covered by one check. isSafePathComponent is the same rule the
    // download side uses, so the two cannot drift.
    if (!isSafePathComponent(file.type)) {
      throw new Error(
        `Refusing to build "${recordName}" in table "${table}": the manifest records ` +
          `an unusable file type for field "${field}". A file type must be a single ` +
          `path component (no "/" or "\\", not empty, not only dots). Re-run ` +
          `\`syncrona refresh\` to rebuild the manifest from the instance.`,
      );
    }
    return file.type;
  };

  const getFileContextFromPath = (
    filePath: string,
  ): Sync.FileContext | undefined => {
    const ext = getFileExtension(filePath);
    let tableName: string;
    let recordName: string;
    let targetField: string;
    // DX17: a flat-encoded path (`<table>/<record>~<field>.<ext>`) is self
    // describing — keyed off the file stem, never the config — so build/deploy
    // re-reads work even though the build tree mirrors the flat source layout.
    if (isFlatEncoded(filePath)) {
      tableName = path.basename(path.dirname(filePath));
      const stem = path.basename(filePath, ext);
      const sepIndex = stem.lastIndexOf(FLAT_FIELD_SEPARATOR);
      recordName = stem.slice(0, sepIndex);
      targetField =
        tableName === "sys_atf_step"
          ? "inputs.script"
          : stem.slice(sepIndex + 1);
    } else {
      // Split on EITHER separator and drop empty/basename segments so the
      // <table>/<record> pair is recovered even when the path arrives with the
      // foreign separator (git output or globs on Windows produce "/" while
      // path.sep is "\\") — keying on path.sep alone would fail to tokenize it.
      const segments = filePath.split(/[/\\]/).filter((token) => token !== "");
      const [tableSegment = "", recordSegment = ""] = segments.slice(-3, -1);
      tableName = tableSegment;
      recordName = recordSegment;
      targetField = getTargetFieldFromPath(filePath, tableName, ext);
    }
    const manifest = getManifest();
    if (!manifest) {
      throw new Error("No manifest has been loaded!");
    }
    const { tables, scope } = manifest;
    const record = tables[tableName]?.records[recordName];
    if (!record) {
      return undefined;
    }
    const { files, sys_id } = record;
    const field = files.find((file) => file.name === targetField);
    if (!field) {
      return undefined;
    }
    return {
      filePath,
      ext,
      sys_id,
      name: recordName,
      scope,
      tableName,
      targetField,
    };
  };

  const getPathsInPath = async (p: string): Promise<string[]> => {
    // INJ-1: the containment check must run on the SAME string the walk starts
    // from. Previously the guard compared the raw argument while the walk seeded
    // path.resolve(p), so a relative ("src/../../etc") or ".."-bearing path could
    // pass the token comparison and then resolve outside the source/build trees.
    // Resolve first, compare second — and log the rejection instead of returning
    // an empty list silently (an empty list reads as "no files", which callers
    // like repair --prune interpret as a meaningful, actionable result).
    const resolved = path.resolve(p);
    if (
      !isUnderPath(path.resolve(getSourcePath()), resolved) &&
      !isUnderPath(path.resolve(getBuildPath()), resolved)
    ) {
      logger.warn(
        `Refusing to scan "${resolved}": it is outside the configured source and build directories.`,
      );
      return [];
    }
    const maxDepth = 20;
    const files: string[] = [];
    const stack: Array<{ filePath: string; depth: number }> = [
      { filePath: resolved, depth: 0 },
    ];

    while (stack.length > 0) {
      const next = stack.pop();
      if (!next) {
        continue;
      }

      if (next.depth > maxDepth) {
        continue;
      }

      let stat;
      try {
        stat = await fsp.lstat(next.filePath);
      } catch {
        continue;
      }

      // Skip symlinks outright. The isUnderPath guard above only vetted the
      // requested root; following a link could escape the source/build tree or
      // spin in a cycle. Collecting links as plain paths would also push the same
      // bytes twice (link + target).
      if (stat.isSymbolicLink()) {
        continue;
      }

      if (!stat.isDirectory()) {
        files.push(next.filePath);
        continue;
      }

      if (next.depth === maxDepth) {
        // The tree is deeper than we walk. Warn rather than truncate silently so a
        // partial push/build is not mistaken for having covered every file.
        logger.warn(
          `Directory tree deeper than ${maxDepth} levels at ${next.filePath}; not descending further.`,
        );
        continue;
      }

      let children: string[];
      try {
        children = await fsp.readdir(next.filePath);
      } catch {
        continue;
      }

      for (const child of children) {
        stack.push({
          filePath: path.resolve(next.filePath, child),
          depth: next.depth + 1,
        });
      }
    }

    return files;
  };

  const encodedPathsToFilePaths = async (
    encodedPaths: string,
  ): Promise<string[]> => {
    const pathSplits = splitEncodedPaths(encodedPaths);
    const validChecks = await Promise.all(pathSplits.map(isValidPath));
    const validSplits = pathSplits.filter((_, index) => validChecks[index]);
    const splitPaths = await Promise.all(validSplits.map(getPathsInPath));
    const deDupedPaths = splitPaths.flat().reduce((acc, cur) => {
      acc.add(cur);
      return acc;
    }, new Set<string>());
    return Array.from(deDupedPaths);
  };

  return {
    writeManifestFile,
    writeSNFileCurry,
    writeFlatSNFileCurry,
    writeSNFileIfNotExists: writeSNFileCurry(true),
    writeSNFileForce: writeSNFileCurry(false),
    getBuildExt,
    getFileContextFromPath,
    getPathsInPath,
    encodedPathsToFilePaths,
  };
}
