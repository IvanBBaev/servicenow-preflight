// The benchmark's durable restore journal (review-w7a F4).
//
// The instance substrate keeps each artifact's captured "correct" source in
// memory and writes it back on the final restore. A process that dies between
// a mutant/detonator PATCH and that restore (SIGKILL, OOM, a power loss) used
// to lose the only copy of the correct text — and the NEXT run then captured
// the still-live mutant as "correct". This journal makes the correct source
// durable BEFORE the first PATCH of an artifact, so a crash always leaves a
// file an operator (or `tess benchmark --restore <runId>`) can restore from.
//
// Durability follows `@tessera/ledger`'s discipline (not exported there, so
// the few syscalls are restated here): the FIRST write creates the file
// exclusively (temp opened `wx` → fsync → `link` → directory fsync, EEXIST
// refuses), and every later write replaces it atomically (temp → fsync →
// rename → directory fsync). A reader therefore sees either no journal or a
// whole one, never a torn one.

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { sha256Hex } from "@tessera/core";

export const RESTORE_JOURNAL_SCHEMA = "tessera-benchmark-restore-journal/1";
export const RESTORE_JOURNAL_FILENAME = "restore-journal.json";

/** One artifact's correct source, recorded before it is first written. */
export interface RestoreJournalEntry {
  readonly table: string;
  readonly sysId: string;
  readonly field: string;
  /** sha256 hex of `source` — a mismatch on read marks the journal corrupt. */
  readonly sha256: string;
  readonly source: string;
}

/** The on-disk document. */
export interface RestoreJournalDocument {
  readonly schema: typeof RESTORE_JOURNAL_SCHEMA;
  readonly runId: string;
  readonly runnerProfile: string;
  /** Instance host the entries belong to; `null` when it was not known. */
  readonly instance: string | null;
  /** The writing process — lets `--restore` refuse while it is still alive. */
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: string;
  readonly entries: readonly RestoreJournalEntry[];
}

/** What the substrate needs from a journal. */
export interface RestoreJournal {
  /** A human-readable location for messages (a file path, or "memory"). */
  readonly location: string;
  /** The run this journal belongs to, when known (names the recovery command). */
  readonly runId?: string;
  /**
   * Durably record one entry. Resolves only once it is on disk; rejects when
   * it could not be made durable (the caller must then NOT write).
   */
  record(entry: RestoreJournalEntry): Promise<void>;
  /** Entries still pending restore. */
  entries(): readonly RestoreJournalEntry[];
  /** Remove the journal once every entry is verified restored. */
  clear(): Promise<void>;
  /**
   * Durably drop every entry `keep` rejects — used after a PARTIAL final
   * restore, so the journal names only what is still unrestored. Optional:
   * a journal without it simply keeps every entry (the safe direction).
   */
  retain?(keep: (entry: RestoreJournalEntry) => boolean): Promise<void>;
}

