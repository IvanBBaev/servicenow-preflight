// PLAN Phase 5 — the transport seam of the ATF runner adapter.
//
// `@tessera/sn-client` exposes no client *object*: the transport is the free
// function `snRequest`, which reads ambient credentials, enforces the DEV-24
// write gate and journals mutations (DEV-15). That is the right production
// transport, but a free function is not injectable, and DR-2 is exactly the
// class of bug that survives when an adapter can only be exercised against a
// live instance. So this module declares the narrow port the runner actually
// needs — one method, two verbs, no auth surface — and ships the live adapter
// over `snRequest` next to it. Tests bind the same port to
// `@tessera/fake-instance` without touching globals; production binds it to the
// real transport. The runner never imports `snRequest` directly.
//
// The port deliberately has NO `signal` field. `snRequest` owns its own timeout
// signal and offers no seam to pass one down, so a `signal` here would be a
// promise the live adapter cannot keep. ARCH-28 cancellation is therefore
// honoured strictly *between* requests (poll loop and runner check
// `ctx.signal` before every round-trip); an in-flight request is allowed to
// finish and its result is discarded. This is the honest boundary, and it is
// safe because the runner deletes nothing — reclamation of a run abandoned
// mid-flight is the orphan sweep's job (ARCH-28/DEV-17).
//
// This module also owns the package's single rejection type and the one
// function that produces it from a transport failure — see the boundary note
// above `toInfrastructureError` for why the port normalises rather than leaks.

import { snRequest } from "@tessera/sn-client";

/** One ServiceNow REST call, reduced to what the ATF adapter issues. */
export interface AtfRequest {
  readonly method: "GET" | "POST";
  /** Absolute API path under the instance origin, e.g. `/api/now/table/x`. */
  readonly path: string;
  readonly params?: URLSearchParams;
}

/** The parsed response envelope. `data` is the RAW body — `{ result: … }`. */
export interface AtfResponse<T> {
  readonly data: T;
  readonly status: number;
  /** `X-Total-Count`, when the endpoint supplies it. */
  readonly total?: number;
}

/**
 * The transport port. Structurally satisfied by `snRequest` itself, so the
 * live adapter below is a pass-through rather than a translation layer.
 */
export interface AtfHttpClient {
  request<T>(args: AtfRequest): Promise<AtfResponse<T>>;
}

/** Options for {@link AtfInfrastructureError}: `cause`, plus a lifted status. */
export interface AtfFaultOptions extends ErrorOptions {
  /**
   * HTTP status of the underlying failure, when there was one. Lifted onto the
   * fault so a caller can answer "was this a 403?" without knowing which
   * transport library produced it — see the boundary note below.
   */
  readonly status?: number;
}

/**
 * DEV-1 — the adapter-fault marker, and the ONLY type this package rejects
 * with. Every rejection out of `triggerSuite`, `pollUntilTerminal`,
 * `parseSpecResults` and `Runner.run` is one of these; anything else escaping
 * is a bug in this package, not a fault of the instance.
 *
 * The runner must *resolve* a `RunResult` for anything that is evidence about a
 * test (including "the suite never finished") and *reject* only when the
 * adapter itself could not produce evidence: transport failure, an HTTP error,
 * an unparseable response, or a spec the projection cannot attribute. Throwing
 * this type — rather than a bare `Error` — keeps that distinction greppable and
 * lets a caller tell an adapter fault from a programming bug.
 */
export class AtfInfrastructureError extends Error {
  /**
   * HTTP status when the fault came from a response, `undefined` otherwise (a
   * socket error, a policy denial, an unparseable body). Always an own
   * property, so `"status" in error` is not a classification test — read the
   * value.
   */
  readonly status: number | undefined;

  constructor(message: string, options: AtfFaultOptions = {}) {
    super(message, options);
    this.name = "AtfInfrastructureError";
    this.status = options.status;
  }
}

