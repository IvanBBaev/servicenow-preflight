import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPreflight } from "./index.js";
import { loadConfig, UsageError } from "./config.js";
import { createSnClient } from "./http/client.js";
import { formatJUnit, formatJUnitSuites } from "./report/junit.js";
import { formatSarif } from "./report/sarif.js";
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
  type DriftManifestRef,
} from "./state/drift.js";
import { testDrift } from "./checks/index.js";
import type {
  CheckResult,
  CheckStatus,
  PreflightContext,
  PreflightReport,
} from "./types.js";

/** Output format for the report. */
type OutputFormat = "pretty" | "json" | "junit" | "sarif";

const FORMATS: readonly OutputFormat[] = ["pretty", "json", "junit", "sarif"];

/** Subcommand: run checks, sync a manifest, or compare two instances. */
type Subcommand = "run" | "sync" | "drift";

const SUBCOMMANDS: readonly Subcommand[] = ["run", "sync", "drift"];

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
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a `--max-age` duration: an integer or decimal followed by a single
 * unit — `s` (seconds), `m` (minutes), `h` (hours), `d` (days) or `w` (weeks),
 * e.g. `30d`, `24h`, `1.5h`. Returns milliseconds. Throws {@link UsageError} on
 * a malformed value (so it maps to exit 2).
 */
