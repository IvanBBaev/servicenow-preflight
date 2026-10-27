import {
  closeSync,
  existsSync,
  fchmodSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { appendOutputs, appendSummary } from "./ci/github-env.js";
import { writeAtomic } from "./atomic-write.js";
import { commandConfig } from "./config-command.js";
import {
  applyInit,
  envHints,
  normaliseAnswers,
  parseInitAuth,
  parseInitCi,
  planInit,
  type InitAnswers,
  type InitAuth,
  type InitCi,
} from "./init.js";
import { promptInit } from "./init-prompt.js";
import { describeIssue, validateConfig } from "./options/config-schema.js";
import { fileURLToPath } from "node:url";
import { runPreflight } from "./index.js";
import {
  loadConfig,
  parseConcurrency,
  parseFailOn,
  parseSwitch,
  type FailOn,
  parseRequestLimit,
  UsageError,
  type RequestLimits,
} from "./config.js";
import {
  createSnClient,
  SnAuthError,
  TRANSPORT_WRAP,
  type InternalClientConfig,
} from "./http/client.js";
import { createRecorder, type Recorder } from "./fixtures/record.js";
import {
  indexPath,
  readRecording,
  RecordingError,
} from "./fixtures/recording.js";
import { PLACEHOLDER_ORIGIN } from "./fixtures/redact.js";
import { replayTransport } from "./fixtures/replay.js";
import { formatJUnit, formatJUnitSuites } from "./report/junit.js";
import {
  formatGitHubAnnotations,
  formatGitHubAnnotationsAll,
} from "./report/github.js";
import { formatMarkdown, formatMarkdownAll } from "./report/markdown.js";
import { formatSarif } from "./report/sarif.js";
import {
  formatJson,
  toEnvelope,
  type ReportEnvelope,
  type ReportRun,
} from "./report/json.js";
import {
  collectTimings,
  createTracer,
  formatTimings,
  type RunTimings,
  type Tracer,
} from "./trace.js";
import {
  loadRegistry,
  resolveInstance,
  instanceNames,
  validateInstanceName,
  type InstanceRegistry,
} from "./registry.js";
import { loadManifest, writeManifest } from "./state/manifest.js";
import { syncManifest } from "./state/sync.js";
import {
  DEFAULT_STALE_WARN_MS,
  stalenessResults,
  versionParityResults,
  promotionOrderResult,
  type DriftManifestRef,
} from "./state/drift.js";
import { defaultChecks, testDrift } from "./checks/index.js";
import {
  closestNames,
  describeChecks,
  findCheck,
  RULE_TITLES,
  type CheckDescriptor,
} from "./catalogue.js";
import {
  applyPolicy,
  parseSeverityFlag,
  policySkips,
  validatePolicy,
  type SeverityPolicy,
} from "./policy.js";
import {
  applyBaseline,
  applyFailOn,
  baselineFromReport,
  baselinePath,
  readBaseline,
  writeBaseline,
  type Baseline,
} from "./baseline.js";
import type {
  Check,
  CheckResult,
  CheckStatus,
  PreflightContext,
  PreflightReport,
  ReplayInfo,
} from "./types.js";

/** Output format for the report. */
type OutputFormat =
  "pretty" | "json" | "junit" | "sarif" | "markdown" | "github";

const FORMATS: readonly OutputFormat[] = [
  "pretty",
  "json",
  "junit",
  "sarif",
  "markdown",
  "github",
];

/**
 * Subcommand: run checks, sync a manifest, compare two instances, or browse
 * the check catalogue (`list` / `explain`), or work on the config file
 * (`config schema | validate | migrate`), or scaffold a project (`init`).
 */
type Subcommand =
  "run" | "sync" | "drift" | "list" | "explain" | "config" | "init";

const SUBCOMMANDS: readonly Subcommand[] = [
  "run",
  "sync",
  "drift",
  "list",
  "explain",
  "config",
  "init",
];

interface ParsedArgs {
  command: Subcommand;
  /** Positional instance names (env selectors), after the subcommand. */
  positionals: string[];
  instanceUrl?: string;
  configPath?: string;
  registryPath?: string;
  /** Selected registry instance (also settable positionally). */
  env?: string;
  /** Run every instance in the registry. */
  all: boolean;
  /** `sync`: also pull each test's most recent result. */
  withLastRun: boolean;
  /** `sync`: permit committing an all-empty snapshot over a non-empty manifest. */
  allowEmpty: boolean;
  only?: string[];
  skip?: string[];
  format: OutputFormat;
  /** `drift`: max manifest age before the compare hard-fails (milliseconds). */
  maxAgeMs?: number;
  /** Per-check time budget (milliseconds); `SNPF_CHECK_TIMEOUT` otherwise. */
  timeoutMs?: number;
  /** Time budget for each instance's whole run (milliseconds). */
  runTimeoutMs?: number;
  /** Client in-flight request cap; `SNPF_MAX_INFLIGHT` otherwise (default 4). */
  maxInFlight?: number;
  /** Client requests-per-second limit; `SNPF_RPS` otherwise (default none). */
  rps?: number;
  /** `run`: checks run at once; `SNPF_CONCURRENCY` otherwise (default 4). */
  concurrency?: number;
  /** `run`: `--no-cache` — fetch every read, even a repeated one (F-X-2). */
  noCache: boolean;
  /** `run`: `--timings` — per-check request and timing counts (F-X-5). */
  timings: boolean;
  /** `run`: `--trace <path>` — write an NDJSON trace; `SNPF_TRACE` otherwise. */
  tracePath?: string;
  /** `run`: `--record <dir>` — write a redacted recording of the run (F-X-6). */
  recordDir?: string;
  /** `run`: `--record-raw` — keep names and emails in the recording. */
  recordRaw: boolean;
  /** `run`: `--replay <dir>` — answer every request from a recording. */
  replayDir?: string;
  /** `run`: `--fail-on fail|warn`; `SNPF_FAIL_ON` / config `failOn` otherwise. */
  failOn?: FailOn;
  /** `run`: `--output <format>=<path>` files, written besides stdout (F-X-16). */
  outputs: OutputFile[];
  /** `run`: `--no-summary` — skip the GitHub step summary (`SNPF_SUMMARY=0`). */
  noSummary: boolean;
  /** `drift`: downgrade a skipped pipeline stage from fail to warn. */
  allowStageSkip: boolean;
  /**
   * `run`: apply a baseline of accepted findings — a path, or `true` for the
   * default `.preflight/baseline[.<env>].json`.
   */
  baseline?: string | true;
  /** `run`: write a baseline from the run's non-pass results (path or default). */
  writeBaseline?: string | true;
  /** `run`: `--severity <check>=<level>` overrides (repeatable). */
  severity?: SeverityPolicy;
  /** Allow `--write-baseline` (or `init`) to overwrite an existing file. */
  force: boolean;
  /** `config schema`: write the schema to this file. */
  out?: string;
  /** `config migrate`: rewrite the config file in place. */
  write: boolean;
  /** `init`: application scope for the config / registry. */
  scope?: string;
  /** `init`: CI pipeline to scaffold. */
  ci?: InitCi;
  /** `init`: auth kind (decides only the env names printed). */
  auth?: InitAuth;
  /** `init`: write a registry instead of a single-instance config. */
  multi: boolean;
  /** `init`: never prompt, flags only. */
  yes: boolean;
  help: boolean;
  /** Print the package version and exit. */
  version: boolean;
}

/** Split a comma-separated list into trimmed, non-empty items. */
function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** One `--output <format>=<path>` file. */
interface OutputFile {
  format: OutputFormat;
  /** The path as given; resolved against the working directory on write. */
  path: string;
}

/**
 * Parse an `--output <format>=<path>` value. An unknown format, a missing
 * path or a path an earlier `--output` already names is a usage error.
 */
function outputArg(value: string, earlier: readonly OutputFile[]): OutputFile {
  const eq = value.indexOf("=");
  const name = eq < 0 ? value : value.slice(0, eq);
  const path = eq < 0 ? "" : value.slice(eq + 1);
  if (!(FORMATS as readonly string[]).includes(name)) {
    throw new UsageError(
      `Unknown --output format "${name}". Use --output <format>=<path>; valid formats: ${FORMATS.join(", ")}.`,
    );
  }
  if (path.trim() === "") {
    throw new UsageError(`--output ${name}= needs a file path.`);
  }
  if (earlier.some((o) => resolve(o.path) === resolve(path))) {
    throw new UsageError(`--output names ${path} more than once.`);
  }
  return { format: name as OutputFormat, path };
}

function parseFormat(value: string | undefined): OutputFormat {
  if (value && (FORMATS as readonly string[]).includes(value)) {
    return value as OutputFormat;
  }
  // Fail closed on an unknown/missing --format value rather than silently
  // falling back to pretty: a caller that asked for `junit` in CI and got
  // pretty (because of a typo) would ship on a report no gate could parse.
  throw new UsageError(
    `Unknown --format "${value ?? ""}". Valid formats: ${FORMATS.join(", ")}.`,
  );
}

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a duration (`--max-age`, `--timeout`, `--run-timeout`): an integer or
 * decimal followed by a single unit — `ms`, `s` (seconds), `m` (minutes), `h`
 * (hours), `d` (days) or `w` (weeks), e.g. `30d`, `24h`, `1.5h`, `500ms`.
 * Returns milliseconds. Throws {@link UsageError} on a malformed value (so it
 * maps to exit 2), naming `flag`.
 */
function parseDuration(value: string, flag = "--max-age"): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  const unitMs = unit ? DURATION_UNIT_MS[unit] : undefined;
  if (amount === undefined || unitMs === undefined) {
    throw new UsageError(
      `Invalid ${flag} "${value}". Use <number><unit> with unit ms, s, m, h, d or w (e.g. 7d, 24h).`,
    );
  }
  return Number.parseFloat(amount) * unitMs;
}

