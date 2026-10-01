// The write side — deliberately one method wide.
//
// ARCH-3: there is a SINGLE mutation channel, and it is `@tessera/sn-client`.
// Everything Tessera changes on an instance goes through `tableApi`, which is
// where the DEV-15 write journal and the DEV-24 read-only gate live. A second
// way to write would mean a write that is neither journalled nor gated, so this
// adapter adds no transport of its own — it only narrows the surface.
//
// ARCH-8: writes bind to the RUNNER. The doctor may read any role including
// `target`; nothing here may ever be pointed at one. Until the ARCH-1
// composition root lands (later in Phase 1) the sn-client credentials are
// ambient, so the binding is a wiring obligation on the caller rather than
// something this module can enforce — the transport-level DEV-24 gate is the
// backstop, and §11.5 has already refused a prod runner one layer up.

import { tableApi } from "@tessera/sn-client";

/** The outcome of one applied write, as the instance reported it back. */
export interface WriteOutcome {
  readonly table: string;
  readonly sysId: string;
  /** Fields the instance echoed after the write, for the audit trail. */
  readonly record: Readonly<Record<string, unknown>>;
}

export interface InstanceWriter {
  updateRecord(
    table: string,
    sysId: string,
    fields: Readonly<Record<string, string>>,
  ): Promise<WriteOutcome>;
}

/** The live adapter. Throws on failure — apply() decides what a failure means. */
export function createSnInstanceWriter(): InstanceWriter {
  return {
    async updateRecord(table, sysId, fields) {
      const record = await tableApi.updateRecord(table, sysId, { ...fields });
      return { table, sysId, record };
    },
  };
}
