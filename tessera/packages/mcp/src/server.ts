// The stdio transport: newline-delimited JSON in, newline-delimited JSON out.
//
// DR-6 is why this is the only transport. The Copilot coding agent cannot
// complete an OAuth flow against a remote MCP server, so a server it can reach
// is one that runs beside it — stdio, launched by the host, authenticated by the
// environment it inherits. There is no HTTP surface here and adding one would
// need an answer to the authentication question DR-6 says nobody has yet.
//
// Two invariants hold the transport together:
//
//   * **stdout is the protocol.** Nothing but a response is ever written to it.
//     Diagnostics go to stderr through `ServerContext.log`, and the delegated
//     command's stdout is captured into an array rather than inherited — one
//     stray report line on this channel desynchronises the client for good.
//   * **One message at a time.** MCP permits concurrent requests, and this
//     server declines to take them: reads run through a process-global
//     credential registry, and interleaving them to shave wall-clock off an
//     operation whose cost is a live instance's response time would be trading
//     the property that makes the session debuggable for nothing.

import {
  createSession,
  handleMessage,
  type ServerContext,
  type Session,
} from "./dispatch.js";
import {
  ERROR_CODES,
  errorResponse,
  parseMessage,
  type RpcResponse,
} from "./protocol.js";

export interface Transport {
  /** Chunks, not lines — framing is this file's job, not the caller's. */
  readonly input: AsyncIterable<string | Uint8Array>;
  /** Writes one response. The newline terminator is added here. */
  readonly write: (line: string) => void;
}

/**
 * Handle one line and hand back the response owed for it, if any.
 *
 * Exported because it is the whole protocol surface minus the buffering, which
 * makes it the honest unit to test a malformed message against.
 */
export async function handleLine(
  line: string,
  session: Session,
  context: ServerContext,
): Promise<RpcResponse | undefined> {
  const parsed = parseMessage(line);
  if (!parsed.ok) {
    if (parsed.notification === true) {
      // Malformed AND id-less: logged, never answered (see `ParseOutcome`).
      context.log(
        `tessera-mcp: dropping a malformed message sent without an id — ${parsed.error.message}`,
      );
      return undefined;
    }
    return errorResponse(parsed.id, parsed.error.code, parsed.error.message);
  }

  try {
    return await handleMessage(parsed.message, session, context);
  } catch (error) {
    // `handleMessage` classifies everything a tool can do into a result, so
    // reaching here means the server itself broke. It is still an ERROR
    // response and never a result: a caller must not be able to read a crash in
    // this layer as an answer with nothing in it.
    const detail = error instanceof Error ? error.message : "a non-Error value";
    context.log(
      `tessera-mcp: internal error handling ${parsed.message.method}: ${detail}`,
    );
    if (parsed.message.id === undefined) return undefined;
    return errorResponse(
      parsed.message.id,
      ERROR_CODES.internal,
      `internal error handling \`${parsed.message.method}\`: ${detail}`,
    );
  }
}

/**
 * The longest line, in UTF-16 code units and without its `\n`, that `serve`
 * will hold while waiting for the newline that ends it.
 *
 * Delegated decision 2026-09-26: about 4 MiB. Every request this server takes
 * is a `tools/call` with a handful of short string arguments; the largest
 * honest message is kilobytes. Without a cap one host that never writes a
 * newline grows the buffer until the process dies, so a bound is owed, and
 * 4 MiB is three orders of magnitude of headroom over any real message while
 * still being a bound a laptop does not notice.
 */
export const MAX_PENDING_LINE_LENGTH = 4 * 1024 * 1024;

/**
 * Read messages until the input ends.
 *
 * A trailing fragment with no newline is still processed: a host that closes the
 * pipe after writing its last message without terminating it has sent a message,
 * and dropping it would look exactly like the server hanging.
 *
 * Delegated decision 2026-09-26: framing is linear in the input. Each chunk is
 * scanned for `\n` ONCE, from an offset that only moves forward, and the
 * unterminated tail is kept as a list of pieces joined only when its newline
 * arrives. The previous shape appended every chunk to one string and re-ran
 * `indexOf` over all of it, which made a newline-free flood quadratic (32 MiB in
 * 64 KiB chunks took ~16 s) and unbounded in memory.
 *
 * A line that passes `MAX_PENDING_LINE_LENGTH` is answered ONCE with a parse
 * error at a `null` id — the id, if any, is inside the text being discarded,
 * so there is nothing else honest to answer at — and everything up to the next
 * newline is then dropped unread. The stream resumes cleanly after it. An
 * oversize fragment still pending when the input ends was already answered and
 * is not dispatched.
 */
