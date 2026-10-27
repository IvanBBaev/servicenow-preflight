/**
 * `servicenow-preflight init` (F-X-13): scaffold a config, an optional
 * registry, a CI pipeline and `.gitignore` entries. {@link planInit} is pure;
 * {@link applyInit} writes the plan. Credentials are never written: `init`
 * only prints the environment variable names to set.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeAtomic } from "./atomic-write.js";
import { UsageError } from "./config.js";
import { isSafeIdentifier } from "./http/query.js";
import { PREFLIGHT_DIR, REGISTRY_BASENAME } from "./registry.js";

export const INIT_CI = ["github", "gitlab", "azure", "none"] as const;
export type InitCi = (typeof INIT_CI)[number];

export const INIT_AUTH = ["basic", "oauth-client", "bearer", "mtls"] as const;
export type InitAuth = (typeof INIT_AUTH)[number];

export interface InitAnswers {
  /** Instance origin; required for `multi`. */
  instanceUrl?: string;
  scope?: string;
  /** Decides only which env names are printed and mapped in CI. */
  auth: InitAuth;
  /** Write `.preflight/instances.json` with one `dev` instance. */
  multi: boolean;
  ci: InitCi;
}

/**
 * One planned file: `create` writes a new file (refused over an existing one
 * without `--force`); `append-lines` adds the lines a file does not hold yet.
 */
export type FileOp =
  | { kind: "create"; path: string; content: string }
  | { kind: "append-lines"; path: string; lines: string[] };

/** Config file name `init` writes. */
export const INIT_CONFIG_FILE = "preflight.config.json";

/** `$schema` reference to the schema shipped in the package (F-X-7). */
export const INIT_SCHEMA_REF =
  "./node_modules/servicenow-preflight/schemas/preflight.config.v1.json";

/** Paths `init` keeps out of git. */
export const INIT_GITIGNORE = [
  ".env",
  ".preflight/fixtures/",
  ".preflight/trace*.ndjson",
];

/** Registry instance name used by `--multi`. */
const MULTI_INSTANCE = "dev";

/** Credential env names per auth kind; values are placeholders. */
const AUTH_ENV: Record<InitAuth, string[]> = {
  basic: ["SNPF_USER", "SNPF_PASS"],
  "oauth-client": ["SNPF_OAUTH_CLIENT_ID", "SNPF_OAUTH_CLIENT_SECRET"],
  bearer: ["SNPF_TOKEN"],
  mtls: ["SNPF_MTLS_CERT", "SNPF_MTLS_KEY"],
};

/** Parse a `--ci` value. */
export function parseInitCi(value: string): InitCi {
  if ((INIT_CI as readonly string[]).includes(value)) return value as InitCi;
  throw new UsageError(`Unknown --ci "${value}"; use ${INIT_CI.join(", ")}.`);
}

/** Parse an `--auth` value. */
export function parseInitAuth(value: string): InitAuth {
  if ((INIT_AUTH as readonly string[]).includes(value)) {
    return value as InitAuth;
  }
  throw new UsageError(
    `Unknown --auth "${value}"; use ${INIT_AUTH.join(", ")}.`,
  );
}

