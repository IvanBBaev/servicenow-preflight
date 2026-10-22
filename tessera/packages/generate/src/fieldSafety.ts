// Review W7b, M1 — the short model-authored fields (an id, a filename, a
// target's table, sys_id and name, the model id) and what may be in them.
//
// These fields are not gated source. They travel to a terminal (`tessera
// generate` prints them), into a manifest a reviewer reads, and into a path.
// A C0/C1 control character there is a terminal escape sequence; a bidi
// override makes the printed line read differently from the bytes on disk; a
// zero-width character makes two different ids look identical. None of them
// has a use in any of these fields, so they are refused where the fields enter
// (`parseCandidates`, the quality bar) and escaped where they leave (the CLI).
//
// The length caps are the same idea: a thousand-character "id" is not an id
// this pipeline asked for, and printing it is a reviewer scrolling past the
// thing they were supposed to read.

import {
  escapeForTerminal,
  hasUnsafeTextCharacter,
  stripUnsafeTextCharacters,
} from "@tessera/types";

/** Caps on each field, in UTF-16 code units. */
export const MAX_ID_CHARS = 120;
export const MAX_FILENAME_CHARS = 120;
export const MAX_TABLE_CHARS = 80;
export const MAX_SYS_ID_CHARS = 64;
export const MAX_TARGET_NAME_CHARS = 256;
export const MAX_TARGETS_PER_SPEC = 64;
export const MAX_MODEL_ID_CHARS = 200;

// The character class and the escape moved to `@tessera/types` (AIS-4): the
// resolvers and the impact lookups ingest instance names too, and the core's
// verdict warnings print them. Re-exported so this package's surface is
// unchanged.
export { escapeForTerminal, hasUnsafeTextCharacter };

/**
 * Whether a short model-authored field is admissible: no unsafe character and
 * no longer than `max`. An empty string is the caller's business.
 */
export function isSafeField(text: string, max: number): boolean {
  return text.length <= max && !hasUnsafeTextCharacter(text);
}

/**
 * The provider-reported model id, stripped of unsafe characters and capped.
 *
 * Delegated decision 2026-09-26: sanitised rather than refused. The model id
 * is provenance, reported by the provider rather than written by the model's
 * output, and a batch should not fail because a proxy decorated it; but it is
 * written into the proposed manifest a reviewer reads, so it carries nothing
 * that could drive a terminal and nothing past the cap.
 */
export function sanitizeModelId(modelId: string): string {
  return stripUnsafeTextCharacters(modelId).slice(0, MAX_MODEL_ID_CHARS);
}
