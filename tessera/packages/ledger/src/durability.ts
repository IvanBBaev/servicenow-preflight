// Crash-safe filesystem primitives for the write-ahead intent ledger (§4b).
// Two disciplines, and nothing else touches the ledger's files:
//
//   * append-only logs — one JSON record per line, fsynced before the call
//     returns (§4b "append-only, flush-per-entry"). The terminating newline is
//     the COMMIT MARKER: the record bytes are written by a single `write(2)` on
//     an O_APPEND handle with the newline last, so a `kill -9` anywhere in the
//     sequence can only ever leave an unterminated tail — never a half record
//     that reads as committed, and never a lost record whose append returned.
//
//   * mutable state files — replaced atomically (temp → fsync → rename → dir
//     fsync), never edited in place, so a reader always sees the whole previous
//     version or the whole next one.
//
// The append discipline exists TWICE — once async, once sync (`*Sync`). That is
// not a copy of a decision: the one thing a copy could get wrong, "where does
// the committed prefix end", is `committedLength()`, which both repair paths
// call. The rest is the same four syscalls in the same order, spelled with the
// two APIs Node offers for them.
//
// The sync twins exist because ONE caller cannot yield: the §11.4
// `GuardAuditSink` is invoked from `assertWrite`/`assertRunnerWritable`, which
// are synchronous by contract (guard §11.6) and refuse the write by throwing.
// A sink that returned a promise there would let the write proceed while its
// own audit record was still unwritten — which is the whole failure the
// write-ahead ordering exists to prevent.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  promises as fsp,
  readFileSync,
  statSync,
  writeSync,
  ftruncateSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const NEWLINE = 0x0a;

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * fsync a directory so a newly created file's (or a rename's) directory entry
 * survives a power loss. Best effort by design: platforms that refuse to open or
 * fsync a directory handle (Windows) still get durable file *contents*, which is
 * what the intent record's safety property rests on.
 */
export async function syncDir(dir: string): Promise<void> {
  const handle = await fsp.open(dir, "r").catch(() => undefined);
  if (handle === undefined) {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Filesystem refuses fsync on a directory handle — see above.
  } finally {
    await handle.close();
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await syncDir(path.dirname(dir));
}

/** `syncDir`, without yielding. Same best-effort contract. */
function syncDirSync(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Filesystem refuses fsync on a directory handle — see `syncDir`.
  } finally {
    closeSync(fd);
  }
}

/** `ensureDir`, without yielding. */
export function ensureDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true });
  syncDirSync(path.dirname(dir));
}

/**
 * Append one record and fsync before returning — the §4b flush-per-entry that
 * makes "the intent is durable before the write leaves the process" true.
 */
