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

/** Caps on each field, in UTF-16 code units. */
export const MAX_ID_CHARS = 120;
export const MAX_FILENAME_CHARS = 120;
export const MAX_TABLE_CHARS = 80;
export const MAX_SYS_ID_CHARS = 64;
export const MAX_TARGET_NAME_CHARS = 256;
export const MAX_TARGETS_PER_SPEC = 64;
export const MAX_MODEL_ID_CHARS = 200;

/**
 * True for a code unit that renders as nothing, reorders the line, or drives
 * the terminal: C0 controls (tab and newline included — none of these fields
 * spans lines), DEL, C1 controls, the bidi embeddings/overrides/isolates and
 * marks, the zero-width characters and BOM, and the Unicode line/paragraph
 * separators.
 */
function isUnsafeCodeUnit(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfeff
  );
}

/** Whether `text` carries any character `isUnsafeCodeUnit` refuses. */
export function hasUnsafeTextCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (isUnsafeCodeUnit(text.charCodeAt(i))) return true;
  }
  return false;
}

/**
 * Whether a short model-authored field is admissible: no unsafe character and
 * no longer than `max`. An empty string is the caller's business.
 */
export function isSafeField(text: string, max: number): boolean {
  return text.length <= max && !hasUnsafeTextCharacter(text);
}

/**
 * `text` made safe to print on one terminal line: a backslash becomes `\\`
 * and every unsafe character becomes `\u{XXXX}`, so the output is
 * unambiguous and the raw character never reaches the terminal.
 *
 * Delegated decision 2026-09-26: escape rather than drop. A dropped character
 * makes two different ids print identically, which is the confusion the
 * refusal upstream exists to prevent; an escape shows the reviewer exactly
 * what is there.
 */
export function escapeForTerminal(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    const code = text.charCodeAt(i);
    if (ch === "\\") out += "\\\\";
    else if (isUnsafeCodeUnit(code)) {
      out += `\\u{${code.toString(16).toUpperCase().padStart(4, "0")}}`;
    } else out += ch;
  }
  return out;
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
  let out = "";
  for (let i = 0; i < modelId.length; i += 1) {
    if (!isUnsafeCodeUnit(modelId.charCodeAt(i))) out += modelId.charAt(i);
  }
  return out.slice(0, MAX_MODEL_ID_CHARS);
}