export class RestoreJournalError extends Error {
  override readonly name = "RestoreJournalError";
  constructor(
    message: string,
    readonly file?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function entryKey(entry: Pick<RestoreJournalEntry, "table" | "sysId">): string {
  return `${entry.table}\u0000${entry.sysId}`;
}

/**
 * Delegated decision 2026-09-26: recording the same artifact twice with a
 * DIFFERENT correct source is a contradiction (two "correct" texts) and
 * throws; the same source again is a no-op.
 */
function mergeEntry(
  entries: RestoreJournalEntry[],
  entry: RestoreJournalEntry,
  location: string,
): boolean {
  const prior = entries.find((e) => entryKey(e) === entryKey(entry));
  if (prior === undefined) return true;
  if (prior.source === entry.source && prior.field === entry.field) {
    return false;
  }
  throw new RestoreJournalError(
    `restore journal ${location} already holds a different correct source for ${entry.table}/${entry.sysId}`,
    location,
  );
}

function checkEntry(entry: RestoreJournalEntry, location: string): void {
  if (sha256Hex(entry.source) !== entry.sha256) {
    throw new RestoreJournalError(
      `restore journal ${location}: entry ${entry.table}/${entry.sysId} sha256 does not match its source`,
      location,
    );
  }
}

/** An in-process journal — for tests and for callers with no ledger root. */
export function createMemoryRestoreJournal(runId?: string): RestoreJournal {
  let entries: RestoreJournalEntry[] = [];
  return {
    location: "memory",
    ...(runId === undefined ? {} : { runId }),
    record(entry) {
      checkEntry(entry, "memory");
      if (mergeEntry(entries, entry, "memory")) {
        entries = [...entries, entry];
      }
      return Promise.resolve();
    },
    entries: () => entries,
    clear() {
      entries = [];
      return Promise.resolve();
    },
    retain(keep) {
      entries = entries.filter(keep);
      return Promise.resolve();
    },
  };
}

/** Best-effort directory fsync (same contract as the ledger's `syncDir`). */
async function syncDir(dir: string): Promise<void> {
  const handle = await fsp.open(dir, "r").catch(() => undefined);
  if (handle === undefined) return;
  try {
    await handle.sync();
  } catch {
    // A filesystem that refuses fsync on a directory handle.
  } finally {
    await handle.close();
  }
}

async function writeTemp(file: string, text: string): Promise<string> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fsp.open(tmp, "wx");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return tmp;
}

async function createExclusive(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = await writeTemp(file, text);
  try {
    await fsp.link(tmp, file);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new RestoreJournalError(
        `a restore journal already exists at ${file} — a prior run left artifacts unrestored; run \`tess benchmark --restore <runId>\` first`,
        file,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
  await syncDir(path.dirname(file));
}

async function replaceAtomic(file: string, text: string): Promise<void> {
  const tmp = await writeTemp(file, text);
  try {
    await fsp.rename(tmp, file);
  } catch (error) {
    await fsp.rm(tmp, { force: true });
    throw error;
  }
  await syncDir(path.dirname(file));
}

/** Delete a journal file; an absent file is already cleared. */
export async function clearRestoreJournalFile(file: string): Promise<void> {
  try {
    await fsp.unlink(file);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  await syncDir(path.dirname(file));
}

export interface FileRestoreJournalOptions {
  readonly file: string;
  readonly runId: string;
  readonly runnerProfile: string;
  readonly instance: string | null;
  readonly pid?: number;
  readonly hostname?: string;
  readonly now?: () => Date;
}

/** The durable journal the CLI composes for a live run. */
export function createFileRestoreJournal(
  options: FileRestoreJournalOptions,
): RestoreJournal {
  const { file, runId } = options;
  let entries: RestoreJournalEntry[] = [];
  let created = false;
  let createdAt: string | undefined;
  // Writes are serialised: two captures in flight must not race the rename.
  let chain: Promise<void> = Promise.resolve();

  const document = (next: RestoreJournalEntry[]): RestoreJournalDocument => ({
    schema: RESTORE_JOURNAL_SCHEMA,
    runId,
    runnerProfile: options.runnerProfile,
    instance: options.instance,
    pid: options.pid ?? process.pid,
    hostname: options.hostname ?? os.hostname(),
    createdAt: (createdAt ??= (options.now?.() ?? new Date()).toISOString()),
    entries: next,
  });

  const serialised = (step: () => Promise<void>): Promise<void> => {
    const run = chain.then(step);
    chain = run.catch(() => {});
    return run;
  };

  return {
    location: file,
    runId,
    record(entry) {
      return serialised(async () => {
        checkEntry(entry, file);
        if (!mergeEntry(entries, entry, file)) return;
        const next = [...entries, entry];
        const text = `${JSON.stringify(document(next), null, 2)}\n`;
        // Delegated decision 2026-09-26: the first write is an EXCLUSIVE
        // create — an existing journal (a crashed run's, or a concurrent
        // one's) is never overwritten, so its correct sources survive.
        if (created) await replaceAtomic(file, text);
        else await createExclusive(file, text);
        created = true;
        entries = next;
      });
    },
    entries: () => entries,
    clear() {
      return serialised(async () => {
        await clearRestoreJournalFile(file);
        entries = [];
        created = false;
        createdAt = undefined;
      });
    },
    retain(keep) {
      return serialised(async () => {
        const next = entries.filter(keep);
        if (next.length === entries.length) return;
        // Delegated decision 2026-09-26: never shrink the journal to empty
        // here — an empty journal is removed only by `clear()`, after a
        // verified restore of everything.
        if (next.length === 0 || !created) return;
        await replaceAtomic(
          file,
          `${JSON.stringify(document(next), null, 2)}\n`,
        );
        entries = next;
      });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function parseDocument(raw: unknown, file: string): RestoreJournalDocument {
  const corrupt = (why: string): RestoreJournalError =>
    new RestoreJournalError(
      `restore journal ${file} is corrupt: ${why} — inspect it by hand; nothing was restored`,
      file,
    );
  if (!isRecord(raw)) throw corrupt("not a JSON object");
  if (raw["schema"] !== RESTORE_JOURNAL_SCHEMA) {
    throw corrupt(`schema is not ${RESTORE_JOURNAL_SCHEMA}`);
  }
  const { runId, runnerProfile, instance, pid, hostname, createdAt } = raw;
  if (typeof runId !== "string" || runId === "") throw corrupt("no runId");
  if (typeof runnerProfile !== "string") throw corrupt("no runnerProfile");
  if (instance !== null && typeof instance !== "string") {
    throw corrupt("instance is neither a string nor null");
  }
  if (typeof pid !== "number" || !Number.isInteger(pid)) {
    throw corrupt("no pid");
  }
  if (typeof hostname !== "string") throw corrupt("no hostname");
  if (typeof createdAt !== "string") throw corrupt("no createdAt");
  const rawEntries = raw["entries"];
  if (!Array.isArray(rawEntries)) throw corrupt("entries is not an array");
  const entries: RestoreJournalEntry[] = rawEntries.map(
    (value: unknown, index) => {
      if (!isRecord(value)) throw corrupt(`entries[${index}] is not an object`);
      const { table, sysId, field, sha256, source } = value;
      if (
        typeof table !== "string" ||
        table === "" ||
        typeof sysId !== "string" ||
        sysId === "" ||
        typeof field !== "string" ||
        field === "" ||
        typeof sha256 !== "string" ||
        !SHA256_HEX.test(sha256) ||
        typeof source !== "string"
      ) {
        throw corrupt(`entries[${index}] is malformed`);
      }
      if (sha256Hex(source) !== sha256) {
        throw corrupt(
          `entries[${index}] (${table}/${sysId}) sha256 does not match its source`,
        );
      }
      return { table, sysId, field, sha256, source };
    },
  );
  return {
    schema: RESTORE_JOURNAL_SCHEMA,
    runId,
    runnerProfile,
    instance,
    pid,
    hostname,
    createdAt,
    entries,
  };
}

/**
 * Read and verify a journal. `null` when there is none; a
 * `RestoreJournalError` when it exists but cannot be trusted (fail closed —
 * a corrupt journal is never treated as absent).
 */
export async function readRestoreJournal(
  file: string,
): Promise<RestoreJournalDocument | null> {
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw new RestoreJournalError(
      `restore journal ${file} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      file,
      { cause: error },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new RestoreJournalError(
      `restore journal ${file} is corrupt: not valid JSON — inspect it by hand; nothing was restored`,
      file,
      { cause: error },
    );
  }
  return parseDocument(raw, file);
}

/** `<ledgerRoot>/benchmark/<runId>/restore-journal.json`. */
export function restoreJournalPath(ledgerRoot: string, runId: string): string {
  // Delegated decision 2026-09-26: the runId becomes a path segment, so any
  // separator or dot-segment is refused rather than normalised.
  if (
    runId === "" ||
    runId === "." ||
    runId === ".." ||
    /[/\\]/.test(runId) ||
    runId.includes("\u0000")
  ) {
    throw new RestoreJournalError(
      `refusing restore-journal path for runId ${JSON.stringify(runId)}`,
    );
  }
  return path.join(ledgerRoot, "benchmark", runId, RESTORE_JOURNAL_FILENAME);
}

/** One journal found on disk; exactly one of `document`/`error` is set. */
export interface FoundRestoreJournal {
  readonly file: string;
  /** The run directory's name. */
  readonly runId: string;
  readonly document?: RestoreJournalDocument;
  readonly error?: RestoreJournalError;
}

/**
 * Every journal under `<ledgerRoot>/benchmark/*`. Read-only: it never creates
 * a directory, and a missing root is simply "no journals".
 */
export async function findRestoreJournals(
  ledgerRoot: string,
): Promise<FoundRestoreJournal[]> {
  const dir = path.join(ledgerRoot, "benchmark");
  let names: string[];
  try {
    names = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return [];
    throw error;
  }
  const found: FoundRestoreJournal[] = [];
  for (const runId of names) {
    const file = path.join(dir, runId, RESTORE_JOURNAL_FILENAME);
    try {
      const document = await readRestoreJournal(file);
      if (document !== null) found.push({ file, runId, document });
    } catch (error) {
      found.push({
        file,
        runId,
        error:
          error instanceof RestoreJournalError
            ? error
            : new RestoreJournalError(String(error), file),
      });
    }
  }
  return found;
}

export type JournalWriterLiveness = "alive" | "dead" | "foreign-host";

/**
 * Is the process that wrote `document` still running? A journal written on
 * another host cannot be checked (`foreign-host`); `EPERM` from signal 0
 * means the pid exists (another user's), so it counts as alive — fail closed.
 */
export function journalWriterLiveness(
  document: Pick<RestoreJournalDocument, "pid" | "hostname">,
  probe: {
    readonly hostname?: string;
    readonly kill?: (pid: number, signal: 0) => void;
  } = {},
): JournalWriterLiveness {
  if (document.hostname !== (probe.hostname ?? os.hostname())) {
    return "foreign-host";
  }
  const kill =
    probe.kill ?? ((pid: number, signal: 0) => process.kill(pid, signal));
  try {
    kill(document.pid, 0);
    return "alive";
  } catch (error) {
    return isErrno(error, "ESRCH") ? "dead" : "alive";
  }
}
