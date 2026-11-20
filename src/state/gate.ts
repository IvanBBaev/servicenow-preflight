import { testDrift } from "../checks/index.js";
import { createSnClient } from "../http/client.js";
import { runPreflight } from "../index.js";
import type { InstanceRegistry } from "../registry.js";
import { summarizeResults } from "../summary.js";
import type { PreflightContext, PreflightReport } from "../types.js";
import {
  DEFAULT_STALE_WARN_MS,
  identityResults,
  promotionOrderResult,
  stalenessResults,
  versionParityResults,
} from "./drift.js";
import type { StateManifest } from "./manifest.js";

/** One side of a drift compare: the instance name and its loaded manifest. */
export interface DriftSide {
  /** The registry instance name (e.g. `"staging"`). */
  name: string;
  /** Its committed state manifest (e.g. from `loadManifest`). */
  manifest: StateManifest;
}

/** Inputs of {@link runDrift}. */
export interface RunDriftOptions {
  /** The validated upstream instance. */
  source: DriftSide;
  /** The promote destination. */
  target: DriftSide;
  /**
   * The registry, for the `promotion-order` result and the manifest URL
   * check. Without one the order is an advisory `warn` and each manifest URL
   * is only compared with the other side's.
   */
  registry?: InstanceRegistry;
  /** A manifest older than this fails the compare (the CLI's `--max-age`). */
  maxAgeMs?: number;
  /** A manifest older than this warns. Default {@link DEFAULT_STALE_WARN_MS}. */
  warnAfterMs?: number;
  /** A skipped pipeline stage warns instead of failing (`--allow-stage-skip`). */
  allowStageSkip?: boolean;
  /** The clock for manifest freshness, in epoch milliseconds. Default: now. */
  now?: number;
  /** Aborts the `test-drift` check. */
  signal?: AbortSignal;
}

/**
 * The promote gate between two instances (RR-13, ARC-5): the `test-drift`
 * check over the two manifests, then manifest identity and scope (each manifest
 * belongs to its name and registry URL, the two are different instances synced
 * for one scope), promotion order from the registry's `promotesTo` edges,
 * manifest freshness, and instance / app version parity. Offline:
 * no request is made. Returns the raw report, the same one `drift` prints; pass
 * it to `evaluate` for the `failOn` decision.
 */
export async function runDrift(
  opts: RunDriftOptions,
): Promise<PreflightReport> {
  const { source, target } = opts;
  // `test-drift` compares the loaded manifests and never touches the network;
  // the client only satisfies the context shape.
  const ctx: PreflightContext = {
    http: createSnClient({ instanceUrl: "https://invalid.invalid" }),
    instance: source.name,
    manifest: source.manifest,
    driftTarget: target.manifest,
  };
  const report = await runPreflight(
    ctx,
    [testDrift],
    opts.signal ? { signal: opts.signal } : {},
  );
  const stale = stalenessResults(
    [
      { role: "source", manifest: source.manifest },
      { role: "target", manifest: target.manifest },
    ],
    {
      warnAfterMs: opts.warnAfterMs ?? DEFAULT_STALE_WARN_MS,
      ...(opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    },
  );
  const identity = identityResults(
    [
      { role: "source", ...source },
      { role: "target", ...target },
    ],
    opts.registry,
  );
  const order = promotionOrderResult(opts.registry, source.name, target.name, {
    allowStageSkip: opts.allowStageSkip ?? false,
  });
  const parity = versionParityResults(source.manifest, target.manifest);
  // Recomputed fail-closed: an unknown status counts as a failure.
  return summarizeResults([
    ...report.results,
    ...identity,
    order,
    ...stale,
    ...parity,
  ]);
}