/** Parse a time budget: a {@link parseDuration} value that must not be zero. */
function parseBudget(value: string, flag: string): number {
  const ms = Math.ceil(parseDuration(value, flag));
  if (ms <= 0) {
    throw new UsageError(`Invalid ${flag} "${value}": it must be above zero.`);
  }
  return ms;
}

/** Default check concurrency the CLI applies when neither flag nor env sets one. */
const DEFAULT_CONCURRENCY = 4;

/** Default in-flight cap the CLI applies when neither flag nor env sets one. */
const DEFAULT_MAX_IN_FLIGHT = 4;

/**
 * The client's request limits: the flag, then the (namespaced) env, then the
 * CLI default in-flight cap of {@link DEFAULT_MAX_IN_FLIGHT} (F-X-1).
 */
function requestLimits(
  args: ParsedArgs,
  fromEnv: RequestLimits,
): RequestLimits {
  const rps = args.rps ?? fromEnv.rps;
  return {
    maxInFlight:
      args.maxInFlight ?? fromEnv.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
    ...(rps !== undefined ? { rps } : {}),
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: "run",
    positionals: [],
    all: false,
    withLastRun: false,
    allowEmpty: false,
    noCache: false,
    timings: false,
    recordRaw: false,
    outputs: [],
    noSummary: false,
    allowStageSkip: false,
    format: "pretty",
    force: false,
    write: false,
    multi: false,
    yes: false,
    help: false,
    version: false,
  };

  // A leading bare token naming a subcommand selects it; otherwise the default
  // `run` applies and the token (if any) is treated as a positional env name.
  let start = 0;
  const first = argv[0];
  if (first && (SUBCOMMANDS as readonly string[]).includes(first)) {
    args.command = first as Subcommand;
    start = 1;
  }

  let i = start;
  // Read the value for a space-separated value-flag. It must be followed by a
  // real value — not the end of argv (CC-24: `--instance` with nothing after),
  // and not another option (a leading `-`, or the `--` terminator). Without
  // this, `--only --format json` would silently swallow `--format` as the
  // only-list and drop `json` into positionals.
  const takeValue = (flag: string): string => {
    const next = argv[i + 1];
    if (next === undefined || next === "--" || next.startsWith("-")) {
      throw new UsageError(`Option ${flag} requires a value.`);
    }
    i += 1;
    return next;
  };
  // An optional-value flag (`--baseline [path]`): take the next token as its
  // value when it is a real value (not the end of argv, not another option),
  // else the flag stands alone and means "use the default path".
  const takeOptionalValue = (): string | true => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) return true;
    i += 1;
    return next;
  };
  // An explicit `--flag=` value must name a file; an empty one is a typo.
  const pathValue = (flag: string, value: string): string => {
    if (value.trim().length === 0) {
      throw new UsageError(`Option ${flag} needs a path after "=".`);
    }
    return value;
  };
  // A --only / --skip list must resolve to at least one check name. An empty or
  // whitespace-only value must error (CC-22), never silently widen `--only` to
  // the full suite or make `--skip` a no-op.
  const selection = (flag: string, value: string): string[] => {
    const items = splitCsv(value);
    if (items.length === 0) {
      throw new UsageError(
        `Option ${flag} needs at least one check name (got an empty list).`,
      );
    }
    return items;
  };

  for (; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-v":
      case "--version":
        args.version = true;
        break;
      case "--json":
        args.format = "json";
        break;
      case "--all":
        args.all = true;
        break;
      case "--with-last-run":
        args.withLastRun = true;
        break;
      case "--allow-empty":
        args.allowEmpty = true;
        break;
      case "--allow-stage-skip":
        args.allowStageSkip = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--out":
        args.out = takeValue(arg);
        break;
      case "--write":
        args.write = true;
        break;
      case "--scope":
        args.scope = takeValue(arg);
        break;
      case "--ci":
        args.ci = parseInitCi(takeValue(arg));
        break;
      case "--auth":
        args.auth = parseInitAuth(takeValue(arg));
        break;
      case "--multi":
        args.multi = true;
        break;
      case "-y":
      case "--yes":
        args.yes = true;
        break;
      case "--baseline":
        args.baseline = takeOptionalValue();
        break;
      case "--severity": {
        const [name, level] = parseSeverityFlag(takeValue(arg));
        args.severity = { ...args.severity, [name]: level };
        break;
      }
      case "--write-baseline":
        args.writeBaseline = takeOptionalValue();
        break;
      case "-i":
      case "--instance":
        args.instanceUrl = takeValue(arg);
        break;
      case "-e":
      case "--env":
        args.env = takeValue(arg);
        break;
      case "--config":
        args.configPath = takeValue(arg);
        break;
      case "--registry":
        args.registryPath = takeValue(arg);
        break;
      case "--only":
        args.only = selection("--only", takeValue(arg));
        break;
      case "--skip":
        args.skip = selection("--skip", takeValue(arg));
        break;
      case "--format":
        args.format = parseFormat(takeValue(arg));
        break;
      case "--max-age":
        args.maxAgeMs = parseDuration(takeValue(arg));
        break;
      case "--timeout":
        args.timeoutMs = parseBudget(takeValue(arg), arg);
        break;
      case "--run-timeout":
        args.runTimeoutMs = parseBudget(takeValue(arg), arg);
        break;
      case "--no-cache":
        args.noCache = true;
        break;
      case "--no-summary":
        args.noSummary = true;
        break;
      case "--output":
        args.outputs.push(outputArg(takeValue(arg), args.outputs));
        break;
      case "--timings":
        args.timings = true;
        break;
      case "--trace":
        args.tracePath = tracePathArg(takeValue(arg));
        break;
      case "--record":
        args.recordDir = dirArg("--record", takeValue(arg));
        break;
      case "--record-raw":
        args.recordRaw = true;
        break;
      case "--replay":
        args.replayDir = dirArg("--replay", takeValue(arg));
        break;
      case "--concurrency":
        args.concurrency = parseConcurrency(takeValue(arg), arg);
        break;
      case "--fail-on":
        args.failOn = parseFailOn(takeValue(arg), arg) ?? failOnMissing();
        break;
      case "--max-inflight":
        args.maxInFlight = parseRequestLimit(
          "maxInFlight",
          takeValue(arg),
          arg,
        );
        break;
      case "--rps":
        args.rps = parseRequestLimit("rps", takeValue(arg), arg);
        break;
      default:
        if (arg?.startsWith("--instance=")) {
          args.instanceUrl = arg.slice("--instance=".length);
        } else if (arg?.startsWith("--env=")) {
          args.env = arg.slice("--env=".length);
        } else if (arg?.startsWith("--config=")) {
          args.configPath = arg.slice("--config=".length);
        } else if (arg?.startsWith("--registry=")) {
          args.registryPath = arg.slice("--registry=".length);
        } else if (arg?.startsWith("--only=")) {
          args.only = selection("--only", arg.slice("--only=".length));
        } else if (arg?.startsWith("--skip=")) {
          args.skip = selection("--skip", arg.slice("--skip=".length));
        } else if (arg?.startsWith("--format=")) {
          args.format = parseFormat(arg.slice("--format=".length));
        } else if (arg?.startsWith("--max-age=")) {
          args.maxAgeMs = parseDuration(arg.slice("--max-age=".length));
        } else if (arg?.startsWith("--timeout=")) {
          args.timeoutMs = parseBudget(
            arg.slice("--timeout=".length),
            "--timeout",
          );
        } else if (arg?.startsWith("--run-timeout=")) {
          args.runTimeoutMs = parseBudget(
            arg.slice("--run-timeout=".length),
            "--run-timeout",
          );
        } else if (arg?.startsWith("--trace=")) {
          args.tracePath = tracePathArg(arg.slice("--trace=".length));
        } else if (arg?.startsWith("--record=")) {
          args.recordDir = dirArg("--record", arg.slice("--record=".length));
        } else if (arg?.startsWith("--replay=")) {
          args.replayDir = dirArg("--replay", arg.slice("--replay=".length));
        } else if (arg?.startsWith("--output=")) {
          args.outputs.push(
            outputArg(arg.slice("--output=".length), args.outputs),
          );
        } else if (arg?.startsWith("--fail-on=")) {
          args.failOn =
            parseFailOn(arg.slice("--fail-on=".length), "--fail-on") ??
            failOnMissing();
        } else if (arg?.startsWith("--concurrency=")) {
          args.concurrency = parseConcurrency(
            arg.slice("--concurrency=".length),
            "--concurrency",
          );
        } else if (arg?.startsWith("--max-inflight=")) {
          args.maxInFlight = parseRequestLimit(
            "maxInFlight",
            arg.slice("--max-inflight=".length),
            "--max-inflight",
          );
        } else if (arg?.startsWith("--rps=")) {
          args.rps = parseRequestLimit(
            "rps",
            arg.slice("--rps=".length),
            "--rps",
          );
        } else if (arg?.startsWith("--severity=")) {
          const [name, level] = parseSeverityFlag(
            arg.slice("--severity=".length),
          );
          args.severity = { ...args.severity, [name]: level };
        } else if (arg?.startsWith("--scope=")) {
          args.scope = arg.slice("--scope=".length);
        } else if (arg?.startsWith("--ci=")) {
          args.ci = parseInitCi(arg.slice("--ci=".length));
        } else if (arg?.startsWith("--auth=")) {
          args.auth = parseInitAuth(arg.slice("--auth=".length));
        } else if (arg?.startsWith("--baseline=")) {
          args.baseline = pathValue(
            "--baseline",
            arg.slice("--baseline=".length),
          );
        } else if (arg?.startsWith("--write-baseline=")) {
          args.writeBaseline = pathValue(
            "--write-baseline",
            arg.slice("--write-baseline=".length),
          );
        } else if (arg !== undefined && arg.startsWith("-")) {
          // CC-23: an unrecognised option is a hard usage error, not a silently
          // dropped token that could narrow or widen the run unexpectedly.
          throw new UsageError(`Unknown option "${arg}".`);
        } else if (arg !== undefined) {
          args.positionals.push(arg);
        }
        break;
    }
  }
  if (args.baseline !== undefined && args.writeBaseline !== undefined) {
    throw new UsageError(
      "--baseline and --write-baseline cannot be combined; choose one (apply an existing baseline, or record a new one).",
    );
  }
  return args;
}

