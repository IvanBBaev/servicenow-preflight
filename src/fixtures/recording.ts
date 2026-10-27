/**
 * F-X-6: the on-disk shape of a recording. A recording directory holds one
 * `<sha256(key)[0..16]>.json` file per distinct request plus an `index.json`
 * describing the run that produced it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RequestKey } from "./key.js";

/** The recording format version written to `index.json`. */
export const RECORDING_FORMAT = 1;

/** The `index.json` of a recording directory. */
export interface RecordingIndex {
  format: 1;
  tool: { name: "servicenow-preflight"; version: string };
  /** ISO 8601 timestamp of when the recording finished. */
  recordedAt: string;
  /** First 16 hex chars of the SHA-256 of the recorded instance's host. */
  instanceHostSha256: string;
  /** `true` when names and emails were kept (`--record-raw`). */
  raw: boolean;
  /** The checks the recorded run reported on, in report order. */
  checks: string[];
}

/** One recorded exchange. Exactly one of `body` and `text` is set. */
export interface RecordedExchange {
  /** The request key, with secrets and the host redacted from query values. */
  key: RequestKey;
  status: number;
  statusText: string;
  /** Allowlisted response headers. */
  headers: Record<string, string>;
  /** The redacted JSON body. */
  body?: unknown;
  /** The redacted body text, when it was not JSON. */
  text?: string;
}

/** A recording directory that is missing or unreadable. */
export class RecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordingError";
  }
}

/** Path of the index file inside `dir`. */
export function indexPath(dir: string): string {
  return join(dir, "index.json");
}

/** Read and validate `dir`'s `index.json`. */
export function readRecording(dir: string): RecordingIndex {
  let text: string;
  try {
    text = readFileSync(indexPath(dir), "utf8");
  } catch {
    throw new RecordingError(
      `${dir} is not a recording: ${indexPath(dir)} is missing. Record one with --record ${dir}.`,
    );
  }
  let index: unknown;
  try {
    index = JSON.parse(text);
  } catch {
    throw new RecordingError(`${indexPath(dir)} is not valid JSON.`);
  }
  const value = index as Partial<RecordingIndex> | null;
  if (
    !value ||
    typeof value !== "object" ||
    value.format !== RECORDING_FORMAT ||
    typeof value.recordedAt !== "string" ||
    !Array.isArray(value.checks)
  ) {
    throw new RecordingError(
      `${indexPath(dir)} is not a format ${RECORDING_FORMAT} recording index.`,
    );
  }
  return value as RecordingIndex;
}
