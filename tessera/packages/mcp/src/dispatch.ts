// One message in, at most one response out — and the delegation that makes this
// package a front-end rather than a second wiring of the pipeline.
//
// **ARCH-1, and why this file calls `main` instead of building a resolver.**
// `@tessera/cli` says it in its own barrel: "The public surface is exported for
// tests and for the future MCP server, which must reach the same wired pipeline
// rather than assemble a parallel one." So a tool call becomes an argv, and the
// argv goes through the same `main` the `tess` binary calls, with a `CliContext`
// whose sinks are arrays instead of a terminal. Nothing about resolvers,
// analyzers, profiles or config precedence is repeated here, which is the whole
// point: there is one composition root, and a second one is what "cannot drift"
// would have stopped being true.
//
// It buys three properties for free, and they are the ones that would be
// expensive to re-earn:
//
//   * the `--json` document is already golden-tested against the fake instance;
//   * TM-1 holds by construction — the analyzer hands back identities, enum
//     values and notes, and this layer never opens a script body, so a canary in
//     a body cannot reach a tool result through any path that exists here;
//   * QA-8's wording ("declared intent", "a spec that exists is not a spec that
//     passed") arrives inside the report rather than being paraphrased into a
//     tool description that could drift away from it.
//
// It also buys the fourth property, which arrived with `preflight_apply` and is
// the one that would have been most dangerous to re-earn: the §11 TargetGuard,
// the ARCH-3 single mutation channel and the §4b write-ahead intent ledger are
// INHERITED, not reimplemented. There is no writer in this package and no code
// path that could construct one — an apply is an argv, and everything that
// decides whether that argv is allowed to touch anything lives behind `main`,
// where the `tess` binary and this server meet it identically.
//
// **Notifications get no reply, ever** — including malformed ones. That is the
// JSON-RPC rule and it is load-bearing here: a `tools/call` sent without an id
// would otherwise run a full where-used search against a live instance — or, for
// the mutating tool, a full apply — and throw the answer away, so it is refused
// before it costs the operator anything.

import { instanceFromEnv, main, type CliContext } from "@tessera/cli";

import {
  ERROR_CODES,
  errorResponse,
  negotiateProtocolVersion,
  resultResponse,
  type RpcMessage,
  type RpcResponse,
} from "./protocol.js";
import {
  toolResultFor,
  type CommandOutcome,
  type ToolResult,
} from "./results.js";
import {
  findTool,
  toArgv,
  toolDefinition,
  TOOLS,
  validateArguments,
  type ToolSpec,
} from "./tools.js";

/**
 * Nothing is published from this workspace, so the version is the workspace's
 * own placeholder rather than a number a host could pin against.
 */
export const SERVER_INFO = {
  name: "tessera",
  // Deliberately without a count: the row list grows a tool at a time, and a
  // title that says "four" is wrong the moment one is added — as it already was.
  title:
    "Tessera preflight — read-only reports, a spec generator and guarded writers",
  version: "0.0.0",
} as const;

/**
 * Sent once, at `initialize`, and worth its length: it is the only place a host
 * reads the rules that make these reports safe to act on, and — since
 * `preflight_apply` — the only place it is told, before any tool list is
 * rendered, which of these tools write. Since `preflight_generate` it is also
 * the only place it is told that one of them can send instance content off the
 * machine, which is a fact a caller must never learn by having called it. All of
 * it is repeated per tool and per result, because an agent that has forgotten
 * the handshake is exactly the reader that needs it.
 */