/**
 * `init` (F-X-13): scaffold the config, an optional registry, a CI pipeline
 * and `.gitignore` entries. Prompts only on a TTY without `--yes`; never
 * writes credentials, only prints the env names to set.
 */
async function commandInit(args: ParsedArgs, cwd: string): Promise<void> {
  if (args.positionals.length > 0) {
    throw new UsageError(
      `init takes no positional arguments, got: ${args.positionals.join(", ")}.`,
    );
  }
  const defaults: InitAnswers = {
    ...(args.instanceUrl !== undefined
      ? { instanceUrl: args.instanceUrl }
      : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    auth: args.auth ?? "basic",
    multi: args.multi,
    ci: args.ci ?? "none",
  };
  const interactive = process.stdin.isTTY === true && !args.yes;
  const answers = normaliseAnswers(
    interactive
      ? await promptInit(defaults, {
          input: process.stdin,
          output: process.stderr,
        })
      : defaults,
  );
  const result = applyInit(cwd, planInit(answers, readVersion()), {
    force: args.force,
  });
  const lines = [
    ...result.created.map((path) => `Created ${path}`),
    ...result.overwritten.map((path) => `Overwrote ${path}`),
    ...result.appended.map((path) => `Updated ${path}`),
    "",
    "Set these in your shell, .env (git-ignored) or CI secrets:",
    ...envHints(answers).map((hint) => `  ${hint}`),
    "",
    "Next:",
    "  servicenow-preflight config validate",
    `  servicenow-preflight run${answers.multi ? " dev" : ""}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * The package version, read from package.json at runtime (relative to the built
 * module) so `--version` never drifts from what npm shipped. Falls back to
 * "unknown" if the file cannot be read/parsed — a version flag must never crash.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

const HELP = `servicenow-preflight — pre-deployment checks for ServiceNow

Usage:
  servicenow-preflight [run] [env] [options]   Run checks against an instance
  servicenow-preflight sync <env> [options]    Pull ATF metadata → state manifest
  servicenow-preflight drift <src> <dst>       Compare two instances (promote gate)
  servicenow-preflight list [--format pretty|json]
                                               List every check (name, severity,
                                               rule, description)
  servicenow-preflight explain <check> [--format pretty|json]
                                               Show one check's rule, tables,
                                               verdicts and remediation
  servicenow-preflight config schema [--out <file>]
                                               Print the config JSON Schema
  servicenow-preflight config validate [--config <path>]
                                               Report every config problem
                                               (exit 2 when any)
  servicenow-preflight config migrate [--write]
                                               Move shared options into
                                               per-check entries (diff, or
                                               rewrite with --write)
  servicenow-preflight init [--instance <url>] [--scope <s>] [--multi]
                    [--ci github|gitlab|azure|none]
                    [--auth basic|oauth-client|bearer|mtls] [--force] [--yes]
                                               Scaffold the config, registry,
                                               CI pipeline and .gitignore
                                               (prompts on a TTY unless --yes;
                                               never writes credentials)
  (list, explain, config and init need no credentials or network.)

Multi-instance (registry at .preflight/instances.json):
  <env>                  A registry instance name (dev | staging | test | prod)
  -e, --env <name>       Select the instance (same as the positional)
      --all              run: every instance in the registry
      --registry <path>  Registry file (default .preflight/instances.json);
                         a given path must exist (else exit 2)
      --with-last-run    sync: also pull each test's most recent result
      --allow-empty      sync: commit an empty snapshot over a non-empty manifest
                         (refused by default as likely ACL security-trimming;
                         cannot override a proven security-trimmed pull)

Options:
  -i, --instance <url>   Target instance URL (single-instance, no registry)
      --config <path>    Path to a preflight config file
      --only <csv>       Run only these checks (comma-separated names)
      --skip <csv>       Skip these checks (comma-separated names)
      --format <fmt>     Output: pretty (default), json, junit, sarif,
                         markdown (a PR-comment table), github (Actions
                         ::error/::warning annotations; GitHub jobs only)
      --json             Shorthand for --format json
      --max-age <dur>    drift: fail if a compared manifest is older than <dur>.
                         Duration is <number><unit>, unit ms|s|m|h|d|w (e.g.
                         7d, 24h). Without it, a manifest older than 30d only
                         warns.
      --timeout <dur>    run: fail a check that runs longer than <dur> and
                         abort its requests (default: none; env
                         SNPF_CHECK_TIMEOUT). The other checks still run.
      --run-timeout <dur>
                         run: budget for each instance's whole run; checks
                         not finished in time fail as aborted
      --fail-on <level>  run: exit 1 on fail rows only (fail, the default) or
                         also on warn rows no baseline accepted (warn); env
                         SNPF_FAIL_ON, config failOn. Rows are unchanged
      --output <format>=<path>
                         run: also write the report as <format> to <path>
                         (repeatable; written atomically, folders created)
      --no-summary       run: skip the GitHub step summary (env SNPF_SUMMARY=0)
      --concurrency <n>  run: most checks running at once, 1-32 (default 4;
                         env SNPF_CONCURRENCY). ATF checks always run alone,
                         after the others; the report keeps registry order
      --max-inflight <n> run/sync: most requests in flight at once, 1-64
                         (default 4; env SNPF_MAX_INFLIGHT)
      --rps <n>          run/sync: most requests started per second, 0.5-100
                         (default unlimited; env SNPF_RPS). A 429 also pauses
                         the other requests for its Retry-After
      --no-cache         run: fetch every read instead of sharing identical
                         reads between checks (env SNPF_CACHE=0)
      --timings          run: after the report, print per-check time, requests,
                         retries and cache hits to stderr (json: a "timings"
                         object per run instead)
      --trace <path>     run: write a local NDJSON trace of the run (env
                         SNPF_TRACE); file mode 0600, no query values, row
                         data, headers or credentials
      --record <dir>     run: also write each response, redacted, to <dir>
                         (names and emails pseudonymised, secrets and the host
                         replaced) for a later --replay
      --record-raw       run: with --record, keep names and emails (secrets
                         are still redacted)
      --replay <dir>     run: answer every request from a recording; no
                         network and no credentials. A request that was not
                         recorded fails its check
      --allow-stage-skip drift: warn instead of fail when <dst> is further down
                         the registry's promotesTo pipeline than the next stage
      --baseline [path]  run: demote findings recorded in a baseline file to
                         warn (default .preflight/baseline.json; a registry
                         instance tries .preflight/baseline.<env>.json first).
                         A missing or malformed file is exit 2. A finding whose
                         message changed still warns, flagged CHANGED.
      --write-baseline [path]
                         run: record every non-pass result as a baseline
                         (default .preflight/baseline.json, or
                         baseline.<env>.json per registry instance); exits
                         with the run's normal code
      --force            --write-baseline / init: overwrite existing files
      --severity <check>=<fail|warn|off>
                         run: report that check's non-pass result as fail or
                         warn, or skip it (off). Repeatable; wins over the
                         config file's "severity" entry for the same check
  -h, --help             Show this help
  -v, --version          Print the version and exit

Exit codes:
  0  no check failed
  1  a check failed (including a selection that matched zero checks, and a
     drift/promote or manifest-age gate that blocked)
  2  a usage or configuration error (unknown option, missing flag value,
     bad --format / --max-age / --timeout, a required registry absent, a --registry path
     that does not exist, an invalid config, registry or state manifest
     file, a drift manifest that was never synced)
  130 interrupted (Ctrl-C): the partial report is printed first; checks cut
     short or never started fail as aborted

Authentication (via environment / .env — never the config file, never logged):
  Per instance, prefix any SNPF_* var with the instance name, e.g.
  SNPF_DEV_USER / SNPF_PROD_TOKEN; the unprefixed SNPF_* is the fallback.

  SNPF_INSTANCE                  Instance URL (or use --instance)
  SNPF_AUTH                      Force a method; otherwise it is auto-detected:
                                 basic | token | apikey | oauth-password
                                 | oauth-client | oauth-refresh | oauth-jwt
  Basic:        SNPF_USER, SNPF_PASS
  Static token: SNPF_TOKEN
  API key:      SNPF_API_KEY                         (x-sn-apikey; Tokyo+)
  OAuth grant:  SNPF_OAUTH_CLIENT_ID, SNPF_OAUTH_CLIENT_SECRET
                + SNPF_OAUTH_REFRESH_TOKEN           → refresh_token grant
                + SNPF_USER/SNPF_PASS                → password grant
                + SNPF_OAUTH_JWT_KEY (or _ASSERTION) → jwt-bearer grant
                (else client_credentials)
                SNPF_OAUTH_TOKEN_URL                 override token endpoint
  JWT extras:   SNPF_OAUTH_JWT_KID, _SUB, _AUD, _ISS
  Mutual TLS:   SNPF_MTLS_CERT, SNPF_MTLS_KEY, SNPF_MTLS_CA, SNPF_MTLS_PASSPHRASE
  A value beginning with '@' (PEM / key / assertion vars) is read from that file.
`;

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: "✓",
  warn: "!",
  fail: "✗",
};

/**
 * The checks from `pool` that produced at least one of `reports`' results —
 * what actually ran after `--only` / `--skip` / policy selection.
 */
function ranChecks(
  pool: readonly Check[],
  reports: readonly PreflightReport[],
): Check[] {
  const names = new Set(reports.flatMap((r) => r.results.map((x) => x.name)));
  return pool.filter((c) => names.has(c.name));
}

/** The JSON envelope for the given runs, stamped with this tool's version. */
function renderJson(runs: readonly ReportRun[]): string {
  return formatJson(toEnvelope(runs, { version: readVersion() }));
}

/**
 * Render one report in the requested format to a string. `instance` names the
 * target in formats that show it (markdown, github, json); the others ignore
 * it. `checks` are the checks that ran; markdown uses them for remediation
 * hints. `url` is the instance URL the json envelope records (origin only).
 */
function render(
  report: PreflightReport,
  format: OutputFormat,
  instance?: string,
  checks?: readonly Check[],
  url?: string,
  timings?: RunTimings,
): string {
  switch (format) {
    case "markdown":
      return formatMarkdown(report, instance, checks ? { checks } : undefined);
    case "github":
      return formatGitHubAnnotations(report, instance);
    case "json":
      return renderJson([
        {
          ...(instance !== undefined ? { instance } : {}),
          ...(url !== undefined ? { url } : {}),
          report,
          ...(timings !== undefined ? { timings } : {}),
        },
      ]);
    case "junit":
      return formatJUnit(report);
    case "sarif":
      return formatSarif(report);
    default: {
      const lines = report.results.map(
        (r) => `${STATUS_ICON[r.status]} ${r.name}: ${r.message}`,
      );
      const { pass, warn, fail } = report.summary;
      lines.push("");
      lines.push(`${pass} passed, ${warn} warnings, ${fail} failed`);
      return `${lines.join("\n")}\n`;
    }
  }
}

/** One instance's report, tagged with the instance name (for `--all`). */
interface NamedReport {
  name: string;
  report: PreflightReport;
  /** The instance URL the run targeted, when one was resolved. */
  url?: string;
  /** `--timings` counts for this instance's run. */
  timings?: RunTimings;
}

/** Append extra results to a report, recomputing its summary and `ok`. */
function mergeResults(
  report: PreflightReport,
  extra: CheckResult[],
): PreflightReport {
  const results = [...report.results, ...extra];
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const r of results) {
    if (r.status === "warn") summary.warn += 1;
    else if (r.status === "fail") summary.fail += 1;
    else summary.pass += 1;
  }
  return { ok: summary.fail === 0, results, summary };
}

/** A parsed SARIF log — enough shape to merge runs across instances. */
interface SarifLog {
  version: string;
  $schema?: string;
  runs: Record<string, unknown>[];
}

/**
 * Merge per-instance SARIF logs into ONE valid SARIF document: one `run` per
 * instance (each tagged via `automationDetails.id` so a consumer can tell them
 * apart), under a single top-level log. Replaces the previous behaviour of
 * concatenating whole documents, which produced unparseable output.
 */
function renderSarifAll(reports: NamedReport[]): string {
  const runs: Record<string, unknown>[] = [];
  let version = "2.1.0";
  let schema: string | undefined;
  for (const r of reports) {
    const log = JSON.parse(formatSarif(r.report)) as SarifLog;
    version = log.version;
    schema = log.$schema;
    for (const run of log.runs) {
      runs.push({ ...run, automationDetails: { id: r.name } });
    }
  }
  const merged: SarifLog = {
    version,
    ...(schema ? { $schema: schema } : {}),
    runs,
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/** Render an aggregate `--all` result across instances. */
function renderAll(
  reports: NamedReport[],
  format: OutputFormat,
  checks?: readonly Check[],
): string {
  const ok = reports.every((r) => r.report.ok);
  if (format === "json") {
    return renderJson(
      reports.map((r) => ({
        instance: r.name,
        ...(r.url !== undefined ? { url: r.url } : {}),
        report: r.report,
        ...(r.timings !== undefined ? { timings: r.timings } : {}),
      })),
    );
  }
  if (format === "pretty") {
    const blocks = reports.map(
      (r) => `== ${r.name} ==\n${render(r.report, "pretty").trimEnd()}`,
    );
    const failed = reports.filter((r) => !r.report.ok).map((r) => r.name);
    const rollup = ok
      ? `All ${reports.length} instance(s) passed.`
      : `Failed on: ${failed.join(", ")}`;
    return `${blocks.join("\n\n")}\n\n${rollup}\n`;
  }
  if (format === "markdown") {
    // One Markdown document: a roll-up line, then a block per instance.
    return formatMarkdownAll(reports, checks ? { checks } : undefined);
  }
  if (format === "github") {
    // Every instance's annotations, then a summary line per instance.
    return formatGitHubAnnotationsAll(reports);
  }
  if (format === "junit") {
    // One JUnit document: a <testsuite> per instance inside one <testsuites>.
    return formatJUnitSuites(reports);
  }
  // sarif — one SARIF log, one run per instance (see renderSarifAll).
  return renderSarifAll(reports);
}

/** A single instance to run checks against. */
interface RunTarget {
  /** Registry name (`dev`…), or `undefined` for the single-instance path. */
  name?: string;
  instanceUrl?: string;
  envPrefix?: string;
  scope?: string;
}

/**
 * The one instance name a command was given, via `--env` or a lone positional.
 *
 * Both silent-drop shapes are refused here rather than at each call site: a
 * second positional (`sync dev prod` read only `dev`), and a positional that
 * contradicts an explicit `--env` (`--env dev prod` read only `dev`). Either way
 * the command answered a narrower question than the operator typed and exited 0
 * — which reads as every named instance having passed. `hint` completes the
 * sentence "…run one at a time" with whatever the command offers instead.
 */
function singleInstanceName(
  command: string,
  args: ParsedArgs,
  hint: string,
): string | undefined {
  if (args.positionals.length > 1) {
    throw new UsageError(
      `${command} takes at most one instance name, but got ${
        args.positionals.length
      }: ${args.positionals.join(", ")}. ${hint}`,
    );
  }
  const positional = args.positionals[0];
  if (
    args.env !== undefined &&
    positional !== undefined &&
    positional !== args.env
  ) {
    throw new UsageError(
      `${command} got two different instance names: --env "${args.env}" and "${positional}". Pass one or the other.`,
    );
  }
  return args.env ?? positional;
}

/** Resolve which instance(s) a `run` targets from args + registry. */
function resolveRunTargets(
  args: ParsedArgs,
  registry: InstanceRegistry | undefined,
): RunTarget[] {
  if (args.all) {
    // `--all` outranks a named instance, so naming one alongside it meant the
    // name was silently dropped — the opposite of what the operator typed.
    const named = args.positionals[0] ?? args.env;
    if (named) {
      throw new UsageError(
        `--all cannot be combined with an instance name ("${named}"); --all already checks every instance in the registry.`,
      );
    }
    if (!registry) {
      throw new UsageError(
        "--all needs a registry; create .preflight/instances.json or drop --all.",
      );
    }
    if (args.instanceUrl) {
      // One URL cannot stand in for every registry instance: the run would
      // check a single target while labelling the results dev/staging/prod.
      throw new UsageError(
        "--instance cannot be combined with --all; --all takes each instance's URL from the registry.",
      );
    }
    const names = instanceNames(registry);
    if (names.length === 0) {
      // An empty registry means `--all` verified nothing; a pre-deployment gate
      // must never report a vacuous "All 0 instance(s) passed."
      throw new UsageError(
        '--all matched no instances: the registry\'s "instances" map is empty. Add an instance or drop --all.',
      );
    }
    return names.map((name) => {
      const inst = resolveInstance(registry, name);
      return {
        name,
        instanceUrl: inst.url,
        envPrefix: inst.envPrefix,
        scope: inst.scope,
      };
    });
  }

  const env = singleInstanceName(
    "run",
    args,
    "Use --all to check every instance, or run one at a time.",
  );
  if (env) {
    if (!registry) {
      throw new UsageError(
        `No registry found; cannot resolve instance "${env}". Create .preflight/instances.json or use --instance <url>.`,
      );
    }
    if (args.instanceUrl) {
      throw new UsageError(
        `--instance conflicts with the registry instance "${env}"; pass one or the other.`,
      );
    }
    const inst = resolveInstance(registry, env);
    return [
      {
        name: env,
        instanceUrl: inst.url,
        envPrefix: inst.envPrefix,
        scope: inst.scope,
      },
    ];
  }

  // Single-instance path (backward compatible): URL from --instance / config.
  return [{ instanceUrl: args.instanceUrl }];
}

/** One instance's report plus the URL it ran against. */
interface InstanceRun {
  report: PreflightReport;
  url?: string;
  /** `--timings` counts for the run. */
  timings?: RunTimings;
  /** Set when the run was replayed from a recording. */
  replay?: ReplayInfo;
  /** The `--fail-on` threshold the run's `ok` was decided with. */
  failOn: FailOn;
}

/** `--fail-on` given a blank value. */
function failOnMissing(): never {
  throw new UsageError('--fail-on needs "fail" or "warn".');
}

/** A `--record` / `--replay` value: a non-empty directory. */
function dirArg(flag: string, value: string): string {
  if (value.trim() === "") {
    throw new UsageError(`${flag} needs a directory.`);
  }
  return value;
}

/** Read a `--replay` recording's index; a bad one is a usage error. */
function openRecording(dir: string, shown: string): ReplayInfo {
  try {
    return { dir: shown, recordedAt: readRecording(dir).recordedAt };
  } catch (err) {
    if (err instanceof RecordingError) throw new UsageError(err.message);
    throw err;
  }
}

/**
 * Start a `--record` recorder. On the first recording into a directory inside
 * a git work tree that git does not ignore, warn and print a `.gitignore`
 * line: a recording is meant to be reviewed before it is committed.
 */
function startRecording(
  dir: string,
  instanceUrl: string | undefined,
  raw: boolean,
): Recorder {
  let origin: string;
  try {
    origin = new URL(instanceUrl ?? "").origin;
  } catch {
    throw new UsageError(
      "--record needs the instance URL (--instance, SNPF_INSTANCE or instanceUrl in the config file).",
    );
  }
  const fresh = !existsSync(indexPath(dir));
  let recorder: Recorder;
  try {
    recorder = createRecorder({ dir, origin, raw });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Cannot write the recording ${dir}: ${detail}`);
  }
  if (raw) {
    process.stderr.write(
      "Warning: --record-raw keeps user and group names and emails in the recording; secrets are still redacted.\n",
    );
  }
  if (fresh) warnIfCommittable(dir);
  return recorder;
}

