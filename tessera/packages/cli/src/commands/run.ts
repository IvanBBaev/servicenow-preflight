// `tess run --skeleton` — the PLAN Phase 0.5 walking skeleton, frozen.
//
// Moved here from the Phase-0.5 skeleton CLI when the composition root
// landed. Two things about it are deliberate rather than pending:
//
//  * The parser is hand-rolled and does NOT go through `@tessera/config`. Its
//    flags are dev-harness switches — `--fake`, `--mutant`, `--keep`,
//    `--fake-production-property` — and giving them env and config-file layers
//    would mean a stray `TESSERA_MUTANT=1` in a shell could quietly turn a real
//    run into a seeded-bug run. They are argv-only on purpose. The flags that
//    ARE configuration (`--instance`, `--run-timeout-ms`, …) have canonical
//    equivalents on `preflight`, which is where the four-layer table lives.
//
//  * The exit-code mapping stays at Phase 0.5's two outcomes: GO -> 0,
//    everything else -> 1. The Phase-1 set separates NO_GO from INCONCLUSIVE,
//    but a CI job pinned to this command was written against the old mapping
//    and must not start seeing a 5.
//
//    The consequence used to live only in this comment: at this boundary an
//    INCONCLUSIVE verdict is indistinguishable from a NO_GO one, so nothing
//    downstream could tell "the target failed" from "we could not tell"
//    (QA-9). A true comment is still a comment — it has no consumer that can
//    notice when it stops being true. The mapping is now `runExitDisposition`,
//    which returns the code AND the fact that the code collapsed a
//    distinction; the report and the `--json` document both state it, and the
//    number returned below comes from the same call. Widening the mapping
//    itself remains forbidden: the fix for a consumer that needs the
//    distinction is `verdict.exitCodeCollapsed`, not a 5 from here.
//
// `--live` (delegated decision 2026-09-23, TODO "run --live") is the second
// mode and shares only the parser with the skeleton: it hands off to
// `../liveRun.ts`, takes profiles rather than a raw host, and exits on the full
// Phase-1 set. It refuses every Tier-2 dev switch and `--lifecycle persistent`
// (the ATF store is ephemeral-only), so neither mode can borrow the other's
// semantics by accident.
//
// §11.4/§11.5 note on `--acknowledge-prod`: the flag is plumbed straight into
// `GuardConfig.acknowledgeProd` and the guard decides. It covers EXACTLY ONE
// refusal — an allowlisted RUNNER a heuristic downgraded to `prod-suspect`. A
// declared `prod`, an `unknown` instance and any non-runner role are hard
// floors that no flag reaches. The CLI never second-guesses that — it renders
// the refusal.

import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  MAX_TIMER_MS,
  hasUrlUserinfo,
  secretValueShape,
} from "@tessera/config";
import type { AcknowledgeProd } from "@tessera/guard";
import { FAKE_HOST, type S5Variant } from "@tessera/phase05";
import type { Lifecycle } from "@tessera/types";

import type { CliContext } from "../context.js";
import { EXIT_CODES, runExitDisposition } from "../exitCodes.js";
import { runLive, type LiveRunOptions } from "../liveRun.js";
import { formatRunReport, jsonRunReport } from "../render.js";
import { runSkeleton } from "../skeletonRun.js";
import { stage, type Harness } from "../stage.js";

export interface RunOptions {
  readonly instanceName: string;
  readonly instanceHost: string;
  readonly nonProdAllowlist: readonly string[];
  readonly prodInstances: readonly string[];
  readonly acknowledgeProd?: AcknowledgeProd;
  readonly runId: string;
  readonly lifecycle: Lifecycle;
  readonly ledgerRoot?: string;
  readonly docsDir?: string;
  readonly runTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly json: boolean;
  /** Tier-2: run against `@tessera/fake-instance` (QA-18). Dev only. */
  readonly fake: boolean;
  readonly variant: S5Variant;
  readonly fakeProductionProperty: boolean;
  readonly keepLedger: boolean;
}

export type RunParse =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "run"; readonly options: RunOptions }
  | { readonly kind: "live"; readonly options: LiveRunOptions };

