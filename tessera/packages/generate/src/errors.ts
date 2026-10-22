// Two error classes, mirroring `@tessera/specs` for the same reason: the caller
// has to do two different things, and the DEV-1 line runs between them.
//
// No spec source, model prose or instance text ever reaches a message thrown
// from this package. A generator that quoted the offending script back into an
// exception would re-open the TM-1 hole its own gate exists to close — the
// exception travels to a log, a CI annotation, a chat notification and, through
// the MCP relay, the context of the next model, none of which the untrusted
// string was cleared to reach. Errors here carry counts, rule names and file
// paths.
//
// There is exactly ONE piece of model-authored text that may appear, and the
// exception is stated here rather than left to be discovered: a proposed spec's
// ID or FILENAME, quoted by `./writer.ts` in the message that says why that
// name was refused. A rejection a caller cannot locate is barely a rejection,
// and the name is the location. It is quoted only after that file has PROVEN it
// short (at most `MAX_NAME_CHARS`) and free of control, C1 and bidi-format
// characters — the checks that establish those two facts run first and describe
// a failing name by its length and their own rule, never by its text. So the
// most a hostile name can spend in a log is 120 printable characters that
// cannot forge their own rendering. Nothing else about a spec is quotable: not
// its source, not its targets, not the prose the model wrapped around them.

/**
 * The request is malformed: an unsupported `TestKind`, a blank label, a target
 * that cannot be turned into a path segment, a tests root that is not usable.
 * The fix is a different argument, not a retry.
 */
export class GenerateInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GenerateInputError";
  }
}

/**
 * The environment failed underneath a well-formed request — the provider
 * answered with an error envelope, the response did not parse, the write could
 * not be completed.
 *
 * This is a THROW and not an empty result, for the OPP-1b reason `@tessera/specs`
 * writes out over `SpecStoreFaultError`: an empty spec list is a CLAIM ("nothing
 * here is worth testing"), and it is the most dangerous wrong answer a generator
 * can give. A provider outage that degraded into "no tests needed" would read
 * downstream as a clean bill of health.
 */
export class GenerationFaultError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GenerationFaultError";
  }
}

/** An error class name: `Error`, or a capitalised identifier ending in Error/Exception. */
const ERROR_NAME = /^(?:[A-Z][A-Za-z]{0,47})?(?:Error|Exception)$/;

/** A system or library error code such as `ECONNRESET` or `UND_ERR_SOCKET`. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

function codeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : undefined;
}

/**
 * A log-safe summary of an upstream failure: its class name and its error
 * code, and nothing else (AIS-5).
 *
 * An upstream error's MESSAGE is never quoted and the error is never attached
 * as a `cause`: a transport error routinely carries a URL with a query string,
 * a vendor SDK quotes the response it choked on, and both serialise through
 * `util.inspect`, a JSON logger or a CI annotation that walks `cause`. The two
 * fields kept here are matched against a closed identifier shape, so free text
 * in either — a secret, a response fragment — is dropped rather than echoed.
 * The code is read from the error itself or, as `fetch` reports it, from its
 * own `cause` one level down.
 *
 * @returns `" (TypeError, ECONNRESET)"`, `" (AbortError)"`, or `""`.
 */
export function faultSummary(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error && ERROR_NAME.test(error.name)) {
    parts.push(error.name);
  }
  const code =
    codeOf(error) ?? (error instanceof Error ? codeOf(error.cause) : undefined);
  if (code !== undefined) parts.push(code);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}
