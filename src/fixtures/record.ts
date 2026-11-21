/**
 * F-X-6: record mode. Wraps the client's real transport, passes every request
 * through unchanged, and writes a redacted copy of each instance API exchange
 * to the recording directory.
 *
 * CFG-6: a new recording directory is created 0700 and every file in it is
 * written atomically with mode 0600. Starting a recording first removes the
 * exchanges and index a previous recording left there (only file names this
 * module writes), so a re-record never replays a stale answer.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../atomic-write.js";
import type { Transport } from "../http/client.js";
import { keyFile, requestKey, type RequestKey } from "./key.js";
import {
  indexPath,
  RECORDING_FORMAT,
  type RecordedExchange,
  type RecordingIndex,
} from "./recording.js";
import {
  createRedactor,
  looksSecret,
  pathTable,
  type RedactTarget,
} from "./redact.js";

/** Options for {@link createRecorder}. */
export interface RecorderOptions {
  /** The recording directory; created when missing. */
  dir: string;
  /** The instance origin being recorded. */
  origin: string;
  /** Keep names and emails (`--record-raw`). */
  raw?: boolean;
  /** Clock override (tests). */
  now?: () => Date;
}

/** Details of the recorded run, written to `index.json` by `finish`. */
export interface RecordingRun {
  version: string;
  checks: string[];
}

/** A recorder: a transport wrapper plus the call that writes the index. */
export interface Recorder {
  wrap(inner: Transport): Transport;
  finish(run: RecordingRun): void;
}

const TABLE_PATH = /^\/api\/now\/(?:v\d+\/)?table\//;

/** File names a recording holds: the index and one file per exchange. */
const RECORDING_FILE = /^(?:index|[0-9a-f]{16})\.json$/;

/** Owner-only modes for a recording (CFG-6). */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function redactTarget(key: RequestKey): RedactTarget {
  if (!TABLE_PATH.test(key.path)) return {};
  // CFG-18: a malformed escape in the table segment leaves no table (the
  // body is still redacted field by field), never a URIError.
  const table = pathTable(key.path);
  if (table === undefined) return {};
  const fields = key.query.sysparm_fields;
  const list =
    typeof fields === "string"
      ? fields
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f !== "")
      : undefined;
  return {
    table,
    ...(list && list.length > 0 ? { fields: list } : {}),
  };
}

/** Create a recorder writing into `opts.dir`. */
export function createRecorder(opts: RecorderOptions): Recorder {
  const origin = new URL(opts.origin).origin;
  const redactor = createRedactor({ origin, raw: opts.raw ?? false });
  mkdirSync(opts.dir, { recursive: true, mode: DIR_MODE });
  clearRecording(opts.dir);

  /**
   * Write `value` as JSON to `file`, refusing (SEC-9) when the text still
   * looks like it holds a secret after redaction.
   */
  function write(file: string, value: unknown) {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    if (looksSecret(content)) {
      throw new Error(
        `Refusing to write ${file}: it still looks like it holds a secret after redaction`,
      );
    }
    writeAtomic(file, content, { mode: FILE_MODE });
  }

  function record(key: RequestKey, exchange: Omit<RecordedExchange, "key">) {
    const table = pathTable(key.path);
    const query: Record<string, string | string[]> = Object.create(
      null,
    ) as Record<string, string | string[]>;
    for (const [name, value] of Object.entries(key.query)) {
      query[name] = Array.isArray(value)
        ? value.map((v) => redactor.query(name, v, table))
        : redactor.query(name, value, table);
    }
    const entry: RecordedExchange = {
      key: { ...key, path: redactor.text(key.path), query },
      ...exchange,
    };
    write(join(opts.dir, keyFile(key)), entry);
  }

  return {
    wrap(inner) {
      return async (url, init) => {
        const res = await inner(url, init);
        const key = requestKey(init.method, url, init.body);
        // Only instance API traffic is recorded: an OAuth token exchange
        // (`/oauth_token.do`, or another host) never reaches the disk.
        if (!url.startsWith(`${origin}/api/`) || res.status === 429) {
          return res;
        }
        const text = await res.text();
        let body: unknown;
        let parsed = false;
        if (text !== "") {
          try {
            body = JSON.parse(text);
            parsed = true;
          } catch {
            parsed = false;
          }
        }
        record(key, {
          status: res.status,
          statusText: res.statusText,
          headers: redactor.headers(res.headers),
          ...(parsed
            ? { body: redactor.body(body, redactTarget(key)) }
            : { text: redactor.text(text) }),
        });
        return { ...res, text: () => Promise.resolve(text) };
      };
    },
    finish(run) {
      const index: RecordingIndex = {
        format: RECORDING_FORMAT,
        tool: { name: "servicenow-preflight", version: run.version },
        recordedAt: (opts.now?.() ?? new Date()).toISOString(),
        instanceHostSha256: createHash("sha256")
          .update(new URL(origin).host)
          .digest("hex")
          .slice(0, 16),
        raw: opts.raw ?? false,
        checks: run.checks,
      };
      write(indexPath(opts.dir), index);
    },
  };
}

/** Remove what a previous recording left in `dir`, and nothing else. */
function clearRecording(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (!RECORDING_FILE.test(name)) continue;
    const file = join(dir, name);
    try {
      const st = lstatSync(file);
      if (st.isFile() || st.isSymbolicLink()) unlinkSync(file);
    } catch {
      // Gone already; nothing to clear.
    }
  }
}