function mintRunId(now: Date): string {
  // Lowercased: the §4b ledger accepts lowercase run ids only (delegated
  // decision 2026-09-25 — case-insensitive filesystems and the ATF
  // `nameSTARTSWITH` sweep would otherwise collide `T`/`t` spellings), and the
  // ISO stamp carries an uppercase `T`.
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .toLowerCase();
  return `run-${stamp}-${randomUUID().slice(0, 8).toLowerCase()}`;
}

// Delegated decision 2026-09-26 (review W5b, B): `--instance`, `--name`,
// `--allow` and `--prod` were taken verbatim, so `--name https://admin:pw@h`
// reached ledger.jsonl, run.json and the `--json` document. These four name
// hosts/aliases and never legitimately carry a user, so they get the config
// package's topology check (`hasUrlUserinfo`: any `@` in the authority, every
// WHATWG spelling) plus the value-shape check (PEM, Bearer JWT, user:password@).
// A refusal is a usage error (exit 2), before anything is written, and the
// message names the flag but never echoes the value.
function carriesCredentials(raw: string): boolean {
  return hasUrlUserinfo(raw) || secretValueShape(raw) !== undefined;
}

function credentialRefusal(
  flag: string,
  where = "on the command line",
): string {
  return `${flag} carries credentials (URL userinfo or a secret-shaped value) — the value is not shown; credentials belong in the credential store (ARCH-7), not ${where}`;
}

/**
 * Both callers are millisecond flags that end up in `setTimeout`, which clamps
 * any delay above `MAX_TIMER_MS` (2^31 - 1) to 1 ms — so `3e9` used to become
 * an immediate timeout. Delegated decision 2026-09-25 (fail closed): decimal
 * digits only (`Number()` also took "0x10", "1e3" and " 5 "), a safe integer,
 * and 1..MAX_TIMER_MS inclusive; anything else is a usage error (exit 2). The
 * ceiling is the one `@tessera/config` enforces on the same options.
 */
function parseInteger(raw: string, flag: string): number | string {
  const refused = `${flag} expects a positive integer in decimal digits, at most ${MAX_TIMER_MS} (got ${JSON.stringify(raw)})`;
  if (!/^\d+$/.test(raw)) return refused;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    return refused;
  }
  return value;
}

/**
 * Hand-rolled on purpose: zero runtime dependencies, and the surface is small
 * enough that a parser generator would be more code than the parser.
 *
 * `argv` is the command's own arguments — `args.ts` has already removed the
 * `run` token and intercepted `--help`.
 */