/** The `.gitignore` warning of {@link startRecording}; silent without git. */
function warnIfCommittable(dir: string): void {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  let top: string;
  try {
    top = git(["rev-parse", "--show-toplevel"]);
  } catch {
    return;
  }
  const rel = relative(realpathSync(top), realpathSync(dir));
  if (rel === "" || rel.startsWith("..")) return;
  const line = `/${rel.split("\\").join("/")}/`;
  try {
    git(["-C", top, "check-ignore", "-q", `${rel}/`]);
    return;
  } catch {
    // Not ignored: warn below.
  }
  process.stderr.write(
    `Warning: the recording ${dir} is inside a git work tree and not ignored. Review it before committing it, or ignore it with this .gitignore line:\n  ${line}\n`,
  );
}

/**
 * Note a replayed run in the rendered report: a first line in the text
 * formats, a notice in github, an XML comment in junit, and a `replay` object
 * on each run in json and sarif.
 */
function withReplayNote(
  out: string,
  format: OutputFormat,
  replay: ReplayInfo | undefined,
): string {
  if (!replay) return out;
  const note = `Replayed from ${replay.dir} recorded ${replay.recordedAt}`;
  switch (format) {
    case "json": {
      const envelope = JSON.parse(out) as ReportEnvelope;
      for (const run of envelope.runs) run.replay = replay;
      return formatJson(envelope);
    }
    case "sarif": {
      const log = JSON.parse(out) as SarifLog;
      for (const run of log.runs) {
        const properties = (run.properties ?? {}) as Record<string, unknown>;
        run.properties = { ...properties, replay };
      }
      return `${JSON.stringify(log, null, 2)}\n`;
    }
    case "junit": {
      const comment = `<!-- ${note.replace(/-{2,}/g, "-")} -->\n`;
      const declaration = /^<\?xml[^>]*\?>\n/.exec(out);
      return declaration
        ? `${declaration[0]}${comment}${out.slice(declaration[0].length)}`
        : `${comment}${out}`;
    }
    case "github":
      return `::notice::${note.replace(/%/g, "%25").replace(/\r?\n/g, " ")}\n${out}`;
    case "markdown":
      return `> ${note}\n\n${out}`;
    default:
      return `${note}\n\n${out}`;
  }
}

