import { runPreflight } from "./index.js";
import { loadConfig } from "./config.js";
import { createSnClient } from "./http/client.js";
import { formatJUnit } from "./report/junit.js";
import { formatSarif } from "./report/sarif.js";
import type {
  CheckStatus,
  PreflightContext,
  PreflightReport,
} from "./types.js";

/** Output format for the report. */
type OutputFormat = "pretty" | "json" | "junit" | "sarif";

const FORMATS: readonly OutputFormat[] = ["pretty", "json", "junit", "sarif"];

interface ParsedArgs {
  instanceUrl?: string;
  configPath?: string;
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
  const args: ParsedArgs = { format: "pretty", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--json":
        args.format = "json";
        break;
      case "-i":
      case "--instance":
        args.instanceUrl = argv[++i];
        break;
      case "--config":
        args.configPath = argv[++i];
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
        } else if (arg?.startsWith("--config=")) {
          args.configPath = arg.slice("--config=".length);
        } else if (arg?.startsWith("--only=")) {
          args.only = splitCsv(arg.slice("--only=".length));
        } else if (arg?.startsWith("--skip=")) {
          args.skip = splitCsv(arg.slice("--skip=".length));
        } else if (arg?.startsWith("--format=")) {
          args.format = parseFormat(arg.slice("--format=".length));
        }
        break;
    }
  }
  return args;
}

const HELP = `servicenow-preflight — run pre-deployment checks against a ServiceNow instance

Usage:
  servicenow-preflight [options]

Options:
  -i, --instance <url>   Target ServiceNow instance URL
      --config <path>    Path to a preflight config file
      --only <csv>       Run only these checks (comma-separated names)
      --skip <csv>       Skip these checks (comma-separated names)
      --format <fmt>     Output: pretty (default), json, junit, sarif
      --json             Shorthand for --format json
  -h, --help             Show this help
`;

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: "✓",
  warn: "!",
  fail: "✗",
};

/** Render the report in the requested format to a string. */
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const loaded = await loadConfig(process.cwd(), {
    configPath: args.configPath,
  });

  const instanceUrl = args.instanceUrl ?? loaded.config.instanceUrl;
  const select = {
    only: args.only ?? loaded.config.select?.only,
    skip: args.skip ?? loaded.config.select?.skip,
  };

  // Checks call `ctx.http`, never `fetch`. Even without credentials/instance we
  // supply a client so a check that doesn't need the network can still run; a
  // real request will surface a typed SnError.
  const http = createSnClient({
    instanceUrl: instanceUrl ?? "https://invalid.invalid",
    auth: loaded.auth ?? { kind: "basic", user: "", pass: "" },
  });

  const ctx: PreflightContext = {
    instanceUrl,
    auth: loaded.auth,
    http,
    scope: loaded.config.scope,
    updateSetId: loaded.config.updateSetId,
    select,
    options: loaded.config.options,
  };

  const report = await runPreflight(ctx);
  process.stdout.write(render(report, args.format));
  process.exitCode = report.ok ? 0 : 1;
}

void main().catch((err: unknown) => {
  // Print the message, not the stack: the stack is noise for a CLI user and can
  // echo internal paths. A typed SnError's message is already user-facing and
  // secret-free (credentials never appear in it).
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