export async function serve(
  transport: Transport,
  context: ServerContext,
  session: Session = createSession(),
): Promise<void> {
  const decoder = new TextDecoder();
  /** The unterminated tail of the current line, in arrival order. */
  let pending: string[] = [];
  let pendingLength = 0;
  /** True once the current line passed the cap and was answered. */
  let discarding = false;

  const dispatch = async (raw: string): Promise<void> => {
    // Tolerate CRLF: a Windows host writing through a text-mode pipe is not a
    // protocol violation, and `\r` would otherwise ride along inside the last
    // JSON string on the line.
    const line = raw.replace(/\r$/, "").trim();
    if (line === "") return;
    const response = await handleLine(line, session, context);
    // `JSON.stringify` escapes every newline it emits, so one response is always
    // exactly one line — the framing cannot be broken by content.
    if (response !== undefined) transport.write(JSON.stringify(response));
  };

  const refuseOversize = (): void => {
    context.log(
      `tessera-mcp: discarding a line longer than ${MAX_PENDING_LINE_LENGTH} characters`,
    );
    transport.write(
      JSON.stringify(
        errorResponse(
          null,
          ERROR_CODES.parse,
          `parse error: a pending line passed ${MAX_PENDING_LINE_LENGTH} characters without a newline; it was discarded up to the next newline`,
        ),
      ),
    );
    pending = [];
    pendingLength = 0;
    discarding = true;
  };

  /** Add text that has no newline in it to the current line. */
  const hold = (text: string): void => {
    if (discarding || text === "") return;
    if (pendingLength + text.length > MAX_PENDING_LINE_LENGTH) {
      refuseOversize();
      return;
    }
    pending.push(text);
    pendingLength += text.length;
  };

  /**
   * Close the current line at a newline, ending any discard. A discarded line
   * holds nothing (`refuseOversize` empties `pending` and `hold` adds nothing
   * while discarding), so it dispatches "" and answers nothing for it.
   */
  const endLine = async (): Promise<void> => {
    const line = pending.join("");
    pending = [];
    pendingLength = 0;
    discarding = false;
    await dispatch(line);
  };

  const accept = async (text: string): Promise<void> => {
    let offset = 0;
    let index = text.indexOf("\n", offset);
    while (index >= 0) {
      hold(text.slice(offset, index));
      await endLine();
      offset = index + 1;
      index = text.indexOf("\n", offset);
    }
    hold(text.slice(offset));
  };

  for await (const chunk of transport.input) {
    await accept(
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true }),
    );
  }

  // Flush a multi-byte sequence the input ended in the middle of; it decodes to
  // U+FFFD rather than vanishing, so a torn final message is answered as the
  // malformed message it is instead of being read without its last bytes.
  await accept(decoder.decode());
  // A discarded line holds nothing (`refuseOversize` empties `pending` and
  // `hold` adds nothing while discarding), so this dispatches "" and answers
  // nothing for it.
  await dispatch(pending.join(""));
}

/** stdin/stdout, with the one rule this package has about them applied. */
export function stdioTransport(): Transport {
  process.stdin.setEncoding("utf8");
  return {
    input: process.stdin,
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}

export function defaultServerContext(): ServerContext {
  return {
    now: () => new Date(),
    // The host launched this process; whoever it launched it as is the actor.
    actor: process.env["USER"] ?? process.env["USERNAME"] ?? "mcp",
    cwd: process.cwd(),
    env: process.env,
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

/** The entry point the bin launcher calls. Returns when stdin closes. */
export async function run(): Promise<void> {
  await serve(stdioTransport(), defaultServerContext());
}
