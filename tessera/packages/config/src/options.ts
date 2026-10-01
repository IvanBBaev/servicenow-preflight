// The Phase-1 option table (PLAN Phase 1 §Configuration; DEV-5 flag names,
// ARCH-29 topology).
//
// This is the entire configuration surface, as data. `resolveConfig` is generic
// over any table of this shape, so Phase 9 extends the CLI by appending rows
// here — the DEV-5 canonical surface still owes `--lifecycle`, `--live`,
// `--allow-skipped` and `--acknowledge-prod <reason>`, and each of those is one
// row, not a new parser branch.
//
// NO SECRET OPTION IS DECLARED HERE, and that is a finding rather than an
// omission. The two candidates do not fit:
//
//  * `ConfirmToken` (@tessera/types) is §6b's promotion token — a structured
//    object minted by the GateEvaluator, not a scalar an operator configures.
//    Its `sig` IS a bearer credential, which makes DESIGN's
//    `tess promote --token <digest>` a credential on argv; when that surface is
//    built it must arrive as a `sources: ["env"]` descriptor, not as a flag.
//  * The §11.4 override (`--acknowledge-prod <reason>`) carries no token at
//    all — a reason string is audit text, not a credential.
//
// The env-only mechanism is therefore exercised by the test suite's own table
// rather than faked into the Phase-1 surface.

import { TEST_KINDS } from "@tessera/types";

import type { ConfigSource, OptionSpec } from "./types.js";

/** The three DESIGN §2a roles the ARCH-29 `--instance` alias collapses onto. */
export const TOPOLOGY_ROLE_KEYS = ["source", "runner", "target"] as const;

/** The alias option itself. Resolving it must produce the three roles above. */
export const INSTANCE_ALIAS_KEY = "instance";

/**
 * The option that names an explicit config file. A table may omit it — discovery
 * still runs — but no table may route it through the `file` layer: a config file
 * that names another config file is a loader, and Phase 1 has one config source.
 */
export const CONFIG_OPTION_KEY = "config";

/**
 * The largest delay `setTimeout` honours (2^31 - 1 ms, about 24.8 days). Node
 * clamps anything larger — or non-integer overflow — to 1 ms with only a
 * warning, so a millisecond option above this is refused, not truncated.
 */
export const MAX_TIMER_MS = 2_147_483_647;

export const PREFLIGHT_OPTIONS = [
  {
    key: "source",
    flag: "--source",
    env: "TESSERA_SOURCE",
    type: "string",
    describe:
      "§2a source role — artifacts and stories are READ from here (ARCH-19)",
  },
  {
    key: "runner",
    flag: "--runner",
    env: "TESSERA_RUNNER",
    type: "string",
    describe:
      "§2a runner role — the only instance pipeline writes may touch (ARCH-8)",
  },
  {
    key: "target",
    flag: "--target",
    env: "TESSERA_TARGET",
    type: "string",
    describe:
      "§2a target role — probed read-only; the promotion destination (ARCH-8)",
  },
  {
    key: INSTANCE_ALIAS_KEY,
    flag: "--instance",
    env: "TESSERA_INSTANCE",
    type: "string",
    describe:
      "ARCH-29 alias — source = runner = target collapsed onto one instance",
  },
  {
    key: "scope",
    flag: "--scope",
    env: "TESSERA_SCOPE",
    type: "string",
    describe: "resolver input — application scope (ARCH-5)",
  },
  {
    key: "story",
    flag: "--story",
    env: "TESSERA_STORY",
    type: "string",
    describe: "resolver input — story number (ARCH-5)",
  },
  {
    key: "updateSet",
    flag: "--update-set",
    env: "TESSERA_UPDATE_SET",
    type: "string",
    describe: "resolver input — update set sys_id or name (ARCH-5)",
  },
  {
    key: "kinds",
    flag: "--kind",
    env: "TESSERA_KINDS",
    type: "list",
    repeatable: true,
    // Validated against the runtime union rather than a copy of it: a kind the
    // pipeline cannot execute must be refused at startup, not at the runner.
    choices: TEST_KINDS,
    describe: `test kinds to plan — repeatable or comma-separated (${TEST_KINDS.join("|")})`,
  },
  {
    key: "mode",
    flag: "--mode",
    env: "TESSERA_MODE",
    type: "string",
    choices: ["plan", "apply"],
    // ARCH-2 and §9.5: a run that was not asked to mutate must not mutate, so
    // the safe mode is the one you get by saying nothing.
    default: "plan",
    describe:
      "plan inspects and writes nothing; apply performs the writes (ARCH-2)",
  },
  {
    key: "json",
    flag: "--json",
    env: "TESSERA_JSON",
    type: "boolean",
    default: false,
    describe: "emit the machine-readable report instead of the human one",
  },
  {
    key: CONFIG_OPTION_KEY,
    flag: "--config",
    env: "TESSERA_CONFIG",
    type: "string",
    sources: ["flag", "env", "default"],
    describe:
      "explicit config file; without it tessera.config.json is discovered upwards",
  },
  {
    key: "docsDir",
    flag: "--docs-dir",
    env: "TESSERA_DOCS_DIR",
    // The vendored transport already owns SN_DOCS_DIR (DEV-15 write journal).
    // Read it as a fallback so an existing profile keeps working; never squat
    // on the SN_* namespace by making it the primary name.
    legacyEnv: "SN_DOCS_DIR",
    type: "string",
    // No default: the transport's own default (`docs/instance`) applies when
    // nothing is set, and duplicating it here would fork it on the next change.
    describe:
      "instance docs directory, passed through to the transport (DEV-15 journal)",
  },
  {
    key: "runTimeoutMs",
    flag: "--run-timeout-ms",
    env: "TESSERA_RUN_TIMEOUT_MS",
    type: "number",
    min: 1,
    max: MAX_TIMER_MS,
    integer: true,
    default: 900_000,
    describe:
      "deadline for one run before it is reported as a waiting-timeout (DEV-2)",
  },
  {
    key: "pollIntervalMs",
    flag: "--poll-interval-ms",
    env: "TESSERA_POLL_INTERVAL_MS",
    type: "number",
    min: 1,
    max: MAX_TIMER_MS,
    integer: true,
    default: 5_000,
    describe: "how often the CI/CD progress endpoint is polled during a run",
  },
] as const satisfies readonly OptionSpec[];

export function findByFlag(
  options: readonly OptionSpec[],
  flag: string,
): OptionSpec | undefined {
  return options.find((option) => option.flag === flag);
}

export function findByKey(
  options: readonly OptionSpec[],
  key: string,
): OptionSpec | undefined {
  return options.find((option) => option.key === key);
}

/** All four layers unless the descriptor narrows them. */
export function allowsSource(spec: OptionSpec, source: ConfigSource): boolean {
  return spec.sources === undefined || spec.sources.includes(source);
}
