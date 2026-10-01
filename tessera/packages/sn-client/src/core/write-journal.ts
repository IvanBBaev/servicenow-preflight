// Vendored from github.com/IvanBBaev/servicenow-mcp @ 5acdcc7 (src/core/write-journal.ts).
// MIT upstream; vendored by the sole author/copyright owner (ADR-002).

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getDocsDir } from "./settings.js";
import { activeProfile } from "./config.js";
import { logger } from "./logging.js";

/**
 * DF-2 — local, append-only audit trail for every applied write.
 *
 * The official MCP Server Console has AI Control Tower for audit and metering;
 * this client-side server has no such backstop, so every mutation it actually
 * executes is journalled locally under the docs directory, per profile. The
 * journal is written best-effort: a file-system failure is logged but never
 * blocks or fails the write that already happened on the instance.
 */

export type WriteAction = "create" | "update" | "delete" | "execute";

export interface JournalEntry {
  ts: string;
  profile: string;
  action: WriteAction;
  table: string;
  sys_id?: string;
  /**
   * The JSON body sent, when the transport could enumerate it as named values.
   * Absent means no such body was sent — NOT "the payload is unknown"; a
   * payload the transport could not enumerate sets `payload_unknown` instead.
   */
  fields?: Record<string, unknown>;
  /**
   * The query arguments sent, repeated keys preserved as arrays. For every
   * endpoint that takes its whole payload in the query string — the CI/CD
   * surface does — this is the record of *what* the write acted on, and
   * without it the entry names only the endpoint that was called.
   */
  params?: Record<string, string | string[]>;
  /**
   * Present and `true` when the write carried a payload this journal could not
   * decompose into named values (a pre-encoded `rawBody`, or a JSON body that
   * is not a plain object). The flag exists so the *absence* of `fields` and
   * `params` can be read as "nothing was sent" rather than "we did not look":
   * a consumer auditing what a write applied must treat an entry carrying it as
   * incomplete, never as a full record.
   */
  payload_unknown?: true;
}

/**
 * The payload column of the markdown row. It has to distinguish the three
 * states the jsonl line distinguishes — body fields, query arguments, and a
 * payload that was not recordable — or the human-readable half of the
 * journal goes silent exactly where the machine-readable half does not.
 */
function formatPayload(e: JournalEntry): string {
  const parts: string[] = [];
  if (e.fields) parts.push(...Object.keys(e.fields));
  if (e.params) parts.push(...Object.keys(e.params).map((key) => `?${key}`));
  if (e.payload_unknown) parts.push("(payload not recorded)");
  return parts.length > 0 ? parts.join(", ") : "—";
}

function formatMarkdownRow(e: JournalEntry): string {
  const target = e.sys_id ? `${e.table}/${e.sys_id}` : e.table;
  return `| ${e.ts} | ${e.action} | ${target} | ${formatPayload(e)} |\n`;
}

/**
 * Append one applied mutation to `<SN_DOCS_DIR>/<profile>/write-journal.{jsonl,md}`.
 * Returns the full entry (with timestamp + profile) so the tool can echo when it
 * was journalled. Never throws — journalling must not turn a successful write
 * into a tool error.
 */
export function appendWriteJournal(
  entry: Omit<JournalEntry, "ts" | "profile">,
): JournalEntry {
  const full: JournalEntry = {
    ts: new Date().toISOString(),
    profile: activeProfile(),
    ...entry,
  };
  try {
    const dir = path.join(getDocsDir(), full.profile);
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, "write-journal.jsonl"),
      JSON.stringify(full) + "\n",
    );
    appendFileSync(path.join(dir, "write-journal.md"), formatMarkdownRow(full));
  } catch (error) {
    logger.warn("write-journal append failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return full;
}