/** A `--trace` value: a non-empty path. */
function tracePathArg(value: string): string {
  if (value.trim() === "") {
    throw new UsageError("--trace needs a file path.");
  }
  return value;
}

/** The `--trace` file a `run` writes to, shared by every instance it runs. */
interface TraceSink {
  path?: string;
  fd?: number;
  tracer?: Tracer;
}

/**
 * Open the trace file once: created (or truncated) with mode 0600, and
 * re-chmodded in case it already existed with a wider mode.
 */
function openTrace(sink: TraceSink, path: string): Tracer {
  if (sink.tracer) return sink.tracer;
  let fd: number;
  try {
    fd = openSync(path, "w", 0o600);
    fchmodSync(fd, 0o600);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Cannot write the trace file ${path}: ${detail}`);
  }
  sink.path = path;
  sink.fd = fd;
  sink.tracer = createTracer((line) => {
    writeSync(fd, line);
  });
  return sink.tracer;
}

function closeTrace(sink: TraceSink): void {
  sink.tracer?.close();
  if (sink.fd !== undefined) closeSync(sink.fd);
  sink.tracer = undefined;
  sink.fd = undefined;
}

/** The host name of an instance URL, for the trace (no scheme or path). */
function instanceHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Run the check suite against one resolved instance. */
/** Config warnings already printed (an `--all` run loads the file per instance). */
const warnedConfigIssues = new Set<string>();

/**
 * Print config-schema problems (unknown option keys, wrong types) as warnings.
 * In 1.x they never fail the run: checks keep their own warn rows for bad
 * values. `config validate` reports the same problems as an error.
 */
function warnConfigIssues(config: unknown): void {
  for (const issue of validateConfig(config, [...defaultChecks, testDrift])) {
    const line = describeIssue(issue);
    if (warnedConfigIssues.has(line)) continue;
    warnedConfigIssues.add(line);
    process.stderr.write(`servicenow-preflight: config warning: ${line}\n`);
  }
}

async function runOneInstance(
  target: RunTarget,
  args: ParsedArgs,
  cwd: string,
  trace: TraceSink = {},
): Promise<InstanceRun> {
  // F-X-6: a replay needs no credentials, so none are resolved.
  const replay =
    args.replayDir !== undefined
      ? openRecording(resolve(cwd, args.replayDir), args.replayDir)
      : undefined;
  const loaded = await loadConfig(cwd, {
    configPath: args.configPath,
    envPrefix: target.envPrefix,
    ...(replay ? { credentials: false } : {}),
  });

  const instanceUrl =
    args.instanceUrl ??
    target.instanceUrl ??
    loaded.config.instanceUrl ??
    (replay ? PLACEHOLDER_ORIGIN : undefined);
  const scope = target.scope ?? loaded.config.scope;
  const manifest = target.name
    ? await loadManifest(target.name, cwd)
    : undefined;

  // Severity policy: CLI entries win over config entries for the same check.
  // Validated before any client is built, so a typo is exit 2 up front.
  const policy: SeverityPolicy = {
    ...loaded.config.severity,
    ...args.severity,
  };
  validatePolicy(
    policy,
    defaultChecks.map((c) => c.name),
  );
  // Per-check options naming an unknown check are a typo, not a no-op.
  const checkOptions = loaded.config.checks;
  if (checkOptions) {
    const known = [...defaultChecks, testDrift].map((c) => c.name);
    const unknown = Object.keys(checkOptions).filter((n) => !known.includes(n));
    if (unknown.length > 0) {
      throw new UsageError(
        `Config checks names unknown check(s): ${unknown.join(", ")}. Run "servicenow-preflight list".`,
      );
    }
  }
  warnConfigIssues(loaded.config);
  const offByPolicy = policySkips(policy);
  const baseSkip = args.skip ?? loaded.config.select?.skip;
  const select = {
    only: args.only ?? loaded.config.select?.only,
    skip:
      offByPolicy.length > 0 ? [...(baseSkip ?? []), ...offByPolicy] : baseSkip,
  };

  // Resolve the baseline before any network call, so a missing or malformed
  // file (or a refused overwrite) is a usage error up front, not after a run.
  let writePath: string | undefined;
  let baseline: Baseline | undefined;
  if (args.writeBaseline !== undefined) {
    writePath =
      typeof args.writeBaseline === "string"
        ? resolve(cwd, args.writeBaseline)
        : baselinePath(cwd, target.name);
    if (existsSync(writePath) && !args.force) {
      throw new UsageError(
        `Baseline file ${writePath} already exists; pass --force to overwrite it.`,
      );
    }
  } else {
    const file = resolveBaselineFile(
      args,
      loaded.config.baseline,
      cwd,
      target.name,
    );
    if (file) baseline = readBaseline(file);
  }

  const recorder =
    args.recordDir !== undefined
      ? startRecording(
          resolve(cwd, args.recordDir),
          instanceUrl,
          args.recordRaw,
        )
      : undefined;
  const replayDir = args.replayDir;
  const clientConfig: InternalClientConfig = {
    instanceUrl: instanceUrl ?? "https://invalid.invalid",
    ...(loaded.auth ? { auth: loaded.auth } : {}),
    ...(loaded.tls ? { tls: loaded.tls } : {}),
    // Config-file / SNPF_PROXY settings ride along as explicit client
    // configuration, outranking HTTPS_PROXY/https_proxy (SR-5).
    ...(loaded.config.proxy ? { proxy: loaded.config.proxy } : {}),
    ...(loaded.config.noProxy ? { noProxy: loaded.config.noProxy } : {}),
    env: loaded.env,
    ...requestLimits(args, loaded.limits),
    // F-X-2: share identical reads between the run's checks.
    cache: !args.noCache && loaded.cache !== false,
  };
  if (recorder) {
    clientConfig[TRANSPORT_WRAP] = (inner) => recorder.wrap(inner);
  } else if (replayDir !== undefined) {
    const transport = replayTransport(resolve(cwd, replayDir));
    clientConfig[TRANSPORT_WRAP] = () => transport;
  }
  const http = createSnClient(clientConfig);

  const ctx: PreflightContext = {
    instanceUrl,
    auth: loaded.auth,
    tls: loaded.tls,
    http,
    scope,
    updateSetId: loaded.config.updateSetId,
    instance: target.name,
    manifest,
    select,
    ...(replay ? { replay } : {}),
    options: loaded.config.options,
    ...(checkOptions ? { checkOptions } : {}),
  };

  // Post-processing order: runPreflight → policy → baseline. Policy expresses
  // intent; the baseline accepts the resulting state.
  const envTimeout = loaded.env.SNPF_CHECK_TIMEOUT;
  const timeoutMs =
    args.timeoutMs ??
    (envTimeout !== undefined && envTimeout.trim() !== ""
      ? parseBudget(envTimeout, "SNPF_CHECK_TIMEOUT")
      : undefined);
  // F-X-5: the trace file is opened once per command, on the first instance.
  const envTrace = loaded.env.SNPF_TRACE?.trim();
  const tracePath = args.tracePath ?? (envTrace ? envTrace : undefined);
  if (tracePath !== undefined) {
    openTrace(trace, resolve(cwd, tracePath)).setRun({
      version: readVersion(),
      instanceHost: instanceHost(instanceUrl),
    });
  }
  const collector = args.timings ? collectTimings() : undefined;
  let timings: RunTimings | undefined;
  let raw: PreflightReport;
  try {
    raw = await runPreflight(ctx, defaultChecks, {
      signal: interrupt.signal,
      concurrency:
        args.concurrency ?? loaded.concurrency ?? DEFAULT_CONCURRENCY,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(args.runTimeoutMs !== undefined
        ? { runTimeoutMs: args.runTimeoutMs }
        : {}),
    });
  } finally {
    timings = collector?.stop(defaultChecks.map((c) => c.name));
  }
  recorder?.finish({
    version: readVersion(),
    checks: raw.results.map((r) => r.name),
  });
  const report = applyPolicy(raw, policy);
  const failOn: FailOn =
    args.failOn ?? loaded.failOn ?? loaded.config.failOn ?? "fail";
  const extra = {
    ...(instanceUrl ? { url: instanceUrl } : {}),
    ...(timings ? { timings } : {}),
    ...(replay ? { replay } : {}),
    failOn,
  };

  if (writePath) {
    const b = baselineFromReport(report, target.name, new Date());
    writeBaseline(writePath, b, { force: args.force });
    process.stderr.write(
      `Wrote baseline with ${b.entries.length} entr${
        b.entries.length === 1 ? "y" : "ies"
      } → ${writePath}\n`,
    );
    return { report, ...extra };
  }
  // F-X-17: the threshold comes last, so baselined rows no longer count.
  const accepted = baseline
    ? applyBaseline(report, baseline, new Date())
    : report;
  return { report: applyFailOn(accepted, failOn), ...extra };
}

/**
 * The baseline file a run applies, or `undefined` when none is enabled. The
 * `--baseline` flag wins over the config key; `true` means the default path,
 * where a registry instance's own `baseline.<env>.json` is preferred over the
 * shared `baseline.json`.
 */
function resolveBaselineFile(
  args: ParsedArgs,
  setting: string | boolean | undefined,
  cwd: string,
  instance: string | undefined,
): string | undefined {
  const chosen = args.baseline ?? setting;
  if (chosen === undefined || chosen === false) return undefined;
  if (typeof chosen === "string") return resolve(cwd, chosen);
  if (instance) {
    const own = baselinePath(cwd, instance);
    if (existsSync(own)) return own;
  }
  return baselinePath(cwd);
}

/** `run` — one instance, or all of them with `--all`. */
async function commandRun(args: ParsedArgs, cwd: string): Promise<void> {
  if (args.all && typeof args.writeBaseline === "string") {
    // One explicit path cannot hold every instance's findings: each instance
    // would overwrite the previous one's file.
    throw new UsageError(
      "--write-baseline <path> cannot be combined with --all; omit the path to write .preflight/baseline.<env>.json per instance.",
    );
  }
  if (args.recordDir !== undefined && args.replayDir !== undefined) {
    throw new UsageError("--record and --replay cannot be combined.");
  }
  if (args.recordRaw && args.recordDir === undefined) {
    throw new UsageError("--record-raw needs --record <dir>.");
  }
  if (args.all && (args.recordDir ?? args.replayDir) !== undefined) {
    throw new UsageError(
      "--record and --replay hold one instance; run them without --all.",
    );
  }
  const registry = await loadRegistry(cwd, args.registryPath);
  const targets = resolveRunTargets(args, registry);

  const trace: TraceSink = {};
  try {
    await runTargets(targets, args, cwd, trace);
  } finally {
    closeTrace(trace);
  }
}

/** Record a `--fail-on warn` threshold in the json envelope (F-X-17). */
function withFailOn(out: string, format: OutputFormat, failOn: FailOn): string {
  if (format !== "json" || failOn !== "warn") return out;
  const { runs, ...head } = JSON.parse(out) as ReportEnvelope;
  return formatJson({ ...head, failOn, runs });
}

/**
 * Say on stderr why a run with no `fail` row still exits 1: `--fail-on warn`
 * counted its warnings (F-X-17).
 */
function writeFailOnNote(
  runs: readonly { name?: string; report: PreflightReport }[],
): void {
  for (const { name, report } of runs) {
    if (report.ok || report.summary.fail > 0) continue;
    const where = name ? ` on ${name}` : "";
    process.stderr.write(
      `Failing${where}: ${report.summary.warn} warning(s) with --fail-on warn.\n`,
    );
  }
}

/** `--timings` outside json: one stderr table per instance, after the report. */
function writeTimings(
  format: OutputFormat,
  runs: readonly { name?: string; timings?: RunTimings }[],
): void {
  if (format === "json") return;
  for (const run of runs) {
    if (run.timings) {
      process.stderr.write(formatTimings(run.timings, run.name));
    }
  }
}

async function runTargets(
  targets: RunTarget[],
  args: ParsedArgs,
  cwd: string,
  trace: TraceSink,
): Promise<void> {
  const [firstTarget] = targets;
  let runs: { name?: string; report: PreflightReport; timings?: RunTimings }[];
  let renderAs: (format: OutputFormat) => string;
  if (!args.all && targets.length === 1 && firstTarget && !firstTarget.name) {
    // Single-instance: preserve the original single-report output exactly.
    const { report, url, timings, replay, failOn } = await runOneInstance(
      firstTarget,
      args,
      cwd,
      trace,
    );
    const ran = ranChecks(defaultChecks, [report]);
    runs = [{ report, ...(timings ? { timings } : {}) }];
    renderAs = (format) =>
      withFailOn(
        withReplayNote(
          render(report, format, undefined, ran, url, timings),
          format,
          replay,
        ),
        format,
        failOn,
      );
  } else {
    const reports: NamedReport[] = [];
    let replay: ReplayInfo | undefined;
    let failOn: FailOn = "fail";
    for (const target of targets) {
      const run = await runOneInstance(target, args, cwd, trace);
      const { report, url, timings } = run;
      replay ??= run.replay;
      if (run.failOn === "warn") failOn = "warn";
      reports.push({
        name: target.name ?? "instance",
        report,
        ...(url !== undefined ? { url } : {}),
        ...(timings !== undefined ? { timings } : {}),
      });
    }
    const ran = ranChecks(
      defaultChecks,
      reports.map((r) => r.report),
    );
    const [firstReport] = reports;
    runs = reports;
    renderAs = (format) =>
      withFailOn(
        reports.length === 1 && firstReport
          ? withReplayNote(
              render(
                firstReport.report,
                format,
                firstReport.name,
                ran,
                firstReport.url,
                firstReport.timings,
              ),
              format,
              replay,
            )
          : renderAll(reports, format, ran),
        format,
        failOn,
      );
  }

  process.stdout.write(renderAs(args.format));
  for (const output of args.outputs) {
    writeAtomic(resolve(cwd, output.path), renderAs(output.format));
  }
  publishToGitHub(
    args,
    runs.map((r) => r.report),
    () => renderAs("markdown"),
  );
  writeTimings(args.format, runs);
  writeFailOnNote(runs);
  process.exitCode = runs.every((r) => r.report.ok) ? 0 : 1;
}

/**
 * Inside GitHub Actions (F-X-16): append the markdown report to the step
 * summary unless `--no-summary` / `SNPF_SUMMARY=0`, and the verdict to the
 * step outputs.
 */
function publishToGitHub(
  args: ParsedArgs,
  reports: readonly PreflightReport[],
  markdown: () => string,
): void {
  const env = process.env;
  const summary = parseSwitch(env.SNPF_SUMMARY, "SNPF_SUMMARY") ?? true;
  if (!args.noSummary && summary) appendSummary(env, markdown());
  appendOutputs(env, reports);
}

/** `sync <env>` — pull ATF metadata and write the instance's manifest. */
async function commandSync(args: ParsedArgs, cwd: string): Promise<void> {
  const env = singleInstanceName("sync", args, "Sync one instance at a time.");
  if (!env) {
    throw new UsageError(
      "sync needs an instance name: servicenow-preflight sync <env>.",
    );
  }
  const registry = await loadRegistry(cwd, args.registryPath);
  if (!registry) {
    throw new UsageError(
      "sync needs a registry; create .preflight/instances.json first.",
    );
  }
  const inst = resolveInstance(registry, env);
  const loaded = await loadConfig(cwd, {
    configPath: args.configPath,
    envPrefix: inst.envPrefix,
  });

  const http = createSnClient({
    instanceUrl: inst.url,
    ...(loaded.auth ? { auth: loaded.auth } : {}),
    ...(loaded.tls ? { tls: loaded.tls } : {}),
    ...(loaded.config.proxy ? { proxy: loaded.config.proxy } : {}),
    ...(loaded.config.noProxy ? { noProxy: loaded.config.noProxy } : {}),
    env: loaded.env,
    ...requestLimits(args, loaded.limits),
  });

  const existing = await loadManifest(env, cwd);
  const now = new Date().toISOString();
  const merged = await syncManifest(http, env, inst.url, existing, {
    scope: inst.scope,
    withLastRun: args.withLastRun,
    allowEmpty: args.allowEmpty,
    now,
  });
  const path = await writeManifest(merged, cwd);
  process.stdout.write(
    `Synced ${merged.tests.length} test(s), ${merged.suites.length} suite(s) from "${env}" → ${path}\n`,
  );
}

/** `drift <src> <dst>` — compare two committed manifests (no network). */
async function commandDrift(args: ParsedArgs, cwd: string): Promise<void> {
  const [src, dst] = args.positionals;
  if (!src || !dst) {
    throw new UsageError(
      "drift needs two instances: servicenow-preflight drift <source> <target>.",
    );
  }
  // A third positional was dropped on the floor, so `drift dev staging prod`
  // compared dev→staging and said nothing about prod — while exiting 0, which
  // reads as a clean promote for all three.
  if (args.positionals.length > 2) {
    throw new UsageError(
      `drift compares exactly two instances, but got ${
        args.positionals.length
      }: ${args.positionals.join(
        ", ",
      )}. Compare one source/target pair at a time.`,
    );
  }
  // CC-14: the positionals become manifest paths — validate them (reject
  // separators/`..`/whitespace) rather than let a crafted name walk the tree.
  validateInstanceName(src, "drift <source>");
  validateInstanceName(dst, "drift <target>");
  // CC-35: comparing an instance to itself is a no-op that always reports a
  // clean promote — almost certainly a typo. Reject it up front.
  if (src === dst) {
    throw new UsageError(
      `drift needs two different instances; got "${src}" for both source and target.`,
    );
  }
  // Delegated decision 2026-09-28 (wave 13): resolve the registry BEFORE the
  // manifests, so a mistyped explicit --registry is a usage error (exit 2)
  // rather than masked by a missing-manifest error.
  const registry = await loadRegistry(cwd, args.registryPath);
  const source = await loadManifest(src, cwd);
  const target = await loadManifest(dst, cwd);
  if (!source) {
    throw new UsageError(
      `No manifest for "${src}"; run: servicenow-preflight sync ${src}.`,
    );
  }
  if (!target) {
    throw new UsageError(
      `No manifest for "${dst}"; run: servicenow-preflight sync ${dst}.`,
    );
  }

  // `test-drift` compares already-loaded manifests and never touches the
  // network; the client is a placeholder to satisfy the context shape.
  const http = createSnClient({ instanceUrl: "https://invalid.invalid" });
  const ctx: PreflightContext = {
    http,
    instance: src,
    manifest: source,
    driftTarget: target,
  };
  const report = await runPreflight(ctx, [testDrift], {
    signal: interrupt.signal,
  });

  // Fold in a manifest-freshness check: a manifest older than the warn
  // threshold (30d) surfaces a warning; with --max-age, one older than that
  // hard-fails the compare (a stale promote gate is worse than none).
  const refs: DriftManifestRef[] = [
    { role: "source", manifest: source },
    { role: "target", manifest: target },
  ];
  const stale = stalenessResults(refs, {
    warnAfterMs: DEFAULT_STALE_WARN_MS,
    maxAgeMs: args.maxAgeMs,
  });
  // Fold in promotion order from the registry's promotesTo edges: a pair that
  // skips a declared stage, runs upstream, or sits on no shared chain fails the
  // gate (a skip only warns under --allow-stage-skip); a missing registry or
  // pipeline yields an advisory warn, since the pipeline is opt-in.
  const order = promotionOrderResult(registry, src, dst, {
    allowStageSkip: args.allowStageSkip,
  });
  // Fold in version parity: platform identity (OPP-1) and installed app/plugin
  // versions (OPP-5) recorded at sync time. A build-name mismatch or an app
  // missing/downgraded on the target fails the promote gate; manifests written
  // before version capture yield an advisory warn instead.
  const parity = versionParityResults(source, target);
  const extra = [order, ...stale, ...parity];
  const finalReport = extra.length > 0 ? mergeResults(report, extra) : report;

  process.stdout.write(
    render(finalReport, args.format, undefined, [testDrift]),
  );
  process.exitCode = finalReport.ok ? 0 : 1;
}

/** `list` / `explain` print only pretty or json; any other format is exit 2. */
function catalogueFormat(args: ParsedArgs): "pretty" | "json" {
  if (args.format === "pretty" || args.format === "json") return args.format;
  throw new UsageError(
    `${args.command} supports --format pretty or json, not ${args.format}.`,
  );
}

/** One-line catalogue row: `name severity rule description`. */
function listLine(d: CheckDescriptor, nameWidth: number): string {
  const drift = d.inDefaultSuite ? "" : " (drift only)";
  return `${d.name.padEnd(nameWidth)}  ${(d.meta.severity ?? "-").padEnd(
    8,
  )}  ${(d.meta.rule ?? "-").padEnd(4)}  ${d.description}${drift}\n`;
}

/** `list`: the check catalogue — the default suite, then `test-drift`. */
function commandList(args: ParsedArgs): void {
  const format = catalogueFormat(args);
  if (args.positionals.length > 0) {
    throw new UsageError(
      `list takes no positional arguments, got: ${args.positionals.join(", ")}.`,
    );
  }
  const descriptors = describeChecks([...defaultChecks, testDrift]);
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(descriptors, null, 2)}\n`);
    return;
  }
  const width = Math.max(...descriptors.map((d) => d.name.length));
  process.stdout.write(descriptors.map((d) => listLine(d, width)).join(""));
}