const INSTRUCTIONS = [
  "Tessera runs preflight checks against a ServiceNow instance. Most of its tools are READ-ONLY — preflight_resolve, preflight_impact, preflight_coverage, preflight_doctor, preflight_plan and preflight_cleanup_legacy_plan read the instance, and preflight_run_status, preflight_confirm_ready and preflight_cleanup_plan read the local record a run left behind; none of them writes, creates, deletes or runs anything.",
  "",
  "preflight_apply is the exception: it WRITES to the runner instance, performing the provision plan that preflight_plan returns. Call preflight_plan first and read `plan.steps` — those are the writes. preflight_run WRITES to the runner as well, executing tests there, and preflight_cleanup_apply DELETES a finished run's ephemeral test records from it; call preflight_cleanup_plan first. No tool deletes the pre-marker rows preflight_cleanup_legacy_plan lists: that takes the operator at the command line.",
  "",
  "preflight_generate writes too, and it is unlike every tool here in two ways. It WRITES FILES into the repository — proposed test specs under the tests root — and it MAY SEND INSTANCE CONTENT OFF THIS MACHINE: if the operator configured the AI backend rather than the offline default, the call POSTs the impact graph, artifact names included, to that vendor's API. Nothing about that is a tool argument; it is the operator's configuration, and a call cannot switch it on or redirect it.",
  "",
  "Five rules govern how the results may be read:",
  "",
  "1. An error is never an empty answer. If a call fails, nothing was measured — do not report it as “nothing is impacted” or “no tests exist” (DEV-1).",
  "2. preflight_coverage reports DECLARED INTENT, not confirmed coverage. A spec that exists is not a spec that passed, and a gap is a hole in a plan rather than a defect in the code (QA-8).",
  "3. NOT READY out of preflight_plan or preflight_apply — or a NO_GO out of preflight_run or preflight_confirm_ready — is a verdict, not a fault. It arrives as an error result with the full report attached, so that it cannot be read as a pass; the report names the checks behind it, and an exit 1 can carry a check nobody could decide (DEV-2), so read the document rather than the exit code.",
  "4. REFUSED means NOTHING WAS WRITTEN. A §11 guard decides whether the runner may be written to at all, before any writer exists. It is not a failure to retry and not a judgement about the change, and nothing you can pass as a tool argument lifts it — the allowlist that grants writability belongs to the operator who runs this server. If a write is refused, say so and stop; do not look for another route to it.",
  "5. What preflight_generate writes is a PROPOSAL, not a test. The specs land unarmed, outside the manifest the runner reads, and the step that promotes them is a human being reading the diff in version control — no tool here does it. Report what was proposed and where; do not call it ready, passing or promoted, and do not feed its paths to a tool that executes specs (DEV-4).",
].join("\n");

/** Everything a tool call needs that is not in the call itself. */
export interface ServerContext {
  readonly now: () => Date;
  readonly actor: string;
  /** Config discovery and any relative `testsRoot` resolve against this. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Diagnostics. NEVER stdout — that channel carries the protocol, and one
   * stray line on it desynchronises the client for the rest of the session.
   */
  readonly log: (line: string) => void;
}

export interface Session {
  /** Set by `initialize`. Requests other than `ping` are refused before it. */
  initialized: boolean;
  /** Set by the `notifications/initialized` that completes the handshake. */
  ready: boolean;
  protocolVersion: string | undefined;
}

export function createSession(): Session {
  return { initialized: false, ready: false, protocolVersion: undefined };
}

/**
 * A `CliContext` whose terminal is two arrays.
 *
 * `instance` is derived from `SN_INSTANCE` exactly as `defaultContext()` derives
 * it — through the same `instanceFromEnv` — but from the server's injected env.
 * Without it every tool that documents "may instead come from SN_INSTANCE"
 * (`preflight_run`) answered "no instance" to an operator who had set it.
 */
function captureContext(
  context: ServerContext,
  stdout: string[],
  stderr: string[],
): CliContext {
  return {
    now: context.now,
    actor: context.actor,
    ...instanceFromEnv(context.env),
    cwd: context.cwd,
    env: context.env,
    stdout: (line) => {
      stdout.push(line);
    },
    stderr: (line) => {
      stderr.push(line);
    },
  };
}

/**
 * Run one tool through the composition root.
 *
 * `main` is documented as never throwing — it classifies what escapes a command
 * into an exit code — but it is called defensively all the same. A throw that
 * got out would be the one failure mode this whole package exists to prevent:
 * an exception swallowed into a green, empty result.
 */