export async function appendLineDurable(
  file: string,
  line: string,
): Promise<void> {
  const existed = await pathExists(file);
  const handle = await fsp.open(file, "a");
  try {
    await handle.writeFile(`${line}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!existed) {
    // The file's data is fsynced, but a brand-new name also needs its directory
    // entry flushed or the whole log can vanish on a power loss.
    await syncDir(path.dirname(file));
  }
}

/**
 * `appendLineDurable`, without yielding — the record is on disk by the time
 * this RETURNS, not by the time some promise settles.
 *
 * This is the property the §11.4 audit sink is built on, so it is worth being
 * exact about what "without yielding" buys: between the first statement here
 * and the last, no other JavaScript runs in this process. A caller that is
 * about to refuse or permit a write therefore cannot observe, and cannot be
 * interrupted by, a half-journalled state — and a throw from here reaches that
 * caller as a throw, not as an unhandled rejection it never awaited.
 */
export function appendLineDurableSync(file: string, line: string): void {
  const existed = pathExistsSync(file);
  const fd = openSync(file, "a");
  try {
    writeSync(fd, `${line}\n`, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!existed) {
    syncDirSync(path.dirname(file));
  }
}

export interface LogLines {
  /** Committed records, in append order. */
  lines: string[];
  /** A trailing record had no terminating newline — it was never committed. */
  torn: boolean;
}

/** Read a log's committed lines, discarding an uncommitted tail. */
export async function readLogLines(file: string): Promise<LogLines> {
  let buffer: Buffer;
  try {
    buffer = await fsp.readFile(file);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { lines: [], torn: false };
    }
    throw error;
  }
  if (buffer.length === 0) {
    return { lines: [], torn: false };
  }
  const torn = buffer[buffer.length - 1] !== NEWLINE;
  const parts = buffer.toString("utf8").split("\n");
  // A terminated log splits to a trailing ""; a torn one to the uncommitted
  // partial record. Either way the final element is not a committed record.
  parts.pop();
  return { lines: parts, torn };
}

function isParsableRecord(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Where the log's COMMITTED prefix ends, in bytes — the single decision behind
 * both `repairLogTail` and `repairLogTailSync`. Kept as one pure function on
 * purpose: two repair paths that disagreed about what "committed" means is the
 * one way a sync twin could silently destroy a record the async path had
 * already promised was durable.
 *
 * `buffer.length` means "nothing to repair".
 */
function committedLength(buffer: Buffer): number {
  if (buffer.length === 0) {
    return 0;
  }
  if (buffer[buffer.length - 1] !== NEWLINE) {
    // 0 when the log holds no newline at all.
    return buffer.lastIndexOf(NEWLINE) + 1;
  }
  const start = buffer.lastIndexOf(NEWLINE, buffer.length - 2) + 1;
  return isParsableRecord(buffer.toString("utf8", start, buffer.length - 1))
    ? buffer.length
    : start;
}

/**
 * Drop an uncommitted trailing record so the next append starts on a record
 * boundary. Without this, appending after a torn write would splice the new
 * record onto the partial one and turn a tolerable tail into corruption in the
 * MIDDLE of the log.
 *
 * Two tails count as uncommitted: one with no terminating newline (the ordinary
 * torn write), and one that is newline-terminated but unparsable — some
 * filesystems zero-fill the tail of a file after a crash, which can manufacture
 * a "complete" line of NULs. Removing only uncommitted records keeps the log
 * append-only in the sense that matters: nothing a caller was told is durable is
 * ever removed.
 *
 * Returns whether anything was truncated.
 */
export async function repairLogTail(file: string): Promise<boolean> {
  let buffer: Buffer;
  try {
    buffer = await fsp.readFile(file);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  const cut = committedLength(buffer);
  if (cut === buffer.length) {
    return false;
  }

  const handle = await fsp.open(file, "r+");
  try {
    await handle.truncate(cut);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/** `repairLogTail`, without yielding — same rule, same `committedLength`. */
export function repairLogTailSync(file: string): boolean {
  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  const cut = committedLength(buffer);
  if (cut === buffer.length) {
    return false;
  }

  const fd = openSync(file, "r+");
  try {
    ftruncateSync(fd, cut);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Replace a state file atomically: temp → fsync → rename → dir fsync. */
export async function writeJsonAtomic(
  file: string,
  value: unknown,
): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await fsp.open(tmp, "w");
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // rename(2) is atomic within a filesystem: a reader sees the old file or the
    // new one, never a partial write.
    await fsp.rename(tmp, file);
  } catch (error) {
    await fsp.rm(tmp, { force: true });
    throw error;
  }
  await syncDir(dir);
}

/**
 * Create `file` with `value` ONLY if it does not exist yet — the exclusive
 * twin of `writeJsonAtomic`, with the same fsync discipline (temp → fsync →
 * publish → dir fsync). Returns `true` when this call created the file and
 * `false` when something else already had (EEXIST); nothing is overwritten.
 *
 * Delegated decision 2026-09-25: the publish step is `link(2)`, not
 * `rename(2)`. `rename` silently replaces an existing target, so two ledger
 * instances (two processes) opening the same run id with different
 * parameters would BOTH succeed, and the last writer's record would win
 * without either caller ever hearing about the other. `link` fails with
 * EEXIST instead, and it publishes the fully-written, fsynced temp file in
 * one step, so a reader still never sees a partial record. A filesystem that
 * cannot hard-link surfaces its errno (fail closed) rather than degrading to
 * a racy create.
 */
export async function writeJsonExclusive(
  file: string,
  value: unknown,
): Promise<boolean> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let created: boolean;
  try {
    const handle = await fsp.open(tmp, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fsp.link(tmp, file);
      created = true;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      created = false;
    }
  } finally {
    await fsp.rm(tmp, { force: true });
  }
  await syncDir(dir);
  return created;
}

export async function readTextFile(file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/** Directory entries that are themselves directories — one per run. */
export async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}
