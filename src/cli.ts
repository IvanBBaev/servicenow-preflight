import { runPreflight } from "./index.js";
import { loadConfig } from "./config.js";
import { createSnClient } from "./http/client.js";
import { formatJUnit } from "./report/junit.js";
import { formatSarif } from "./report/sarif.js";
import {
  loadRegistry,
  resolveInstance,
  instanceNames,
  type InstanceRegistry,
} from "./registry.js";
import { loadManifest, writeManifest } from "./state/manifest.js";
import { syncManifest } from "./state/sync.js";
import { testDrift } from "./checks/index.js";
import type {
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
  only?: string[];
  skip?: string[];
  format: OutputFormat;
  help: boolean;
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
  return "pretty";
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: "run",
    positionals: [],
    all: false,
    withLastRun: false,
    format: "pretty",
    help: false,
  };

  // A leading bare token naming a subcommand selects it; otherwise the default
  // `run` applies and the token (if any) is treated as a positional env name.
  let start = 0;
  const first = argv[0];
  if (first && (SUBCOMMANDS as readonly string[]).includes(first)) {
    args.command = first as Subcommand;
    start = 1;
  }

  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
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
      case "-i":
      case "--instance":
        args.instanceUrl = argv[++i];
        break;
      case "-e":
      case "--env":
        args.env = argv[++i];
        break;
      case "--config":
        args.configPath = argv[++i];
        break;
      case "--registry":
        args.registryPath = argv[++i];
        break;
      case "--only":
        args.only = splitCsv(argv[++i]);
        break;
      case "--skip":
        args.skip = splitCsv(argv[++i]);
        break;
      case "--format":
        args.format = parseFormat(argv[++i]);
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
          args.only = splitCsv(arg.slice("--only=".length));
        } else if (arg?.startsWith("--skip=")) {
          args.skip = splitCsv(arg.slice("--skip=".length));
        } else if (arg?.startsWith("--format=")) {
          args.format = parseFormat(arg.slice("--format=".length));
        } else if (arg && !arg.startsWith("-")) {
          args.positionals.push(arg);
        }
        break;
    }
  }
  return args;
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

Options:
  -i, --instance <url>   Target instance URL (single-instance, no registry)
      --config <path>    Path to a preflight config file
      --only <csv>       Run only these checks (comma-separated names)
      --skip <csv>       Skip these checks (comma-separated names)
      --format <fmt>     Output: pretty (default), json, junit, sarif
      --json             Shorthand for --format json
  -h, --help             Show this help

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
  // junit / sarif — one document per instance, concatenated.
  return reports.map((r) => render(r.report, format)).join("");
}

/** A single instance to run checks against. */
interface RunTarget {
  /** Registry name (`dev`…), or `undefined` for the single-instance path. */
  name?: string;
  instanceUrl?: string;
  envPrefix?: string;
  scope?: string;
}

/** Resolve which instance(s) a `run` targets from args + registry. */
function resolveRunTargets(
  args: ParsedArgs,
  registry: InstanceRegistry | undefined,
): RunTarget[] {
  if (args.all) {
    if (!registry) {
      throw new Error(
        "--all needs a registry; create .preflight/instances.json or drop --all.",
      );
    }
    return instanceNames(registry).map((name) => {
      const inst = resolveInstance(registry, name);
      return {
        name,
        instanceUrl: inst.url,
        envPrefix: inst.envPrefix,
        scope: inst.scope,
      };
    });
  }

  const env = args.env ?? args.positionals[0];
  if (env) {
    if (!registry) {
      throw new Error(
        `No registry found; cannot resolve instance "${env}". Create .preflight/instances.json or use --instance <url>.`,
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
  const env = args.env ?? args.positionals[0];
  if (!env) {
    throw new Error(
      "sync needs an instance name: servicenow-preflight sync <env>.",
    );
  }
  const registry = await loadRegistry(cwd, args.registryPath);
  if (!registry) {
    throw new Error(
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
  });

  const existing = await loadManifest(env, cwd);
  const now = new Date().toISOString();
  const merged = await syncManifest(http, env, inst.url, existing, {
    scope: inst.scope,
    withLastRun: args.withLastRun,
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
    throw new Error(
      "drift needs two instances: servicenow-preflight drift <source> <target>.",
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
  process.stdout.write(render(report, args.format));
  process.exitCode = report.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
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
  process.exit(1);
});
