// Run-state persistence for `run_status` (DESIGN §6b / QA-29) — delegated
// decision 2026-09-23.
//
// On-disk layout, next to the §4b store's own files for the run:
//
//   <root>/runs/<runId>/events.jsonl   append-only event log, one cursor per line
//   <root>/runs/<runId>/result.json    the run's final result (atomic replace)
//   <root>/runs/<runId>/.events.lock   cross-process lock (fileLock.ts)
//
// The point is observability from a DIFFERENT process: `tess status` (and the
// MCP `run_status` tool) must be able to answer "where is run X, and what
// happened since I last asked" with nothing but the disk. So the cursor is not
// an in-memory counter — it is read back from the last committed line under a
// lock, which is what keeps it monotonic and gap-free across processes and
// reopen. A torn tail (a `kill -9` mid-append) never committed its cursor, so
// the next append reuses that number and no reader ever saw it.

import path from "node:path";

import {
  appendLineDurable,
  readLogLines,
  readTextFile,
  repairLogTail,
  writeJsonAtomic,
} from "./durability.js";
import { LedgerError } from "./errors.js";
import { DEFAULT_LOCK_TIMEOUT_MS, withFileLock } from "./fileLock.js";
import {
  RUNS_DIRNAME,
  RUN_STATE_FILENAME,
  requireText,
  validateRunId,
} from "./ledger.js";
import {
  decodePersistedRunResult,
  decodeRunEvent,
  decodeRunStateRecord,
  parseLogRecords,
} from "./records.js";
import type {
  PersistedRunResult,
  RunEvent,
  RunEventInput,
  RunEventLog,
  RunEventLogOptions,
  RunEventPage,
  RunId,
  RunStateRecord,
  RunStatusSnapshot,
} from "./types.js";

export const RUN_EVENTS_FILENAME = "events.jsonl";
export const RUN_RESULT_FILENAME = "result.json";
const LOCK_FILENAME = ".events.lock";

/** JSON round trip, refusing what would not survive it (functions, cycles, bigint). */
function toJson(field: string, value: unknown): unknown {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new LedgerError(
      "protocol",
      `${field} is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (encoded === undefined) {
    throw new LedgerError("protocol", `${field} is not JSON-serializable`);
  }
  return JSON.parse(encoded) as unknown;
}

function validateCursor(since: number): number {
  if (!Number.isInteger(since) || since < 0) {
    throw new LedgerError(
      "protocol",
      `cursor must be a non-negative integer, got ${JSON.stringify(since)}`,
    );
  }
  return since;
}

export function createRunEventLog(options: RunEventLogOptions): RunEventLog {
  const rootDir = path.resolve(requireText("rootDir", options.rootDir));
  const runsDir = path.join(rootDir, RUNS_DIRNAME);
  const clock = options.now ?? ((): Date => new Date());
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  const runDir = (runId: string): string => path.join(runsDir, runId);
  const eventsFile = (runId: string): string =>
    path.join(runDir(runId), RUN_EVENTS_FILENAME);
  const resultFile = (runId: string): string =>
    path.join(runDir(runId), RUN_RESULT_FILENAME);

  async function readJsonFile<T>(
    file: string,
    decode: (value: unknown) => T | null,
    what: string,
  ): Promise<T | undefined> {
    const raw = await readTextFile(file);
    if (raw === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const decoded = parsed === undefined ? null : decode(parsed);
    if (decoded === null) {
      // Atomic replace only — anything unreadable is damage, not a crash tail.
      throw new LedgerError("corrupt", `${file} is not a valid ${what}`);
    }
    return decoded;
  }

  function readRunRecord(runId: string): Promise<RunStateRecord | undefined> {
    return readJsonFile(
      path.join(runDir(runId), RUN_STATE_FILENAME),
      decodeRunStateRecord,
      "run record",
    );
  }

  async function requireRun(runId: string): Promise<RunStateRecord> {
    const run = await readRunRecord(runId);
    if (run === undefined) {
      throw new LedgerError(
        "run-not-found",
        `run ${runId} has no state record under ${runsDir}; open it before recording its events`,
      );
    }
    return run;
  }

  /** Every committed event, checked for the cursor invariant. */
  async function readAll(runId: string): Promise<RunEvent[]> {
    const file = eventsFile(runId);
    const events = parseLogRecords(
      file,
      await readLogLines(file),
      decodeRunEvent,
    );
    events.forEach((event, index) => {
      if (event.cursor !== index + 1 || event.runId !== runId) {
        throw new LedgerError(
          "corrupt",
          `${file}: record ${index + 1} carries cursor ${event.cursor} of run ${event.runId}; cursors are gap-free from 1 within one run`,
        );
      }
    });
    return events;
  }

  function readResultRecord(
    runId: string,
  ): Promise<PersistedRunResult | undefined> {
    return readJsonFile(
      resultFile(runId),
      decodePersistedRunResult,
      "run result",
    );
  }

  return {
    async appendEvent(runId: RunId, input: RunEventInput): Promise<RunEvent> {
      const id = validateRunId(runId);
      const type = requireText("type", input.type);
      const at =
        input.at === undefined
          ? clock().toISOString()
          : requireText("at", input.at);
      const data =
        input.data === undefined ? undefined : toJson("data", input.data);
      await requireRun(id);

      return withFileLock(
        path.join(runDir(id), LOCK_FILENAME),
        async () => {
          const file = eventsFile(id);
          // Under the lock, every time: another process may have torn the
          // tail since this one last appended (see infra.ts).
          await repairLogTail(file);
          const events = await readAll(id);
          const event: RunEvent = {
            cursor: (events.at(-1)?.cursor ?? 0) + 1,
            runId: id,
            type,
            at,
          };
          if (data !== undefined) {
            event.data = data;
          }
          await appendLineDurable(file, JSON.stringify(event));
          return event;
        },
        lockTimeoutMs,
      );
    },

    async readEvents(runId: RunId, since = 0): Promise<RunEventPage> {
      const id = validateRunId(runId);
      const from = validateCursor(since);
      await requireRun(id);
      const events = (await readAll(id)).filter((event) => event.cursor > from);
      return { events, cursor: events.at(-1)?.cursor ?? from };
    },

    async writeResult(
      runId: RunId,
      result: unknown,
    ): Promise<PersistedRunResult> {
      const id = validateRunId(runId);
      await requireRun(id);
      const record: PersistedRunResult = {
        runId: id,
        at: clock().toISOString(),
        result: toJson("result", result),
      };
      await writeJsonAtomic(resultFile(id), record);
      return record;
    },

    async readResult(runId: RunId): Promise<PersistedRunResult | undefined> {
      return await readResultRecord(validateRunId(runId));
    },

    async readStatus(runId: RunId): Promise<RunStatusSnapshot | undefined> {
      const id = validateRunId(runId);
      const run = await readRunRecord(id);
      if (run === undefined) {
        return undefined;
      }
      const events = await readAll(id);
      const snapshot: RunStatusSnapshot = {
        run,
        lastCursor: events.at(-1)?.cursor ?? 0,
      };
      const result = await readResultRecord(id);
      if (result !== undefined) {
        snapshot.result = result;
      }
      return snapshot;
    },
  };
}
