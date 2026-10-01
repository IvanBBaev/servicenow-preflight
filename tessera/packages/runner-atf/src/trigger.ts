// PLAN Phase 5 — starting one ATF test-suite execution (DEV-14).
//
// DEV-14 is the whole point of this module. The vendored
// `@tessera/sn-client`'s `atfApi.runAtfSuite` posts the suite sys_id under the
// query parameter `sys_id`; the CI/CD test-suite endpoint expects
// `test_suite_sys_id`. A wrong parameter name does not fail loudly — the
// endpoint answers, the run appears to start, and results are attributed to
// whatever the instance decided to run. So this adapter builds its own request
// and posts `test_suite_sys_id`, and a test asserts that name on the wire
// rather than trusting a code read (DR-2 is the standing reminder that
// scaffolding can be confidently wrong).
//
// The `sys_id` alias. `@tessera/fake-instance`'s router was derived from the
// vendored client and therefore keys on `sys_id`; it answers HTTP 400 to a
// request carrying only the canonical name. The same workaround already exists
// in `@tessera/phase05` (`SUITE_TRIGGER_PARAM_NAMES`): send the canonical name
// AND the alias, both carrying the same value. A real instance ignores an
// unknown query parameter, so the alias is inert there, while the canonical
// name is unambiguously the one on the wire. The alias is an option
// (`aliasParam: null` disables it) so a live capture can retire it without a
// code change.
//
// Nothing here mutates instance data beyond starting the run, and nothing here
// deletes: teardown of a run this adapter abandoned belongs to the orphan sweep
// (ARCH-28/DEV-17).

import {
  AtfInfrastructureError,
  asRecord,
  fieldString,
  requestOrFault,
  unwrapResult,
  type AtfHttpClient,
} from "./client.js";

/** CI/CD test-suite trigger endpoint. */
export const CICD_TESTSUITE_RUN_PATH = "/api/sn_cicd/testsuite/run";

/** DEV-14 — the parameter the CI/CD API actually reads for a suite run. */
export const SUITE_TRIGGER_PARAM = "test_suite_sys_id";

/**
 * Compatibility alias for the vendored/fake shape (see the header). Inert on a
 * real instance, load-bearing for `@tessera/fake-instance`.
 */
export const SUITE_TRIGGER_ALIAS_PARAM = "sys_id";

/** A started suite execution, parsed from the CI/CD envelope. */
export interface AtfRunHandle {
  /** `result.links.progress.id` — the only handle the progress API accepts. */
  readonly executionId: string;
  /** Numeric CI/CD status code as a string ("0".."4"). */
  readonly status: string;
  /** Human label ("Pending" | "Running" | "Successful" | "Failed" | "Canceled"). */
  readonly statusLabel: string;
  readonly statusMessage: string;
  /** 0..100; a non-numeric wire value degrades to 0 rather than NaN. */
  readonly percentComplete: number;
  readonly progressUrl: string;
}

export interface TriggerOptions {
  /**
   * Extra query parameter carrying the same suite sys_id, for transports that
   * still key on the vendored name. `null` sends the DEV-14 name only.
   * Default {@link SUITE_TRIGGER_ALIAS_PARAM}.
   */
  readonly aliasParam?: string | null;
  /**
   * Query parameter that tags the execution with the §4a run id, when the
   * transport understands one. `null` (default) sends no tag — the real CI/CD
   * API has no such parameter, and inventing one silently would be a lie about
   * what the instance recorded.
   */
  readonly runIdParam?: string | null;
  /** Value for {@link TriggerOptions.runIdParam}; ignored without it. */
  readonly runId?: string;
}

function toPercent(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Parse the CI/CD envelope both endpoints share. Returns `undefined` when the
 * body carries no progress id — the caller turns that into a DEV-1 rejection,
 * because a run we cannot poll is an adapter fault, not test evidence.
 */
export function parseRunHandle(body: unknown): AtfRunHandle | undefined {
  const result = asRecord(unwrapResult(body));
  if (result === undefined) return undefined;
  const links = asRecord(result["links"]);
  const progress = asRecord(links?.["progress"]);
  if (progress === undefined) return undefined;
  const executionId = fieldString(progress, "id");
  if (executionId === "") return undefined;
  return {
    executionId,
    status: fieldString(result, "status"),
    statusLabel: fieldString(result, "status_label"),
    statusMessage: fieldString(result, "status_message"),
    percentComplete: toPercent(fieldString(result, "percent_complete")),
    progressUrl: fieldString(progress, "url"),
  };
}

/**
 * Start one suite execution. Rejects with {@link AtfInfrastructureError} for
 * every failure mode — a malformed argument, an unparseable response, and a
 * transport/HTTP failure normalised by {@link requestOrFault} with the original
 * error on `cause`. All are DEV-1 infra faults: the caller has no evidence
 * about any test and must not resolve outcomes.
 */
export async function triggerSuite(
  client: AtfHttpClient,
  suiteSysId: string,
  options: TriggerOptions = {},
): Promise<AtfRunHandle> {
  if (suiteSysId.trim() === "") {
    throw new AtfInfrastructureError(
      "cannot trigger an ATF suite: the projection carries an empty suite sys_id",
    );
  }

  const params = new URLSearchParams();
  params.set(SUITE_TRIGGER_PARAM, suiteSysId);
  const alias =
    options.aliasParam === undefined
      ? SUITE_TRIGGER_ALIAS_PARAM
      : options.aliasParam;
  if (alias !== null && alias !== SUITE_TRIGGER_PARAM) {
    params.set(alias, suiteSysId);
  }
  if (options.runIdParam != null && options.runId) {
    params.set(options.runIdParam, options.runId);
  }

  const response = await requestOrFault<unknown>(
    client,
    { method: "POST", path: CICD_TESTSUITE_RUN_PATH, params },
    `POST ${CICD_TESTSUITE_RUN_PATH} (trigger of ATF suite ${suiteSysId})`,
  );

  const handle = parseRunHandle(response.data);
  if (handle === undefined) {
    throw new AtfInfrastructureError(
      `ATF suite ${suiteSysId} was triggered but the CI/CD response carried no ` +
        `progress id (HTTP ${response.status}); the run cannot be polled`,
    );
  }
  return handle;
}