/** Normalise an instance URL to its origin; http(s) only. */
export function normaliseInstanceUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new UsageError(`Instance URL is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UsageError(
      `Instance URL must use https (or http), got ${parsed.protocol.replace(":", "")}.`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new UsageError(
      "Instance URL must not carry credentials; set them in the environment.",
    );
  }
  return parsed.origin;
}

/** Validate and normalise raw answers (from flags or prompts). */
export function normaliseAnswers(answers: InitAnswers): InitAnswers {
  const url = answers.instanceUrl?.trim();
  const scope = answers.scope?.trim();
  if (scope && !isSafeIdentifier(scope)) {
    throw new UsageError(
      `Scope "${String(answers.scope)}" contains characters outside [A-Za-z0-9_.-].`,
    );
  }
  if (answers.multi && !url) {
    throw new UsageError(
      "init --multi needs the instance URL (--instance <url>) for the registry.",
    );
  }
  return {
    ...(url ? { instanceUrl: normaliseInstanceUrl(url) } : {}),
    ...(scope ? { scope } : {}),
    auth: answers.auth,
    multi: answers.multi,
    ci: answers.ci,
  };
}

/** The env names to set, with placeholder values (`NAME=<placeholder>`). */
export function envHints(answers: InitAnswers): string[] {
  const names = [
    ...(answers.instanceUrl ? [] : ["SNPF_INSTANCE"]),
    ...AUTH_ENV[answers.auth],
  ];
  return names.map((name) => `${name}=<${placeholder(name)}>`);
}

function placeholder(name: string): string {
  return name
    .slice("SNPF_".length)
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^instance$/, "instance url")
    .replace(/^pass$/, "password");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Plan every file for `answers` (already normalised). Pure: the same answers
 * always give the same plan. No op ever targets `.env`.
 */
export function planInit(answers: InitAnswers, version: string): FileOp[] {
  const ops: FileOp[] = [];
  const config: Record<string, unknown> = { $schema: INIT_SCHEMA_REF };
  if (!answers.multi && answers.instanceUrl) {
    config.instanceUrl = answers.instanceUrl;
  }
  if (!answers.multi && answers.scope) config.scope = answers.scope;
  ops.push({ kind: "create", path: INIT_CONFIG_FILE, content: json(config) });

  if (answers.multi && answers.instanceUrl) {
    ops.push({
      kind: "create",
      path: `${PREFLIGHT_DIR}/${REGISTRY_BASENAME}`,
      content: json({
        version: 1,
        ...(answers.scope ? { scope: answers.scope } : {}),
        instances: {
          [MULTI_INSTANCE]: {
            url: answers.instanceUrl,
            stage: MULTI_INSTANCE,
            promotesTo: null,
          },
        },
      }),
    });
  }

  const pipeline = ciFile(answers, version);
  if (pipeline) ops.push({ kind: "create", ...pipeline });
  ops.push({ kind: "append-lines", path: ".gitignore", lines: INIT_GITIGNORE });
  return ops;
}

/** The CI env names: the instance (unless in the config) and the credentials. */
function ciEnv(answers: InitAnswers): string[] {
  return [
    ...(answers.instanceUrl ? [] : ["SNPF_INSTANCE"]),
    ...AUTH_ENV[answers.auth],
  ];
}

function ciFile(
  answers: InitAnswers,
  version: string,
): { path: string; content: string } | undefined {
  const names = ciEnv(answers);
  const tag = /^\d+\.\d+\.\d+/.test(version) ? version : "latest";
  const args = answers.multi ? `run ${MULTI_INSTANCE}` : "run";
  switch (answers.ci) {
    case "github":
      return {
        path: ".github/workflows/preflight.yml",
        content: [
          "name: ServiceNow preflight",
          "on: [workflow_dispatch, pull_request]",
          "",
          "jobs:",
          "  preflight:",
          "    runs-on: ubuntu-latest",
          "    permissions:",
          "      contents: read",
          "      security-events: write # to upload SARIF",
          "    steps:",
          "      - uses: actions/checkout@v5",
          `      - uses: IvanBBaev/servicenow-preflight@${tag === "latest" ? "main" : `v${tag}`}`,
          "        env:",
          ...names.map((n) => `          ${n}: \${{ secrets.${n} }}`),
          ...(answers.multi
            ? ["        with:", `          instance: ${MULTI_INSTANCE}`]
            : []),
          "",
        ].join("\n"),
      };
    case "gitlab":
      return {
        path: ".gitlab-ci.yml",
        content: [
          "# Set " + names.join(", ") + " as masked CI/CD variables.",
          "include:",
          `  - remote: "https://raw.githubusercontent.com/IvanBBaev/servicenow-preflight/${tag === "latest" ? "main" : `v${tag}`}/ci/gitlab/servicenow-preflight.gitlab-ci.yml"`,
          "",
          "servicenow-preflight:",
          "  variables:",
          `    SNPF_VERSION: "${tag}"`,
          `    SNPF_ARGS: "${args}"`,
          "",
        ].join("\n"),
      };
    case "azure":
      return {
        path: "azure-pipelines.yml",
        content: [
          "# Define " + names.join(", ") + " as (secret) pipeline variables.",
          "trigger: none",
          "pr:",
          "  - main",
          "",
          "pool:",
          "  vmImage: ubuntu-latest",
          "",
          "steps:",
          "  - task: NodeTool@0",
          "    inputs:",
          '      versionSpec: "22"',
          "  - script: >-",
          `      npx --yes servicenow-preflight@${tag} ${args}`,
          "      --output junit=$(Agent.TempDirectory)/snpf-junit.xml",
          "    displayName: ServiceNow preflight",
          "    env:",
          ...names.map((n) => `      ${n}: $(${n})`),
          "  - task: PublishTestResults@2",
          "    condition: always()",
          "    inputs:",
          "      testResultsFormat: JUnit",
          "      testResultsFiles: $(Agent.TempDirectory)/snpf-junit.xml",
          "",
        ].join("\n"),
      };
    default:
      return undefined;
  }
}

export interface InitResult {
  created: string[];
  overwritten: string[];
  /** Files that gained lines (`.gitignore`). */
  appended: string[];
}

/**
 * Write the plan under `cwd`. Every `create` target is checked first: an
 * existing one without `force` refuses the whole plan (nothing written).
 */
export function applyInit(
  cwd: string,
  ops: readonly FileOp[],
  { force }: { force: boolean },
): InitResult {
  const conflicts = ops.filter(
    (op) => op.kind === "create" && existsSync(resolve(cwd, op.path)),
  );
  if (conflicts.length > 0 && !force) {
    throw new UsageError(
      `init would overwrite ${conflicts.map((op) => op.path).join(", ")}; pass --force to replace ${conflicts.length === 1 ? "it" : "them"}.`,
    );
  }
  const result: InitResult = { created: [], overwritten: [], appended: [] };
  for (const op of ops) {
    const abs = resolve(cwd, op.path);
    if (op.kind === "create") {
      (existsSync(abs) ? result.overwritten : result.created).push(op.path);
      writeAtomic(abs, op.content);
      continue;
    }
    const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const next = appendLines(before, op.lines);
    if (next !== before) {
      writeAtomic(abs, next);
      result.appended.push(op.path);
    }
  }
  return result;
}

/** Add each line `text` lacks (exact, trimmed match), keeping a final newline. */
export function appendLines(text: string, lines: readonly string[]): string {
  const have = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = lines.filter((line) => !have.has(line));
  if (missing.length === 0) return text;
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${base}${missing.join("\n")}\n`;
}