function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(value.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  const unitMs = unit ? DURATION_UNIT_MS[unit] : undefined;
  if (amount === undefined || unitMs === undefined) {
    throw new UsageError(
      `Invalid --max-age "${value}". Use <number><unit> with unit s, m, h, d or w (e.g. 7d, 24h).`,
    );
  }
  return Number.parseFloat(amount) * unitMs;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: "run",
    positionals: [],
    all: false,
    withLastRun: false,
    allowEmpty: false,
    format: "pretty",
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
  return args;
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

Multi-instance (registry at .preflight/instances.json):
  <env>                  A registry instance name (dev | staging | test | prod)
  -e, --env <name>       Select the instance (same as the positional)
      --all              run: every instance in the registry
      --registry <path>  Registry file (default .preflight/instances.json)
      --with-last-run    sync: also pull each test's most recent result
      --allow-empty      sync: commit an empty snapshot over a non-empty manifest
                         (refused by default as likely ACL security-trimming;
                         cannot override a proven security-trimmed pull)

Options:
  -i, --instance <url>   Target instance URL (single-instance, no registry)
      --config <path>    Path to a preflight config file
      --only <csv>       Run only these checks (comma-separated names)
      --skip <csv>       Skip these checks (comma-separated names)
      --format <fmt>     Output: pretty (default), json, junit, sarif
      --json             Shorthand for --format json
      --max-age <dur>    drift: fail if a compared manifest is older than <dur>.
                         Duration is <number><unit>, unit s|m|h|d|w (e.g. 7d,
                         24h). Without it, a manifest older than 30d only warns.
  -h, --help             Show this help
  -v, --version          Print the version and exit

Exit codes:
  0  no check failed
  1  a check failed (including a selection that matched zero checks, and a
     drift/promote or manifest-age gate that blocked)
  2  a usage or configuration error (unknown option, missing flag value,
     bad --format / --max-age, a required registry absent, an invalid config
     or registry file)

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

/** Render one report in the requested format to a string. */
function render(report: PreflightReport, format: OutputFormat): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(report, null, 2)}\n`;
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
function renderAll(reports: NamedReport[], format: OutputFormat): string {
  const ok = reports.every((r) => r.report.ok);
  if (format === "json") {
    const instances: Record<string, PreflightReport> = {};
    for (const r of reports) instances[r.name] = r.report;
    return `${JSON.stringify({ ok, instances }, null, 2)}\n`;
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

/** Run the check suite against one resolved instance. */
async function runOneInstance(
  target: RunTarget,
  args: ParsedArgs,
  cwd: string,
): Promise<PreflightReport> {
  const loaded = await loadConfig(cwd, {
    configPath: args.configPath,
    envPrefix: target.envPrefix,
  });

  const instanceUrl =
    args.instanceUrl ?? target.instanceUrl ?? loaded.config.instanceUrl;
  const scope = target.scope ?? loaded.config.scope;
  const manifest = target.name
    ? await loadManifest(target.name, cwd)
    : undefined;

  const select = {
    only: args.only ?? loaded.config.select?.only,
    skip: args.skip ?? loaded.config.select?.skip,
  };

  const http = createSnClient({
    instanceUrl: instanceUrl ?? "https://invalid.invalid",
    ...(loaded.auth ? { auth: loaded.auth } : {}),
    ...(loaded.tls ? { tls: loaded.tls } : {}),
    // Config-file / SNPF_PROXY settings ride along as explicit client
    // configuration, outranking HTTPS_PROXY/https_proxy (SR-5).
    ...(loaded.config.proxy ? { proxy: loaded.config.proxy } : {}),
    ...(loaded.config.noProxy ? { noProxy: loaded.config.noProxy } : {}),
  });

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
    options: loaded.config.options,
  };

  return runPreflight(ctx);
}

/** `run` — one instance, or all of them with `--all`. */
async function commandRun(args: ParsedArgs, cwd: string): Promise<void> {
  const registry = await loadRegistry(cwd, args.registryPath);
  const targets = resolveRunTargets(args, registry);

  const [firstTarget] = targets;
  if (!args.all && targets.length === 1 && firstTarget && !firstTarget.name) {
    // Single-instance: preserve the original single-report output exactly.
    const report = await runOneInstance(firstTarget, args, cwd);
    process.stdout.write(render(report, args.format));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  const reports: NamedReport[] = [];
  for (const target of targets) {
    const report = await runOneInstance(target, args, cwd);
    reports.push({ name: target.name ?? "instance", report });
  }

  const [firstReport] = reports;
  if (reports.length === 1 && firstReport) {
    process.stdout.write(render(firstReport.report, args.format));
  } else {
    process.stdout.write(renderAll(reports, args.format));
  }
  process.exitCode = reports.every((r) => r.report.ok) ? 0 : 1;
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
  const source = await loadManifest(src, cwd);
  const target = await loadManifest(dst, cwd);
  if (!source) {
    throw new Error(
      `No manifest for "${src}"; run: servicenow-preflight sync ${src}.`,
    );
  }
  if (!target) {
    throw new Error(
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
  const report = await runPreflight(ctx, [testDrift]);

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
  // Fold in version parity: platform identity (OPP-1) and installed app/plugin
  // versions (OPP-5) recorded at sync time. A build-name mismatch or an app
  // missing/downgraded on the target fails the promote gate; manifests written
  // before version capture yield an advisory warn instead.
  const parity = versionParityResults(source, target);
  const extra = [...stale, ...parity];
  const finalReport = extra.length > 0 ? mergeResults(report, extra) : report;

  process.stdout.write(render(finalReport, args.format));
  process.exitCode = finalReport.ok ? 0 : 1;
}

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
  switch (args.command) {
    case "sync":
      await commandSync(args, cwd);
      return;
    case "drift":
      await commandDrift(args, cwd);
      return;
    default:
      await commandRun(args, cwd);
  }
}

void main().catch((err: unknown) => {
  // Print the message, not the stack: the stack is noise for a CLI user and can
  // echo internal paths. A typed SnError's message is already user-facing and
  // secret-free (credentials never appear in it).
  console.error(err instanceof Error ? err.message : String(err));
  // Split exit codes (CC-41): a usage/config error (wrong invocation, invalid
  // config or registry) is a distinct failure mode from a check that ran and
  // failed. Exit 2 for the former, 1 for a check failure or a runtime error.
  process.exit(err instanceof UsageError ? 2 : 1);
});