export async function callTool(
  spec: ToolSpec,
  values: ReadonlyMap<string, string | readonly string[]>,
  context: ServerContext,
): Promise<ToolResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const argv = toArgv(spec, values);

  let code: number;
  try {
    code = await main(argv, captureContext(context, stdout, stderr));
  } catch (error) {
    stderr.push(
      `tess threw out of main(): ${error instanceof Error ? error.message : "a non-Error value"}`,
    );
    // Deliberately not one of the five known codes: it lands on the "unknown
    // exit" branch, which is an error result carrying the DEV-1 sentence.
    code = -1;
  }

  const outcome: CommandOutcome = {
    tool: spec.name,
    command: spec.command,
    code,
    stdout,
    stderr,
    // Carried, not inferred from the command name: `preflight` is two tools with
    // two different readings of exit 4, and only the spec knows which one ran.
    writeClass: spec.writeClass,
    reportsVerdict: spec.reportsVerdict,
    // Per-tool readings of exits 3/4 and of a relayed exit (decisions 14-15);
    // absent on most specs, and spread only when present so an outcome built
    // for a tool without them stays the shape it always was.
    ...(spec.relaysRecordedExit === true ? { relaysRecordedExit: true } : {}),
    ...(spec.refusalReading === undefined
      ? {}
      : { refusalReading: spec.refusalReading }),
    ...(spec.faultRemedy === undefined
      ? {}
      : { faultRemedy: spec.faultRemedy }),
  };
  return toolResultFor(outcome);
}

function toolsCall(
  message: RpcMessage,
  context: ServerContext,
): Promise<RpcResponse> | RpcResponse {
  const id = message.id ?? null;
  const name = message.params["name"];
  if (typeof name !== "string") {
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      "tools/call requires a `name` string",
    );
  }

  const spec = findTool(name);
  if (spec === undefined) {
    // A protocol error rather than an `isError` result, per the tools spec: an
    // unknown tool is a fact about this server, not an outcome of running one.
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      `unknown tool \`${name}\`; this server exposes ${TOOLS.map((tool) => tool.name).join(", ")}`,
    );
  }

  const validation = validateArguments(spec, message.params["arguments"]);
  if (!validation.ok) {
    // Also a protocol error, and this is the line the header's rule draws: what
    // can be proven wrong WITHOUT running anything is refused here; what only
    // the pipeline can refuse comes back as a tool result in the pipeline's own
    // words. A misspelled property is the first kind; a missing `--scope` is the
    // second, because config and environment may still supply it.
    return errorResponse(
      id,
      ERROR_CODES.invalidParams,
      `invalid arguments for ${spec.name}: ${validation.message}`,
    );
  }

  return callTool(spec, validation.values, context).then((result) =>
    resultResponse(id, { ...result }),
  );
}

/**
 * Dispatch one parsed message.
 *
 * Returns `undefined` when the message earns no reply — which is every
 * notification, and nothing else.
 */
export async function handleMessage(
  message: RpcMessage,
  session: Session,
  context: ServerContext,
): Promise<RpcResponse | undefined> {
  if (message.id === undefined) {
    if (message.method === "notifications/initialized") {
      session.ready = true;
      return undefined;
    }
    if (message.method.startsWith("notifications/")) {
      // Unknown notifications are ignored by contract — a receiver MUST NOT
      // respond to one, not even to say it did not understand it.
      return undefined;
    }
    context.log(
      `tessera-mcp: ignoring \`${message.method}\` — it was sent without an id, and a notification cannot be answered`,
    );
    return undefined;
  }

  const id = message.id;

  if (message.method === "initialize") {
    session.initialized = true;
    session.protocolVersion = negotiateProtocolVersion(
      message.params["protocolVersion"],
    );
    return resultResponse(id, {
      protocolVersion: session.protocolVersion,
      // Tools only — DR-6. Copilot supports no other primitive, and declaring a
      // capability this server does not implement is how a host discovers it the
      // expensive way. `listChanged` is false because the tool list is a
      // compile-time constant.
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }

  // Answered before the handshake on purpose: `ping` is a liveness check, and a
  // liveness check that requires liveness to have been established is useless.
  if (message.method === "ping") return resultResponse(id, {});

  if (!session.initialized) {
    return errorResponse(
      id,
      ERROR_CODES.invalidRequest,
      `\`${message.method}\` was received before \`initialize\`; the session must be negotiated first`,
    );
  }

  switch (message.method) {
    case "tools/list":
      // No `nextCursor`: the whole list is a handful of entries and always fits.
      return resultResponse(id, { tools: TOOLS.map(toolDefinition) });
    case "tools/call":
      return await toolsCall(message, context);
    default:
      return errorResponse(
        id,
        ERROR_CODES.methodNotFound,
        `\`${message.method}\` is not implemented; this server exposes the tools primitive only (DR-6)`,
      );
  }
}
