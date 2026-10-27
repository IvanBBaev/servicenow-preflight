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
    let entry: RecordedExchange;
    try {
      entry = JSON.parse(text) as RecordedExchange;
    } catch {
      return Promise.reject(
        new Error(`Recorded response ${file} is not valid JSON`),
      );
    }
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