// ── The DEV-1 error boundary ────────────────────────────────────────────────
//
// PLAN recorded this as open rather than decided: `triggerSuite` used to
// surface `@tessera/sn-client`'s `ServiceNowError` as-is, so the package
// rejected with two unrelated types depending on WHERE the fault arose —
// adapter-authored faults carried `AtfInfrastructureError`, transport faults
// carried whatever the bound client threw. It is now normalised, on the
// runner's side of the transport port. Three things in this code decided it:
//
//   1. The port's error type is unconstrained and TypeScript cannot constrain
//      it. `AtfHttpClient` is an interface; anything can be bound to it, and
//      the suites already bind three transports (the live one, the fake
//      instance, a scripted handler). Classifying a fault by catching
//      `ServiceNowError` means writing against one implementation of a port
//      that promises nothing about error types, and silently ceasing to catch
//      the day a different transport is bound. Normalising HERE holds for every
//      binding; normalising inside `createSnAtfClient` would not.
//
//   2. The inconsistency was the actual defect, not the leak. `trigger.ts`,
//      `poll.ts` and `results.ts` each mixed the two types across the same
//      failure class, so which type a caller met was decided by which
//      round-trip happened to fail first. A caller who wrote
//      `if (e instanceof AtfInfrastructureError)` against the fault they hit
//      first had a half-correct handler and no way to discover it.
//
//   3. Nothing downstream reads the type today, which is precisely why the leak
//      looked free. `core`'s run loop classifies POSITIONALLY — any rejection
//      out of `Runner.run` is a DEV-1 infra fault — and flattens it to
//      `${name}: ${message}`. The bill for the leak is paid later, by the
//      composition root and the next runner adapter, which would otherwise
//      have to depend on a ServiceNow client to interrogate a `Runner`.
//
// The argument against — normalising destroys the diagnostic — is real, and it
// is answered structurally rather than promised:
//   * the original error is kept verbatim as `cause`, so its status, its parsed
//     response body (`ServiceNowError.detail`) and its message stay reachable
//     as DATA, not as text a human has to parse back out of a string;
//   * its `name: message` is quoted into the wrapper's message anyway, because
//     `core` flattens a rejection to text for the report and a 403's "why" has
//     to survive that flattening;
//   * `status` is lifted onto the fault itself, because HTTP status is the one
//     field this codebase actually branches on (`doctor/src/probe.ts`,
//     `parity/src/reader.ts` and `resolvers/src/read.ts` all test
//     `error instanceof ServiceNowError && error.status === …`). Lifting it is
//     what turns "do not import the vendored client" from a slogan into
//     something a caller can actually honour.
//
// Two things are deliberately NOT wrapped. `createSnAtfClient` stays a
// pass-through: it is the far side of the port, and a transport that renamed
// its own errors would make the runner's normalisation untestable — the suites
// need a client that throws a foreign type. And the wrap covers exactly the
// `client.request` call, never the parsing around it, so a `TypeError` from a
// bug in THIS package still escapes as a `TypeError` — the "adapter fault vs
// programming bug" distinction the marker type exists for. The residue: a bug
// *inside* a bound client is reported as an infrastructure fault. That is the
// fail-closed direction, and it is how `core` classifies it either way.

/** `${name}: ${message}` for an `Error`, `String(value)` for anything else. */
function describeCause(error: unknown): string {
  if (error instanceof Error) {
    return error.message === ""
      ? error.name
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Read a numeric `status` off an unknown thrown value. Structural on purpose:
 * an `instanceof ServiceNowError` check would re-couple this module to one
 * transport, and the port allows any.
 */
function statusOf(error: unknown): number | undefined {
  const status = asRecord(error)?.["status"];
  return typeof status === "number" && Number.isFinite(status)
    ? status
    : undefined;
}

/**
 * Normalise anything thrown by a transport into the package's one fault type.
 * Idempotent: an {@link AtfInfrastructureError} passes through untouched, so
 * the innermost (most specific) message survives and causes never nest twice.
 *
 * @param context what was being attempted, e.g. `GET /api/now/table/x (read of x)`
 */
export function toInfrastructureError(
  context: string,
  error: unknown,
): AtfInfrastructureError {
  if (error instanceof AtfInfrastructureError) return error;
  const status = statusOf(error);
  const where = status === undefined ? context : `${context} (HTTP ${status})`;
  return new AtfInfrastructureError(
    `${where} failed: ${describeCause(error)}`,
    { cause: error, ...(status === undefined ? {} : { status }) },
  );
}

/**
 * The one place the runner talks to the transport port. Every round-trip in
 * this package goes through here, which is what makes the boundary above true
 * rather than aspirational — see `trigger.ts`, `poll.ts` and `results.ts`.
 *
 * `return await` is load-bearing: without it the rejection escapes the `try`.
 */
export async function requestOrFault<T>(
  client: AtfHttpClient,
  args: AtfRequest,
  context: string,
): Promise<AtfResponse<T>> {
  try {
    return await client.request<T>(args);
  } catch (error) {
    throw toInfrastructureError(context, error);
  }
}

/** The live adapter over `@tessera/sn-client`'s canonical transport. */
export function createSnAtfClient(): AtfHttpClient {
  return {
    async request<T>(args: AtfRequest): Promise<AtfResponse<T>> {
      const response = await snRequest<T>({
        method: args.method,
        path: args.path,
        ...(args.params ? { params: args.params } : {}),
      });
      return {
        data: response.data,
        status: response.status,
        ...(response.total === undefined ? {} : { total: response.total }),
      };
    },
  };
}

/** Narrow an unknown JSON value to a plain object without an `any` cast. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Unwrap the `{ result: … }` envelope every ServiceNow REST API uses. Returns
 * `undefined` rather than throwing so each call site can raise an
 * `AtfInfrastructureError` naming the endpoint it was talking to.
 */
export function unwrapResult(body: unknown): unknown {
  const envelope = asRecord(body);
  if (envelope === undefined) return undefined;
  return envelope["result"];
}

/**
 * Read one field of a Table-API row as a string. With
 * `sysparm_display_value=false` every field arrives as a string, but a
 * reference field can still arrive as `{ value, display_value }` on an
 * instance configured otherwise — stringifying that blindly would yield
 * `"[object Object]"`, so the object form is unwrapped and anything else
 * degrades to `""`.
 */
export function fieldString(
  row: Record<string, unknown>,
  name: string,
): string {
  const value = row[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const nested = asRecord(value);
  const inner = nested?.["value"];
  return typeof inner === "string" ? inner : "";
}
