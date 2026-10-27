/**
 * `servicenow-preflight config schema | validate | migrate` (F-X-7). Offline:
 * no credentials, no `.env`, no network.
 */
import { relative, resolve } from "node:path";
import { writeAtomic } from "./atomic-write.js";
import { closestNames } from "./catalogue.js";
import {
  findConfigFile,
  loadConfig,
  readConfigFile,
  UsageError,
} from "./config.js";
import {
  describeIssue,
  renderConfigSchema,
  validateConfig,
} from "./options/config-schema.js";
import { migrateConfig, unifiedDiff } from "./options/migrate.js";
import type { Check } from "./types.js";

export const CONFIG_ACTIONS = ["schema", "validate", "migrate"] as const;

export interface ConfigCommandArgs {
  positionals: string[];
  configPath?: string;
  /** `schema`: write to this file instead of stdout. */
  out?: string;
  /** `migrate`: rewrite the file instead of printing the diff. */
  write: boolean;
}

/** Run one `config` action against `checks` (the full registry). */
export async function commandConfig(
  args: ConfigCommandArgs,
  cwd: string,
  checks: readonly Check[],
): Promise<void> {
  const [action, ...rest] = args.positionals;
  if (action === undefined || rest.length > 0) {
    throw new UsageError(
      `config takes one action: ${CONFIG_ACTIONS.join(", ")} (e.g. "servicenow-preflight config validate").`,
    );
  }
  if (!(CONFIG_ACTIONS as readonly string[]).includes(action)) {
    const hints = closestNames(action, CONFIG_ACTIONS);
    throw new UsageError(
      `Unknown config action "${action}"; use ${CONFIG_ACTIONS.join(", ")}.${
        hints.length ? ` Did you mean: ${hints.join(", ")}?` : ""
      }`,
    );
  }
  if (args.out !== undefined && action !== "schema") {
    throw new UsageError("--out applies to config schema only.");
  }
  if (args.write && action !== "migrate") {
    throw new UsageError("--write applies to config migrate only.");
  }

  if (action === "schema") {
    const text = `${JSON.stringify(renderConfigSchema(checks), null, 2)}\n`;
    if (args.out === undefined) {
      process.stdout.write(text);
    } else {
      writeAtomic(resolve(cwd, args.out), text);
    }
    return;
  }

  const path = findConfigFile(cwd, args.configPath);
  if (!path) {
    throw new UsageError(
      "No config file found (preflight.config.json, .js or .mjs); pass --config <path>.",
    );
  }
  const shown = relative(cwd, path) || path;
  if (action === "validate") await validate(path, shown, cwd, checks);
  else await migrate(path, shown, args.write, checks);
}

async function validate(
  path: string,
  shown: string,
  cwd: string,
  checks: readonly Check[],
): Promise<void> {
  const raw = await readConfigFile(path);
  const issues = validateConfig(raw, checks);
  if (issues.length > 0) {
    for (const issue of issues) {
      process.stderr.write(`${shown}: ${describeIssue(issue)}\n`);
    }
    throw new UsageError(
      `${shown}: ${issues.length} problem${issues.length === 1 ? "" : "s"} found.`,
    );
  }
  // The load-time guards the schema cannot express (query-injection-safe
  // identifiers) still apply; run them without the environment or `.env`.
  await loadConfig(cwd, {
    configPath: path,
    env: {},
    dotenv: false,
    credentials: false,
  });
  process.stdout.write(`${shown}: valid.\n`);
}

async function migrate(
  path: string,
  shown: string,
  write: boolean,
  checks: readonly Check[],
): Promise<void> {
  if (!path.endsWith(".json")) {
    throw new UsageError(
      `config migrate supports JSON configs only; move the options of ${shown} by hand.`,
    );
  }
  const raw = await readConfigFile(path);
  const result = migrateConfig(raw as Record<string, unknown>, checks);
  if (!result.changed) {
    process.stdout.write(`${shown} is already in the checks layout.\n`);
    return;
  }
  const after = `${JSON.stringify(result.config, null, 2)}\n`;
  if (write) {
    writeAtomic(path, after);
    const keys = Object.entries(result.moved)
      .map(([key, names]) => `${key} -> ${names.join(", ")}`)
      .join("; ");
    process.stdout.write(`Migrated ${shown}: ${keys}.\n`);
    return;
  }
  const before = `${JSON.stringify(raw, null, 2)}\n`;
  process.stdout.write(unifiedDiff(shown, before, after));
}
