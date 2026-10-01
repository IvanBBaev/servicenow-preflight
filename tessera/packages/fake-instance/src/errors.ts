// QA-18 — failure modes the fake can express that an HTTP *response* cannot.
//
// `@tessera/sn-client`'s transport (`core/http.ts`) distinguishes three
// outcomes: a parsed response, a rejected `fetch` (connection error), and an
// abort whose error is named `TimeoutError`/`AbortError`. The fake must be able
// to produce all three, so the two non-response outcomes are real thrown
// errors rather than status codes.

/** A rejected `fetch` — what the transport reports as "could not reach". */
export class FakeTransportError extends Error {
  constructor(message = "fake instance: simulated connection failure") {
    super(message);
    this.name = "FakeTransportError";
  }
}

/**
 * An aborted request. The `name` matters: `core/http.ts` maps `TimeoutError`
 * and `AbortError` to its "request timed out" branch, everything else to the
 * generic transport branch.
 */
export class FakeAbortError extends Error {
  constructor(
    message = "fake instance: request aborted",
    name: "TimeoutError" | "AbortError" = "TimeoutError",
  ) {
    super(message);
    this.name = name;
  }
}

/** The ServiceNow error body shape the transport's `extractErrorDetail` reads. */
export interface SnErrorBody {
  error: { message: string; detail: string };
  status: "failure";
}

export function snErrorBody(message: string, detail = message): SnErrorBody {
  return { error: { message, detail }, status: "failure" };
}

/**
 * The body a real instance returns for a *namespace* 404 (no such REST API).
 * `api/plugin.ts` keys its "plugin is inactive" detection on this wording, so
 * the fake reproduces it verbatim for unknown `/api/...` paths.
 */
export function namespace404Body(path: string): SnErrorBody {
  return snErrorBody(
    "The requested URI does not represent any resource on the server",
    `URI does not represent any resource: ${path}`,
  );
}

/** The body a real instance returns when a row does not exist. */
export function noRecordFoundBody(): SnErrorBody {
  return snErrorBody(
    "No Record found",
    "Record doesn't exist or ACL restricts the record retrieval",
  );
}
