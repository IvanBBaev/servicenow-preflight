// QA-18 — deterministic identity generation for the stateful fake instance.
//
// A Tier-2 CI job that replays deterministically cannot mint identifiers from
// `Math.random()` or the wall clock: two runs of the same scenario must produce
// byte-identical sys_ids so a golden assertion (and a crash-recovery replay)
// stays stable. Ids are therefore a pure function of (seed, table, ordinal).

import { createHash } from "node:crypto";

/** ServiceNow sys_ids are 32 lowercase hex characters. */
export const SYS_ID_LENGTH = 32;

/** Mints sys_ids; injectable so a test can pin or stub identity generation. */
export interface IdGenerator {
  /** Next sys_id for `table`. Same seed + same call order => same id. */
  next(table: string): string;
  /** How many ids this generator has minted for `table`. */
  count(table: string): number;
  /** Forget all ordinals (used by `FakeInstance.reset`). */
  reset(): void;
}

/**
 * Derive a stable 32-hex id from an opaque key. SHA-256 is used purely as a
 * deterministic mixing function — nothing here is a security boundary.
 */
export function deriveSysId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, SYS_ID_LENGTH);
}

/**
 * Seeded, per-table counter generator. The ordinal is per table so inserting
 * into an unrelated table cannot shift the ids a scenario already asserted on.
 */
export function createIdGenerator(seed = "tessera"): IdGenerator {
  const ordinals = new Map<string, number>();
  return {
    next(table: string): string {
      const ordinal = (ordinals.get(table) ?? 0) + 1;
      ordinals.set(table, ordinal);
      return deriveSysId(`${seed}|${table}|${ordinal}`);
    },
    count(table: string): number {
      return ordinals.get(table) ?? 0;
    },
    reset(): void {
      ordinals.clear();
    },
  };
}
