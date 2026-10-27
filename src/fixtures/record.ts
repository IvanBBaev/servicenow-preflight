/**
 * F-X-6: record mode. Wraps the client's real transport, passes every request
 * through unchanged, and writes a redacted copy of each instance API exchange
 * to the recording directory.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Transport } from "../http/client.js";
import { keyFile, requestKey, type RequestKey } from "./key.js";
import {
  indexPath,
  RECORDING_FORMAT,
  type RecordedExchange,
  type RecordingIndex,
} from "./recording.js";
import { createRedactor, type RedactTarget } from "./redact.js";

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

const TABLE_PATH = /^\/api\/now\/(?:v\d+\/)?table\/([^/]+)/;

function redactTarget(key: RequestKey): RedactTarget {
  const match = TABLE_PATH.exec(key.path);
  if (!match) return {};
  const fields = key.query.sysparm_fields;
  const list =
    typeof fields === "string"
      ? fields
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f !== "")
      : undefined;
  return {
    table: decodeURIComponent(match[1] as string),
    ...(list && list.length > 0 ? { fields: list } : {}),
  };
}

/** Create a recorder writing into `opts.dir`. */
export function createRecorder(opts: RecorderOptions): Recorder {
  const origin = new URL(opts.origin).origin;
  const redactor = createRedactor({ origin, raw: opts.raw ?? false });
  mkdirSync(opts.dir, { recursive: true });

  function record(key: RequestKey, exchange: Omit<RecordedExchange, "key">) {
    const query: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(key.query)) {
      query[name] = Array.isArray(value)
        ? value.map((v) => redactor.text(v))
        : redactor.text(value);
    }
    const entry: RecordedExchange = { key: { ...key, query }, ...exchange };
    writeFileSync(
      join(opts.dir, keyFile(key)),
      `${JSON.stringify(entry, null, 2)}\n`,
    );
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
      writeFileSync(indexPath(opts.dir), `${JSON.stringify(index, null, 2)}\n`);
    },
  };
}
