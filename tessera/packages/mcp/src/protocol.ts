// JSON-RPC 2.0, hand-rolled, and the framing MCP puts around it over stdio.
//
// Hand-rolled rather than `@modelcontextprotocol/sdk` for one reason that is
// worth stating rather than assuming: this workspace has ZERO runtime
// dependencies, and every gate record so far has claimed that as a property. DR-6
// narrows the surface far enough to make the trade cheap — Copilot supports the
// TOOLS primitive only, so there are no resources, no prompts, no subscriptions
// and no sampling to implement. What is left is five methods and an error table.
// If a later phase needs the parts of the protocol this file does not have
// (progress, cancellation, elicitation), taking the SDK then is a smaller change
// than un-taking it now would be.
//
// Two decisions in here are protocol conformance, not taste:
//
//   * **A null request id is invalid.** JSON-RPC allows it; MCP forbids it
//     ("the request ID MUST NOT be null"). Rejecting it keeps `id === undefined`
//     meaning exactly one thing — this is a notification — which is what the
//     dispatcher branches on when it decides whether a reply exists at all.
//   * **Batches are refused.** JSON-RPC 2.0 has them; MCP removed them in
//     2025-06-18. Refusing with a message that says so beats accepting them for
//     one client and having the next one meet a shape nothing else supports.

/** The MCP revisions this server can speak, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** What an `initialize` with no — or an unknown — version negotiates down to. */
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * The JSON-RPC error table. `-32000..-32099` is the implementation-defined
 * range and is deliberately unused: everything this server refuses is refused
 * for a reason the standard codes already name, and a private code would make a
 * client guess.
 */
export const ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** MCP forbids `null`, so an incoming id is one of these two or absent. */
export type RequestId = string | number;

/** A reply to something unparseable has no id to echo, hence `null` here. */
export type ResponseId = RequestId | null;

export interface RpcError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly data?: unknown;
}

/** A validated incoming message. `id === undefined` ⇔ notification. */
export interface RpcMessage {
  readonly id: RequestId | undefined;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export type ParseOutcome =
  | { readonly ok: true; readonly message: RpcMessage }
  | {
      readonly ok: false;
      readonly notification?: false;
      readonly id: ResponseId;
      readonly error: RpcError;
    }
  /**
   * A malformed message with NO `id` member: it earns no reply. Delegated
   * decision 2026-09-25 — the dispatcher's invariant ("notifications get no
   * reply, ever — including malformed ones") is kept rather than weakened. A
   * message without an `id` is written the way a notification is written, and
   * answering it at `id: null` would hand the client a response it never asked
   * for and cannot correlate. It is logged and dropped. A malformed message
   * that DOES carry an id is still answered (-32600 / -32602 at that id), and
   * input that is not a JSON object at all (a parse error, a batch, a scalar)
   * has no `id` member to read and is still answered at `id: null`, as
   * JSON-RPC requires.
   */
  | {
      readonly ok: false;
      readonly notification: true;
      readonly error: RpcError;
    };

export interface RpcResultResponse {
  readonly jsonrpc: "2.0";
  readonly id: ResponseId;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface RpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: ResponseId;
  readonly error: RpcError;
}

export type RpcResponse = RpcResultResponse | RpcErrorResponse;

export function resultResponse(
  id: ResponseId,
  result: Readonly<Record<string, unknown>>,
): RpcResultResponse {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(
  id: ResponseId,
  code: ErrorCode,
  message: string,
  data?: unknown,
): RpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

/** Never `String(error)` on an unknown: an object with no `toString` throws. */
function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

function failure(
  id: ResponseId,
  code: ErrorCode,
  message: string,
): ParseOutcome {
  return { ok: false, id, error: { code, message } };
}

/**
 * Read the id field without deciding anything else about the message.
 *
 * Returns `undefined` for a notification and `false` for an id that is present
 * but not a legal one — a distinction the caller needs, because a message with a
 * malformed id cannot be answered at that id.
 */
function readId(
  record: Record<string, unknown>,
): RequestId | undefined | false {
  if (!("id" in record)) return undefined;
  const id = record["id"];
  if (typeof id === "string" || typeof id === "number") return id;
  return false;
}

/**
 * One line of stdin → a message or the error response owed for it.
 *
 * Everything is validated here rather than in the dispatcher so that the
 * dispatcher's switch can be about MCP semantics alone. `JSON.parse` returns
 * `any`; it is bound to `unknown` on purpose, so the type checker forces every
 * field below through a narrowing check instead of trusting the wire.
 */
export function parseMessage(line: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return failure(
      null,
      ERROR_CODES.parse,
      `line is not JSON: ${describeThrown(error)}`,
    );
  }

  if (Array.isArray(parsed)) {
    return failure(
      null,
      ERROR_CODES.invalidRequest,
      "JSON-RPC batches are not supported — MCP removed them in revision 2025-06-18; send one message per line",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    return failure(
      null,
      ERROR_CODES.invalidRequest,
      "a message must be a JSON object",
    );
  }

  const record = parsed as Record<string, unknown>;

  const id = readId(record);
  if (id === false) {
    return failure(
      null,
      ERROR_CODES.invalidRequest,
      "id must be a string or a number — MCP forbids a null id, and omitting the field is how a notification is written",
    );
  }

  // No `id` member: whatever else is wrong with it, it is a notification, and a
  // notification is never answered (see `ParseOutcome`).
  const fail = (code: ErrorCode, message: string): ParseOutcome =>
    id === undefined
      ? { ok: false, notification: true, error: { code, message } }
      : failure(id, code, message);

  if (record["jsonrpc"] !== "2.0") {
    return fail(ERROR_CODES.invalidRequest, 'jsonrpc must be the string "2.0"');
  }

  const method = record["method"];
  if (typeof method !== "string" || method === "") {
    return fail(
      ERROR_CODES.invalidRequest,
      "method must be a non-empty string",
    );
  }

  const params = record["params"];
  if (
    params !== undefined &&
    (typeof params !== "object" || params === null || Array.isArray(params))
  ) {
    return fail(
      ERROR_CODES.invalidParams,
      "params must be an object when present — positional parameters are not used by MCP",
    );
  }

  return {
    ok: true,
    message: {
      id,
      method,
      params: (params ?? {}) as Record<string, unknown>,
    },
  };
}

/**
 * Pick the revision to answer `initialize` with.
 *
 * Echo what the client asked for when it is supported, otherwise offer the
 * newest this server speaks and let the client decide whether it can live with
 * it — which is what the specification prescribes, and is also the only
 * behaviour that does not silently pretend to speak a revision it does not.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}
