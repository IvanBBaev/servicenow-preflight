/**
 * F-X-6: replay mode. A transport that answers every request from a recording
 * directory and never opens a socket. A request with no recorded exchange
 * fails, so the check that made it fails closed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSnClient,
  TRANSPORT_WRAP,
  type InternalClientConfig,
  type SnClient,
  type Transport,
} from "../http/client.js";
import { describeKey, keyFile, requestKey } from "./key.js";
import { readRecording, type RecordedExchange } from "./recording.js";
import { PLACEHOLDER_ORIGIN } from "./redact.js";

/** A transport answering from the recording in `dir`. */
export function replayTransport(dir: string): Transport {
  readRecording(dir);
  return (url, init) => {
    const key = requestKey(init.method, url, init.body);
    const file = join(dir, keyFile(key));
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return Promise.reject(
        new Error(
          `No recorded response for ${describeKey(key)}; re-record with --record`,
        ),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return Promise.reject(
        new Error(`Recorded response ${file} is not valid JSON`),
      );
    }
    const problem = exchangeProblem(parsed, key.method);
    if (problem !== undefined) {
      return Promise.reject(
        new Error(
          `Recorded response ${file} is not a valid exchange: ${problem}`,
        ),
      );
    }
    const entry = parsed as RecordedExchange;
    const body =
      entry.body !== undefined
        ? JSON.stringify(entry.body)
        : (entry.text ?? "");
    return Promise.resolve({
      status: entry.status,
      statusText: entry.statusText ?? "",
      headers: entry.headers ?? {},
      text: () => Promise.resolve(body),
    });
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * CFG-18: why a parsed recording file is not an exchange for a `method`
 * request, or `undefined` when it is one. A hand-edited or truncated entry
 * fails the request instead of answering with `status: undefined`.
 */
function exchangeProblem(entry: unknown, method: string): string | undefined {
  if (!isPlainObject(entry)) return "not an object";
  const { status, statusText, headers, text, key } = entry;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    return "status is not an HTTP status code";
  }
  if (statusText !== undefined && typeof statusText !== "string") {
    return "statusText is not a string";
  }
  if (headers !== undefined) {
    if (!isPlainObject(headers)) return "headers is not an object";
    for (const value of Object.values(headers)) {
      if (typeof value !== "string") return "a header value is not a string";
    }
  }
  if (text !== undefined && typeof text !== "string") {
    return "text is not a string";
  }
  if (key !== undefined) {
    if (!isPlainObject(key)) return "key is not an object";
    if (key.method !== method) return `recorded for ${String(key.method)}`;
  }
  return undefined;
}

/** Options for {@link createReplayClient}. */
export interface ReplayClientOptions {
  /** The origin checks see; defaults to `https://instance.invalid`. */
  instanceUrl?: string;
  /** Share identical reads within a run (F-X-2); default `false`. */
  cache?: boolean;
}

/**
 * A credential-free {@link SnClient} that answers from a recording made with
 * `--record`. Pair it with `PreflightContext.replay` (from
 * {@link readRecording}) so credential-gated checks run.
 *
 * @example
 * ```ts
 * const recording = readRecording("fixtures/dev");
 * const report = await runPreflight({
 *   instanceUrl: "https://instance.invalid",
 *   http: createReplayClient("fixtures/dev"),
 *   replay: { dir: "fixtures/dev", recordedAt: recording.recordedAt },
 * });
 * ```
 */
export function createReplayClient(
  dir: string,
  opts: ReplayClientOptions = {},
): SnClient {
  const transport = replayTransport(dir);
  const cfg: InternalClientConfig = {
    instanceUrl: opts.instanceUrl ?? PLACEHOLDER_ORIGIN,
    ...(opts.cache ? { cache: true } : {}),
    [TRANSPORT_WRAP]: () => transport,
  };
  return createSnClient(cfg);
}
