// Config-file discovery and reading (PLAN Phase 1 §Configuration).
//
// JSON only. A YAML parser is a runtime dependency and this workspace has a
// standing zero-dependency constraint, so the format follows from the
// constraint rather than from taste.
//
// The reader is a port, not a call to `node:fs`, so the resolver's tests need
// no temporary directories to exercise discovery, precedence or the secret
// scan. `readTextFileSync` is the only thing in this package that touches disk.

import fs from "node:fs";
import path from "node:path";

/**
 * Reads a file, or returns `undefined` if there is nothing at that path.
 *
 * The distinction matters: "absent" is a normal outcome during upward
 * discovery, while "present but unreadable" is a real failure the operator has
 * to hear about, so an implementation must throw for the latter rather than
 * folding it into `undefined`.
 */
export type ReadTextFile = (filePath: string) => string | undefined;

/** Discovered by walking up from the working directory. */
export const CONFIG_FILE_NAME = "tessera.config.json";

/**
 * Errno codes that mean "there is no file at that path".
 *
 * `EISDIR` is deliberately absent: a directory named `tessera.config.json` IS
 * something at that path, so folding it into `undefined` would tell the
 * operator `config file not found` about a path that is occupied — a cause
 * this reader never observed. It throws instead, like every other
 * present-but-unreadable outcome.
 */
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export const readTextFileSync: ReadTextFile = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (ABSENT_CODES.has(errnoCode(error) ?? "")) return undefined;
    throw error;
  }
};

export interface DiscoveredFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Nearest `tessera.config.json` at or above `cwd`, or `undefined`.
 *
 * Not finding one is normal — `tess preflight --runner … --scope …` with no file
 * anywhere is a supported invocation — so this returns absence rather than
 * throwing. Only an explicit `--config` turns a missing file into an error,
 * because there the operator named a path and got something other than what
 * they named.
 */
export function discoverConfigFile(
  cwd: string,
  read: ReadTextFile,
): DiscoveredFile | undefined {
  let directory = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(directory, CONFIG_FILE_NAME);
    const text = read(candidate);
    if (text !== undefined) return { path: candidate, text };
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