export function parseRunArgs(
  argv: readonly string[],
  context: CliContext,
): RunParse {
  let skeleton = false;
  let live = false;
  let runnerProfile: string | undefined;
  let sourceProfile: string | undefined;
  let scope: string | undefined;
  let story: string | undefined;
  let testsRoot: string | undefined;
  let allowSkipped = false;
  let jsonOut: string | undefined;
  let junitOut: string | undefined;
  let lifecycleGiven = false;
  /** Flags that belong to exactly one mode, as the operator typed them. */
  const liveOnly: string[] = [];
  const skeletonOnly: string[] = [];
  let instanceHost: string | undefined;
  let instanceName: string | undefined;
  const nonProdAllowlist: string[] = [];
  const prodInstances: string[] = [];
  let acknowledgeReason: string | undefined;
  let actor = context.actor;
  let runId: string | undefined;
  let lifecycle: Lifecycle = "ephemeral";
  let ledgerRoot: string | undefined;
  let docsDir: string | undefined;
  let runTimeoutMs: number | undefined;
  let pollIntervalMs: number | undefined;
  let json = false;
  let fake = false;
  let variant: S5Variant = "correct";
  let fakeProductionProperty = false;
  let keepLedger = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const value = (): string | undefined => argv[++index];
    switch (flag) {
      case "--skeleton":
        skeleton = true;
        break;
      case "--live":
        live = true;
        break;
      case "--runner":
      case "--source":
      case "--scope":
      case "--story":
      case "--tests-root":
      case "--json-out":
      case "--junit-out": {
        const raw = value();
        if (raw === undefined || raw.trim() === "")
          return { kind: "error", message: `${flag} expects a value` };
        liveOnly.push(flag);
        if (flag === "--runner") runnerProfile = raw;
        else if (flag === "--source") sourceProfile = raw;
        else if (flag === "--scope") scope = raw;
        else if (flag === "--story") story = raw;
        else if (flag === "--tests-root") testsRoot = raw;
        else if (flag === "--json-out") jsonOut = raw;
        else junitOut = raw;
        break;
      }
      case "--allow-skipped":
        liveOnly.push(flag);
        allowSkipped = true;
        break;
      case "--instance":
        skeletonOnly.push(flag);
        instanceHost = value();
        if (instanceHost === undefined)
          return { kind: "error", message: "--instance expects a host" };
        if (carriesCredentials(instanceHost))
          return { kind: "error", message: credentialRefusal(flag) };
        break;
      case "--name":
        skeletonOnly.push(flag);
        instanceName = value();
        if (instanceName === undefined)
          return { kind: "error", message: "--name expects an alias" };
        if (carriesCredentials(instanceName))
          return { kind: "error", message: credentialRefusal(flag) };
        break;
      case "--allow": {
        const host = value();
        if (host === undefined)
          return { kind: "error", message: "--allow expects a host" };
        if (carriesCredentials(host))
          return { kind: "error", message: credentialRefusal(flag) };
        nonProdAllowlist.push(host);
        break;
      }
      case "--prod": {
        const host = value();
        if (host === undefined)
          return { kind: "error", message: "--prod expects a host" };
        if (carriesCredentials(host))
          return { kind: "error", message: credentialRefusal(flag) };
        prodInstances.push(host);
        break;
      }
      case "--acknowledge-prod":
        acknowledgeReason = value();
        // §11.4: the reason is MANDATORY. An empty one is refused here rather
        // than by the guard, so the operator gets the usage error, not a
        // GuardViolation that reads like the instance is at fault.
        if (
          acknowledgeReason === undefined ||
          acknowledgeReason.trim() === ""
        ) {
          return {
            kind: "error",
            message:
              "--acknowledge-prod expects a mandatory, non-empty reason (§11.4)",
          };
        }
        break;
      case "--actor": {
        const who = value();
        if (who === undefined || who.trim() === "")
          return { kind: "error", message: "--actor expects a name" };
        actor = who;
        break;
      }
      case "--run-id":
        runId = value();
        if (runId === undefined || runId.trim() === "")
          return { kind: "error", message: "--run-id expects an id" };
        break;
      case "--lifecycle": {
        const raw = value();
        if (raw !== "ephemeral" && raw !== "persistent") {
          return {
            kind: "error",
            message: `--lifecycle expects "ephemeral" or "persistent" (got ${JSON.stringify(raw ?? "")})`,
          };
        }
        lifecycle = raw;
        lifecycleGiven = true;
        break;
      }
      case "--ledger-root":
        ledgerRoot = value();
        if (ledgerRoot === undefined)
          return {
            kind: "error",
            message: "--ledger-root expects a directory",
          };
        break;
      case "--docs-dir":
        docsDir = value();
        if (docsDir === undefined)
          return { kind: "error", message: "--docs-dir expects a directory" };
        break;
      case "--run-timeout-ms": {
        const parsed = parseInteger(value() ?? "", flag);
        if (typeof parsed === "string")
          return { kind: "error", message: parsed };
        runTimeoutMs = parsed;
        break;
      }
      case "--poll-interval-ms": {
        skeletonOnly.push(flag);
        const parsed = parseInteger(value() ?? "", flag);
        if (typeof parsed === "string")
          return { kind: "error", message: parsed };
        pollIntervalMs = parsed;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--fake":
        skeletonOnly.push(flag);
        fake = true;
        break;
      case "--mutant":
        skeletonOnly.push(flag);
        variant = "mutant";
        break;
      case "--fake-production-property":
        skeletonOnly.push(flag);
        fakeProductionProperty = true;
        break;
      case "--keep":
        skeletonOnly.push(flag);
        keepLedger = true;
        break;
      default:
        return { kind: "error", message: `unknown option ${flag}` };
    }
  }

  // Two modes, and the caller names which one. This used to be a TOTAL
  // refusal of everything but `--skeleton`, conditioned on the real pipeline
  // resolving seven of eight ports: no `TestStore` adapter existed. The ATF
  // store now does, `test/realPipeline.test.js` tripped as designed, and the
  // refusal is lifted for `--live` (delegated decision 2026-09-23, TODO
  // "run --live"). A bare `tess run` still refuses — the mode is not a default
  // anybody should get by omission, and `@tessera/mcp` keeps pinning
  // `--skeleton` (decision 10) until it grows a live tool of its own.
  if (skeleton && live) {
    return {
      kind: "error",
      message: "--skeleton and --live are two different runs; pass exactly one",
    };
  }
  if (!skeleton && !live) {
    return {
      kind: "error",
      message:
        "`run` requires a mode: --skeleton (the frozen Phase 0.5 walking skeleton) or --live (the real pipeline against a runner profile)",
    };
  }
  if (skeleton && liveOnly.length > 0) {
    return {
      kind: "error",
      message: `${liveOnly[0] ?? ""} belongs to --live; the skeleton's flags are frozen at Phase 0.5`,
    };
  }
  if (live) {
    if (skeletonOnly.length > 0) {
      return {
        kind: "error",
        message: `${skeletonOnly[0] ?? ""} belongs to --skeleton; --live takes --runner/--source profiles and never runs against the Tier-2 fake`,
      };
    }
    if (lifecycleGiven && lifecycle !== "ephemeral") {
      return {
        kind: "error",
        message:
          "--live projects through the ATF store, which is ephemeral-only (DEV-20); --lifecycle persistent has no store to honour it",
      };
    }
    if (scope === undefined) {
      return {
        kind: "error",
        message:
          "--live needs --scope <app scope>: impact analysis traces one scope, and there is no honest default",
      };
    }
    if (testsRoot === undefined) {
      return {
        kind: "error",
        message:
          "--live needs --tests-root <dir>: the manifest there is what runs, and an empty default would be a green over nothing (QA-9)",
      };
    }
    const runnerName = runnerProfile ?? "default";
    return {
      kind: "live",
      options: {
        runner: runnerName,
        source: sourceProfile ?? runnerName,
        scope,
        ...(story === undefined ? {} : { story }),
        testsRoot: path.resolve(context.cwd, testsRoot),
        nonProdAllowlist,
        prodInstances,
        ...(acknowledgeReason === undefined
          ? {}
          : {
              acknowledgeProd: {
                reason: acknowledgeReason,
                actor,
                surface: "cli",
              } satisfies AcknowledgeProd,
            }),
        actor,
        runId: runId ?? mintRunId(context.now()),
        ...(ledgerRoot === undefined ? {} : { ledgerRoot }),
        ...(docsDir === undefined ? {} : { docsDir }),
        ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }),
        json,
        allowSkipped,
        ...(jsonOut === undefined
          ? {}
          : { jsonOut: path.resolve(context.cwd, jsonOut) }),
        ...(junitOut === undefined
          ? {}
          : { junitOut: path.resolve(context.cwd, junitOut) }),
      },
    };
  }
  if (variant === "mutant" && !fake) {
    return {
      kind: "error",
      message:
        "--mutant only means something with --fake: on a real instance the source under test is whatever is already deployed",
    };
  }
  if (fakeProductionProperty && !fake) {
    return {
      kind: "error",
      message:
        "--fake-production-property only means something with --fake (it seeds an instance property)",
    };
  }

  const host = instanceHost ?? (fake ? FAKE_HOST : context.instance);
  if (host === undefined || host.trim() === "") {
    return {
      kind: "error",
      message:
        "no instance: pass --instance <host> or set SN_INSTANCE (or use --fake)",
    };
  }
  // Delegated decision 2026-09-26: `$SN_INSTANCE` (`context.instance`) is the
  // same value as `--instance` by another route — it becomes the instance
  // name AND host, so it reaches the guard's audit, the ledger's run record
  // and the report. It gets the same check and the same refusal (exit 2,
  // before anything is written, the variable named, the value never shown).
  // `host` is checked whole, which reaches only the SN_INSTANCE branch: an
  // `--instance` value was refused at its flag and FAKE_HOST is ours. An
  // SN_INSTANCE that `--instance` or `--fake` overrides is never read, so it
  // is not refused.
  if (carriesCredentials(host)) {
    return {
      kind: "error",
      message: credentialRefusal("SN_INSTANCE", "in the instance host"),
    };
  }

  // The fake host is allowlisted by default — otherwise every `--fake` run
  // would need the flag, and the interesting case (an EXPLICIT --prod or a
  // heuristic downgrade) would be buried in boilerplate.
  const allowlist =
    nonProdAllowlist.length > 0 ? nonProdAllowlist : fake ? [host] : [];

  return {
    kind: "run",
    options: {
      instanceName: instanceName ?? host,
      instanceHost: host,
      nonProdAllowlist: allowlist,
      prodInstances,
      ...(acknowledgeReason === undefined
        ? {}
        : {
            acknowledgeProd: {
              reason: acknowledgeReason,
              actor,
              surface: "cli",
            } satisfies AcknowledgeProd,
          }),
      runId: runId ?? mintRunId(context.now()),
      lifecycle,
      ...(ledgerRoot === undefined ? {} : { ledgerRoot }),
      ...(docsDir === undefined ? {} : { docsDir }),
      ...(runTimeoutMs === undefined ? {} : { runTimeoutMs }),
      ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
      json,
      fake,
      variant,
      fakeProductionProperty,
      keepLedger,
    },
  };
}