/** `explain <check>`: everything the catalogue knows about one check. */
function commandExplain(args: ParsedArgs): void {
  const format = catalogueFormat(args);
  const [name, ...rest] = args.positionals;
  if (name === undefined || rest.length > 0) {
    throw new UsageError(
      'explain takes exactly one check name, e.g. "servicenow-preflight explain table-crud-acl".',
    );
  }
  const check = findCheck(name);
  if (!check) {
    const all = [...defaultChecks, testDrift].map((c) => c.name);
    const suggestions = closestNames(name, all);
    const hint =
      suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
    throw new UsageError(
      `Unknown check "${name}". Run "servicenow-preflight list".${hint}`,
    );
  }
  const [d] = describeChecks([check]) as [CheckDescriptor];
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
    return;
  }
  const m = d.meta;
  const lines = [`${d.name}${d.inDefaultSuite ? "" : " (drift only)"}`, ""];
  lines.push(d.description, "");
  if (m.rule !== undefined) {
    const title = RULE_TITLES[m.rule];
    lines.push(`Rule:        ${m.rule}${title ? ` — ${title}` : ""}`);
  }
  lines.push(`Severity:    ${m.severity ?? "-"}`);
  lines.push(
    `Tables:      ${m.tables && m.tables.length > 0 ? m.tables.join(", ") : "-"}`,
  );
  const flags = [m.offline ? "offline" : "", m.serial ? "serial" : ""].filter(
    Boolean,
  );
  lines.push(`Flags:       ${flags.length > 0 ? flags.join(", ") : "-"}`);
  if (m.verdicts) {
    lines.push("", "Verdicts:");
    lines.push(`  pass  ${m.verdicts.pass}`);
    lines.push(`  warn  ${m.verdicts.warn}`);
    lines.push(`  fail  ${m.verdicts.fail}`);
  }
  if (m.remediation !== undefined) {
    lines.push("", "Remediation:", `  ${m.remediation}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * Aborted on the first SIGINT: the running check is cut short, the remaining
 * ones report as aborted, the partial report is still printed, and the process
 * exits 130. A second SIGINT gets Node's default (immediate exit).
 */
const interrupt = new AbortController();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const cwd = process.cwd();
  if (
    args.command !== "run" &&
    (args.baseline !== undefined ||
      args.writeBaseline !== undefined ||
      args.severity !== undefined)
  ) {
    throw new UsageError(
      `--baseline / --write-baseline / --severity apply to run only, not ${args.command}.`,
    );
  }
  if (args.command !== "config" && (args.out !== undefined || args.write)) {
    throw new UsageError(
      `--out / --write apply to config only, not ${args.command}.`,
    );
  }
  if (
    args.command !== "init" &&
    (args.scope !== undefined ||
      args.ci !== undefined ||
      args.auth !== undefined ||
      args.multi ||
      args.yes)
  ) {
    throw new UsageError(
      `--scope / --ci / --auth / --multi / --yes apply to init only, not ${args.command}.`,
    );
  }
  switch (args.command) {
    case "init":
      await commandInit(args, cwd);
      return;
    case "config":
      await commandConfig(args, cwd, [...defaultChecks, testDrift]);
      return;
    case "list":
      commandList(args);
      return;
    case "explain":
      commandExplain(args);
      return;
    case "sync":
      await commandSync(args, cwd);
      return;
    case "drift":
      await commandDrift(args, cwd);
      return;
    default:
      process.once("SIGINT", () => {
        interrupt.abort(
          new DOMException("Interrupted (SIGINT).", "AbortError"),
        );
      });
      await commandRun(args, cwd);
      if (interrupt.signal.aborted) process.exitCode = 130;
  }
}

void main().catch((err: unknown) => {
  // Print the message, not the stack: the stack is noise for a CLI user and can
  // echo internal paths. A typed SnError's message is already user-facing and
  // secret-free (credentials never appear in it).
  console.error(err instanceof Error ? err.message : String(err));
  // F-X-10: a refused request carries its likely causes; print them as hints.
  if (err instanceof SnAuthError && err.diagnosis.length > 0) {
    console.error(
      ["  Possible causes:", ...err.diagnosis.map((d) => `  - ${d}`)].join(
        "\n",
      ),
    );
  }
  // Split exit codes (CC-41): a usage/config error (wrong invocation, invalid
  // config or registry) is a distinct failure mode from a check that ran and
  // failed. Exit 2 for the former, 1 for a check failure or a runtime error.
  process.exit(err instanceof UsageError ? 2 : 1);
});
