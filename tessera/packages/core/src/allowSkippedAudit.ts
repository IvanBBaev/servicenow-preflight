// The `allow-skipped` audit producer (§6a override, §9.5) — delegated decision
// 2026-09-23, TODO~175.
//
// The ledger vocabulary gained `allow-skipped` together with its producer, so
// the kind never exists without something that writes it. This is that
// producer: it reads an ACCEPTED override off a verdict the reducer already
// resolved, never off the caller's flag, because the reducer is the one place
// `affectedRows` is recomputed from the rows it actually flipped (see
// aggregateVerdict.ts). Wiring it to `--allow-skipped` / the MCP surface is
// the CLI's job; nothing here decides WHETHER an override is allowed.

import type {
  IntentLedger,
  LedgerAuditInput,
  LedgerAuditRecord,
} from "@tessera/ledger";
import type { PreflightVerdict } from "@tessera/types";

export interface AllowSkippedAuditMeta {
  /** Which surface passed the override: cli / config / mcp (§9.5). */
  surface: string;
  /**
   * Overrides the override record's own `actor`. Omit it: the reducer copied
   * the actor from the record that was actually applied.
   */
  actor?: string;
  /** ISO timestamp; the ledger stamps its own clock when omitted. */
  at?: string;
}

/**
 * The audit input for the `allow-skipped` override `verdict` carries, or
 * `undefined` when it carries none. An override that flipped nothing
 * (`affectedRows: 0`) still yields one: the audit trail keeps what the actor
 * asked for, as the verdict digest does.
 *
 * `specs` are the rows the reducer marked `overridden`, in the verdict's
 * deterministic row order. `affectedRows` is the reducer's count; the ledger
 * refuses the record if the two disagree, so a hand-edited verdict fails
 * closed at the write rather than landing a self-contradicting audit line.
 */
export function allowSkippedAuditInput(
  verdict: PreflightVerdict,
  meta: AllowSkippedAuditMeta,
): LedgerAuditInput | undefined {
  const override = verdict.overrides.find(
    (record) => record.flag === "allow-skipped",
  );
  if (override === undefined) {
    return undefined;
  }
  const input: LedgerAuditInput = {
    kind: "allow-skipped",
    runId: verdict.runId,
    actor: meta.actor ?? override.actor,
    surface: meta.surface,
    affectedRows: override.affectedRows,
    specs: verdict.rows
      .filter((row) => row.overridden)
      .map((row) => ({ id: row.spec.id, path: row.spec.path })),
    verdictStatus: verdict.status,
  };
  if (meta.at !== undefined) {
    input.at = meta.at;
  }
  return input;
}

/**
 * Append the `allow-skipped` audit record for `verdict` to the run's audit
 * log. Resolves `undefined`, having written nothing, when the verdict carries
 * no such override. Throws whatever `appendAudit` throws — an override that
 * cannot be audited must not be silently accepted.
 */
export async function recordAllowSkipped(
  ledger: Pick<IntentLedger, "appendAudit">,
  verdict: PreflightVerdict,
  meta: AllowSkippedAuditMeta,
): Promise<LedgerAuditRecord | undefined> {
  const input = allowSkippedAuditInput(verdict, meta);
  return input === undefined ? undefined : await ledger.appendAudit(input);
}
