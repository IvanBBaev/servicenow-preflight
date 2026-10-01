// Canonical serialization + digests for deterministic verdicts (DESIGN §6a).
// node:crypto hashing is pure in the sense the reducer requires: no I/O, no
// clock, no randomness — byte-identical output for byte-identical input.

import { createHash, createHmac } from "node:crypto";
import type { TestSpecRef } from "@tessera/types";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = canonicalize(source[key]);
      if (entry !== undefined) {
        out[key] = entry;
      }
    }
    return out;
  }
  return value;
}

/**
 * JSON with recursively sorted object keys — the byte-stable form used for
 * golden fixtures and the ConfirmToken digest (§6a determinism rules).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hmacSha256Hex(key: string, input: string): string {
  return createHmac("sha256", key).update(input, "utf8").digest("hex");
}

/**
 * Canonical identity of a spec across planned/demanded/result joins.
 * NUL cannot appear in either field, so the key is collision-free.
 * ProjectionMap (@tessera/types) is keyed by this same string.
 */
export function specKey(ref: TestSpecRef): string {
  return `${ref.id}\u0000${ref.path}`;
}
