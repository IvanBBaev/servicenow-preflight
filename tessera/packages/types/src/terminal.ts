// Review W7b M1, AIS-4 — what a string read off an instance or out of a model
// may carry to a terminal, and how it is printed.
//
// A C0/C1 control character on a terminal line is an escape sequence; a bidi
// override makes the printed line read differently from the bytes on disk; a
// zero-width character makes two different names look identical. None of them
// has a use in an artifact name, an id or a path, so every place that PRINTS
// such a string escapes it with `escapeForTerminal`.
//
// It lives here, in the dependency every package already has, because the
// strings it guards enter in several packages (the resolvers, the impact
// lookups, the generator) and leave in several more (the CLI, the verdict's
// warning lines). `@tessera/generate`'s `fieldSafety.ts` re-exports it.

/**
 * True for a code unit that renders as nothing, reorders the line, or drives
 * the terminal: C0 controls (tab and newline included — none of the fields
 * this guards spans lines), DEL, C1 controls, the bidi embeddings/overrides/
 * isolates and marks, the zero-width characters and BOM, and the Unicode
 * line/paragraph separators.
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

/** Whether `text` carries any character `escapeForTerminal` would escape (besides `\`). */
export function hasUnsafeTextCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (isUnsafeCodeUnit(text.charCodeAt(i))) return true;
  }
  return false;
}

/**
 * `text` with every unsafe character removed. For provenance a provider
 * reports (a model id), where refusing would fail a batch over decoration.
 */
export function stripUnsafeTextCharacters(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (!isUnsafeCodeUnit(text.charCodeAt(i))) out += text.charAt(i);
  }
  return out;
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
