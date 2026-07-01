import { runPreflight } from "./index.js";
import type { CheckStatus, PreflightContext } from "./types.js";

interface ParsedArgs {
  instanceUrl?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "-i":
      case "--instance":
        args.instanceUrl = argv[++i];
        break;
      default:
        if (arg?.startsWith("--instance=")) {
          args.instanceUrl = arg.slice("--instance=".length);
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
      --json             Emit the report as JSON
  -h, --help             Show this help
`;

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: "✓",
  warn: "!",
  fail: "✗",
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const ctx: PreflightContext = { instanceUrl: args.instanceUrl };
  const report = await runPreflight(ctx);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const result of report.results) {
      process.stdout.write(
        `${STATUS_ICON[result.status]} ${result.name}: ${result.message}\n`,
      );
    }
    const { pass, warn, fail } = report.summary;
    process.stdout.write(
      `\n${pass} passed, ${warn} warnings, ${fail} failed\n`,
    );
  }

  process.exitCode = report.ok ? 0 : 1;
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