/**
 * Parse, stage, run, print. Throws only what `cli.ts` is prepared to classify —
 * a `GuardViolation` for a §11 refusal, anything else for a DEV-1 fault.
 */
export async function runCommand(
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  const parsed = parseRunArgs(argv, context);
  if (parsed.kind === "error") {
    context.stderr(`tess: ${parsed.message}`);
    context.stderr("");
    context.stderr("Run `tess run --help` for usage.");
    return EXIT_CODES.usage;
  }

  if (parsed.kind === "live") return await runLive(parsed.options, context);

  const options = parsed.options;
  let harness: Harness | undefined;
  try {
    harness = await stage(
      {
        instanceHost: options.instanceHost,
        ...(options.ledgerRoot === undefined
          ? {}
          : { ledgerRoot: options.ledgerRoot }),
        ...(options.docsDir === undefined ? {} : { docsDir: options.docsDir }),
        fake: options.fake,
        variant: options.variant,
        fakeProductionProperty: options.fakeProductionProperty,
        keepLedger: options.keepLedger,
      },
      context.cwd,
    );

    const result = await runSkeleton({
      runId: options.runId,
      instance: { name: options.instanceName, host: options.instanceHost },
      now: context.now,
      ledgerRoot: harness.ledgerRoot,
      nonProdAllowlist: options.nonProdAllowlist,
      prodInstances: options.prodInstances,
      ...(options.acknowledgeProd === undefined
        ? {}
        : { acknowledgeProd: options.acknowledgeProd }),
      lifecycle: options.lifecycle,
      ...(options.runTimeoutMs === undefined
        ? {}
        : { runTimeoutMs: options.runTimeoutMs }),
      ...(options.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: options.pollIntervalMs }),
    });

    const display = {
      instanceName: options.instanceName,
      instanceHost: options.instanceHost,
      lifecycle: options.lifecycle,
      ledgerRoot: harness.ledgerRoot,
      // Inverted here and nowhere else: `stage()` reports what it FOUND,
      // because that is the question it is in a position to answer, and the
      // report states what this run DID, because that is the question a caller
      // looking at their own filesystem is asking.
      ledgerRootCreated: !harness.ledgerRootPreexisted,
    };
    context.stdout(
      options.json
        ? jsonRunReport(result, display)
        : formatRunReport(result, display),
    );
    // Frozen Phase-0.5 mapping — see the header. The same call the two
    // renderers made, so the number this process exits with and the number
    // they just printed cannot be different numbers.
    return runExitDisposition(result.report.verdict.status).code;
  } finally {
    harness?.restore();
  }
}
