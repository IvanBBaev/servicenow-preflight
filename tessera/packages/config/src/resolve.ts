// The one config source (PLAN Phase 1 §Configuration, ARCH-1).
//
// `resolveConfig` runs ONCE at startup and everything downstream — the CLI
// flags (DEV-5), the MCP tool arguments, `resolvePipeline(config)` — reads its
// output. That is the point of the phase: a CLI that parsed its own flags into
// its own shape would be a second config system, and the two would disagree
// about precedence the first time somebody added an option to only one of them.
//
// Three rules govern every branch below.
//
//  1. PRECEDENCE IS PER FIELD. flag > env > file > default, decided
//     independently for each option. A flag that sets `--runner` must not
//     discard the file's `scope`; nothing here merges whole layers.
//
//  2. NOTHING UNRECOGNISED IS DROPPED. An unknown flag, an unknown file key, a
//     stray positional, a flag missing its value, a non-numeric number — each
//     is a named error quoting the input it refused. Where the accepted input
//     is a closed set (flags, file keys, booleans, a `values` option) the error
//     lists it; where it is not (a number, an absent value) it names what was
//     expected instead. A silent drop in this exact position shipped once
//     already in this repository (`commandSync` ignoring extra positionals) and
//     produced green runs against nothing.
//
//  3. EVERY LAYER IS VALIDATED, not just the winning one. A config file with
//     `"mode": "aply"` is broken whether or not today's command line happens to
//     override it, and the operator who committed that file should hear about
//     it on the next run rather than on the run where the flag is absent.

import path from "node:path";

import { ConfigError, ConfigSecretError } from "./errors.js";
import {
  discoverConfigFile,
  readTextFileSync,
  type DiscoveredFile,
  type ReadTextFile,
} from "./file.js";
import { describeJson, isJsonArray, isJsonRecord } from "./json.js";
import {
  CONFIG_OPTION_KEY,
  INSTANCE_ALIAS_KEY,
  PREFLIGHT_OPTIONS,
  TOPOLOGY_ROLE_KEYS,
  allowsSource,
  findByFlag,
  findByKey,
} from "./options.js";
import {
  findSecret,
  hasUrlUserinfo,
  isSecretKey,
  secretValueShape,
} from "./secrets.js";
import type {
  ConfigSource,
  ConfigValues,
  OptionSpec,
  OptionValue,
  ResolvedConfig,
  ValuesOf,
} from "./types.js";

/** `ValuesOf` widened so it always satisfies the `ResolvedConfig` constraint. */
export type ResolvedValues<T extends readonly OptionSpec[]> = ValuesOf<T> &
  ConfigValues;

export interface ResolveInput<
  T extends readonly OptionSpec[] = typeof PREFLIGHT_OPTIONS,
> {
  /** Flags only — the caller strips the executable, the subcommand and `--`. */
  readonly argv?: readonly string[];
  /** Defaults to `process.env`. Injected so a test never mutates the real one. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Where upward discovery of `tessera.config.json` starts. */
  readonly cwd?: string;
  /** The only injected I/O; defaults to a `node:fs` read. */
  readonly readTextFile?: ReadTextFile;
  /** The option table. Defaults to the Phase-1 `PREFLIGHT_OPTIONS`. */
  readonly options?: T;
}

const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

/**
 * @throws ConfigError for any unrecognised, malformed or contradictory input.
 * @throws ConfigSecretError when a credential arrives through a channel that
 * leaks it — a config file or the command line.
 */
export function resolveConfig<
  T extends readonly OptionSpec[] = typeof PREFLIGHT_OPTIONS,
>(input: ResolveInput<T> = {}): ResolvedConfig<ResolvedValues<T>> {
  const options: readonly OptionSpec[] = input.options ?? PREFLIGHT_OPTIONS;
  assertTable(options);

  const argv = input.argv ?? [];
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const read = input.readTextFile ?? readTextFileSync;

  const flags = parseArgv(argv, options);

  // The config file's own location is resolved first, from the layers above it
  // — a file cannot say where it lives.
  const file = loadConfigFile({
    explicitPath: explicitConfigPath(options, flags, env),
    cwd,
    read,
    options,
  });

  const values: Record<string, OptionValue> = {};
  const provenance: Record<string, ConfigSource> = {};
  for (const spec of options) {
    const picked = pick(spec, flags, env, file);
    if (picked === undefined) continue;
    values[spec.key] = picked.value;
    provenance[spec.key] = picked.source;
  }

  const aliasedFrom = collapseInstanceAlias(options, values, provenance);

  return {
    values: values as unknown as ResolvedValues<T>,
    provenance,
    aliasedFrom,
    ...(file.path === undefined ? {} : { configFile: file.path }),
    options,
  };
}

// ── the option table itself ─────────────────────────────────────────────────

/**
 * Wiring bugs, caught at resolve time rather than by whichever caller happens
 * to trip over the ambiguity first. Two options answering to the same flag is
 * not a runtime condition; it is a broken table.
 */
function assertTable(options: readonly OptionSpec[]): void {
  const keys = new Set<string>();
  const flags = new Set<string>();
  const envNames = new Set<string>();
  for (const spec of options) {
    if (keys.has(spec.key)) {
      throw new ConfigError(`option table declares "${spec.key}" twice`);
    }
    keys.add(spec.key);
    if (flags.has(spec.flag)) {
      throw new ConfigError(`option table declares ${spec.flag} twice`);
    }
    flags.add(spec.flag);
    for (const name of [spec.env, spec.legacyEnv]) {
      if (name === undefined) continue;
      if (envNames.has(name)) {
        throw new ConfigError(`option table declares ${name} twice`);
      }
      envNames.add(name);
    }
    if (spec.repeatable === true && spec.type !== "list") {
      throw new ConfigError(
        `option "${spec.key}" is repeatable but not of type list`,
      );
    }
    if (
      spec.type !== "number" &&
      (spec.min !== undefined ||
        spec.max !== undefined ||
        spec.integer !== undefined)
    ) {
      throw new ConfigError(
        `option "${spec.key}" declares a numeric bound but is not of type number`,
      );
    }
    if (
      spec.min !== undefined &&
      spec.max !== undefined &&
      spec.min > spec.max
    ) {
      throw new ConfigError(
        `option "${spec.key}" declares min ${spec.min} > max ${spec.max}`,
      );
    }
    // The whole point of `secret` is that env is the only sanctioned channel;
    // a descriptor that says otherwise would hand the resolver a credential it
    // is then obliged to refuse.
    if (
      spec.secret === true &&
      (allowsSource(spec, "file") || allowsSource(spec, "flag"))
    ) {
      throw new ConfigError(
        `secret option "${spec.key}" must declare sources: ["env"] — a config file is committable and argv is world-readable`,
      );
    }
  }
}

function flagList(options: readonly OptionSpec[]): string {
  return options
    .map((option) => option.flag)
    .sort()
    .join(", ");
}

function keyList(options: readonly OptionSpec[]): string {
  return options
    .map((option) => option.key)
    .sort()
    .join(", ");
}

// ── the flag layer ──────────────────────────────────────────────────────────

/**
 * argv → raw text per option key. Values stay strings here; typing happens once
 * in `coerceText`, shared with the env layer, so `--json=maybe` and
 * `TESSERA_JSON=maybe` fail with the same message.
 */
function parseArgv(
  argv: readonly string[],
  options: readonly OptionSpec[],
): Map<string, string[]> {
  const raw = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("-")) {
      throw new ConfigError(
        `unexpected argument "${token}" — this resolver takes flags only (the caller strips the subcommand); valid flags: ${flagList(options)}`,
      );
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);

    const spec = findByFlag(options, name);
    if (spec === undefined) throw unknownFlagError(name, options);
    if (!allowsSource(spec, "flag")) throw flagNotAllowedError(spec);

    let text: string;
    if (spec.type === "boolean") {
      // A boolean flag never consumes the next token: `--json --scope x` must
      // set `json` and `scope`, not a scope-shaped boolean.
      text = inline ?? "true";
    } else if (inline !== undefined) {
      text = inline;
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new ConfigError(
          `${spec.flag} expects a value — none was given (use ${spec.flag}=<value> if the value starts with a dash)`,
        );
      }
      text = next;
      index += 1;
    }

    if (spec.type !== "boolean" && text.trim() === "") {
      throw new ConfigError(`${spec.flag} expects a non-empty value`);
    }

    const shape = secretValueShape(text);
    if (shape !== undefined) {
      throw new ConfigSecretError(
        `${spec.flag} was given ${shape} on the command line: argv is world-readable through ps(1), so this is no safer than committing it. Pass it in the environment or use the canonical credential store (ARCH-7).`,
        { keyPath: spec.flag, channel: "flag" },
      );
    }

    const existing = raw.get(spec.key);
    if (existing === undefined) {
      raw.set(spec.key, [text]);
    } else if (spec.repeatable === true) {
      existing.push(text);
    } else {
      throw new ConfigError(
        `${spec.flag} was given more than once and is not repeatable — one of the values would have been dropped`,
      );
    }
  }

  return raw;
}

/**
 * An unrecognised flag whose NAME reads like a credential gets the secret
 * refusal rather than "unknown flag". The operator's next move differs: they
 * must move the value to another channel, not fix a typo.
 */
function unknownFlagError(
  name: string,
  options: readonly OptionSpec[],
): ConfigError {
  if (isSecretKey(name.replace(/^-+/, ""))) {
    return new ConfigSecretError(
      `${name} is a credential-bearing flag and Tessera has none: argv is world-readable through ps(1), so a command line is no safer than a config file. Pass the value in the environment (TESSERA_*) or use the canonical credential store (ARCH-7).`,
      { keyPath: name, channel: "flag" },
    );
  }
  return new ConfigError(
    `unknown flag "${name}" — valid flags: ${flagList(options)}`,
  );
}

function flagNotAllowedError(spec: OptionSpec): ConfigError {
  if (spec.secret === true) {
    return new ConfigSecretError(
      `${spec.flag} carries a credential and may only come from the environment: argv is world-readable through ps(1).`,
      { keyPath: spec.flag, channel: "flag" },
    );
  }
  return new ConfigError(
    `${spec.flag} may not be given on the command line — allowed layers: ${(spec.sources ?? []).join(", ")}`,
  );
}

// ── the env layer ───────────────────────────────────────────────────────────

interface EnvHit {
  readonly texts: readonly string[];
  readonly origin: string;
}

/**
 * `TESSERA_*` first, then the descriptor's legacy transport name — the
 * documented precedence for a pass-through option (DEV-15's `SN_DOCS_DIR`):
 * whoever sets the Tessera name gets the Tessera name.
 *
 * An empty or whitespace-only variable counts as UNSET. A shell that expands an
 * undefined variable (`TESSERA_SCOPE="$SCOPE"`) produces exactly that, and
 * reading it as "an explicit empty scope" would be a worse answer than falling
 * through. The fall-through is not silent: `provenance` shows the layer that
 * actually won.
 */
function envLayer(
  spec: OptionSpec,
  env: Readonly<Record<string, string | undefined>>,
): EnvHit | undefined {
  if (!allowsSource(spec, "env")) return undefined;
  for (const name of [spec.env, spec.legacyEnv]) {
    if (name === undefined) continue;
    const value = env[name];
    if (value === undefined || value.trim() === "") continue;
    return { texts: [value], origin: name };
  }
  return undefined;
}

// ── the file layer ──────────────────────────────────────────────────────────

interface LoadedFile {
  readonly path?: string;
  readonly values: Readonly<Record<string, unknown>>;
}

function explicitConfigPath(
  options: readonly OptionSpec[],
  flags: ReadonlyMap<string, string[]>,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const spec = findByKey(options, CONFIG_OPTION_KEY);
  if (spec === undefined) return undefined;
  const fromFlag = flags.get(spec.key);
  if (fromFlag !== undefined)
    return String(coerceText(spec, fromFlag, spec.flag));
  const fromEnv = envLayer(spec, env);
  if (fromEnv !== undefined) {
    return String(coerceText(spec, fromEnv.texts, fromEnv.origin));
  }
  return undefined;
}

function loadConfigFile(args: {
  explicitPath: string | undefined;
  cwd: string;
  read: ReadTextFile;
  options: readonly OptionSpec[];
}): LoadedFile {
  const { explicitPath, cwd, read, options } = args;
  const guarded: ReadTextFile = (filePath) => {
    try {
      return read(filePath);
    } catch (error) {
      throw new ConfigError(
        `config file ${filePath} could not be read: ${message(error)}`,
        { cause: error },
      );
    }
  };

  let found: DiscoveredFile | undefined;
  if (explicitPath === undefined) {
    found = discoverConfigFile(cwd, guarded);
  } else {
    const resolved = path.resolve(cwd, explicitPath);
    const text = guarded(resolved);
    // Absence is normal for a discovered file and an error for a named one:
    // here the operator said which file to use and got a different world.
    if (text === undefined) {
      throw new ConfigError(`config file not found: ${resolved}`);
    }
    found = { path: resolved, text };
  }
  if (found === undefined) return { values: {} };

  let document: unknown;
  try {
    document = JSON.parse(found.text);
  } catch (error) {
    throw new ConfigError(
      `config file ${found.path} is not valid JSON: ${message(error)}`,
      { cause: error },
    );
  }

  // The secret scan runs BEFORE the unknown-key check, and over the whole
  // document rather than only its recognised keys. A credential under an
  // unrecognised section must be reported as a credential — "unknown key auth"
  // would send the operator to fix a typo while the token stays in the file.
  const secret = findSecret(document);
  if (secret !== undefined) {
    throw new ConfigSecretError(
      `config file ${found.path} carries a credential at "${secret.keyPath}" (${secret.reason}). Config files are committable by construction, so secrets live in the environment or in the canonical credential store (ARCH-7) — never here.`,
      { keyPath: secret.keyPath, channel: "file" },
    );
  }

  if (!isJsonRecord(document)) {
    throw new ConfigError(
      `config file ${found.path} must hold a JSON object at the top level — got ${describeJson(document)}`,
    );
  }

  for (const key of Object.keys(document)) {
    const spec = findByKey(options, key);
    if (spec === undefined) {
      throw new ConfigError(
        `unknown key "${key}" in ${found.path} — valid keys: ${keyList(options)}`,
      );
    }
    if (!allowsSource(spec, "file")) {
      throw new ConfigError(
        `"${key}" may not be set in ${found.path} — allowed layers: ${(spec.sources ?? []).join(", ")}`,
      );
    }
  }

  return { path: found.path, values: document };
}

// ── precedence ──────────────────────────────────────────────────────────────

interface Picked {
  readonly value: OptionValue;
  readonly source: ConfigSource;
}

/**
 * Every layer is evaluated before one is chosen, so an invalid value fails even
 * when a higher layer would have hidden it (rule 3 in the file header).
 */
function pick(
  spec: OptionSpec,
  flags: ReadonlyMap<string, string[]>,
  env: Readonly<Record<string, string | undefined>>,
  file: LoadedFile,
): Picked | undefined {
  const rawFlag = flags.get(spec.key);
  const fromFlag =
    rawFlag === undefined ? undefined : coerceText(spec, rawFlag, spec.flag);

  const envHit = envLayer(spec, env);
  const fromEnv =
    envHit === undefined
      ? undefined
      : coerceText(spec, envHit.texts, envHit.origin);

  const rawFile = Object.prototype.hasOwnProperty.call(file.values, spec.key)
    ? file.values[spec.key]
    : undefined;
  const fromFile =
    rawFile === undefined
      ? undefined
      : coerceJson(
          spec,
          rawFile,
          `"${spec.key}" in ${file.path ?? "the config file"}`,
        );

  // Every layer, not only the winner (rule 3): a committed file with a
  // credentialed URL is a leak whether or not today's flag overrides it.
  refuseTopologyUserinfo(spec, fromFlag, spec.flag, "flag");
  refuseTopologyUserinfo(spec, fromEnv, envHit?.origin ?? "", "env");
  refuseTopologyUserinfo(
    spec,
    fromFile,
    `"${spec.key}" in ${file.path ?? "the config file"}`,
    "file",
  );

  if (fromFlag !== undefined) return { value: fromFlag, source: "flag" };
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  if (fromFile !== undefined) return { value: fromFile, source: "file" };
  if (spec.default !== undefined) {
    return { value: spec.default, source: "default" };
  }
  return undefined;
}

/** The §2a roles and the `--instance` alias that fans out onto them. */
const TOPOLOGY_KEYS: ReadonlySet<string> = new Set([
  ...TOPOLOGY_ROLE_KEYS,
  INSTANCE_ALIAS_KEY,
]);

/**
 * Delegated decision 2026-09-25 (fail closed): a topology value — an instance
 * name or URL — never carries a user, on ANY layer, env included. The value
 * flows into the startup log, the ARCH-29 conflict message and every URL the
 * transport builds; credentials belong in the canonical credential store
 * (ARCH-7). The message names the layer and the key, NEVER the value, so the
 * password cannot leak through the refusal itself.
 */
function refuseTopologyUserinfo(
  spec: OptionSpec,
  value: OptionValue | undefined,
  origin: string,
  channel: "flag" | "env" | "file",
): void {
  if (!TOPOLOGY_KEYS.has(spec.key) || typeof value !== "string") return;
  if (!hasUrlUserinfo(value)) return;
  throw new ConfigSecretError(
    `${origin} carries credentials in its URL (user@ or user:password@ userinfo) — the value is not shown. ${spec.flag} takes an instance name or a plain URL; credentials live in the environment or the canonical credential store (ARCH-7).`,
    { keyPath: spec.key, channel },
  );
}

// ── typing a value ──────────────────────────────────────────────────────────

/** Text from a flag or an environment variable. */
function coerceText(
  spec: OptionSpec,
  texts: readonly string[],
  origin: string,
): OptionValue {
  const text = texts.at(-1) ?? "";
  switch (spec.type) {
    case "boolean": {
      const word = text.trim().toLowerCase();
      if (TRUE_WORDS.has(word)) return true;
      if (FALSE_WORDS.has(word)) return false;
      throw new ConfigError(
        `${origin} expects a boolean — got "${text}"; valid: ${[...TRUE_WORDS, ...FALSE_WORDS].join(", ")}`,
      );
    }
    case "number": {
      const trimmed = text.trim();
      if (spec.integer === true) {
        // Delegated decision 2026-09-25: `Number()` accepts "0x10", "1e308"
        // and "1.5", each of which an operator typing a millisecond value did
        // not mean. Decimal digits only; anything else is refused.
        if (!/^\d+$/.test(trimmed)) {
          throw new ConfigError(
            `${origin} expects a number — got "${text}" (decimal digits only: no sign, decimal point, exponent or hex)`,
          );
        }
        return checkRange(spec, Number(trimmed), origin);
      }
      const value = Number(trimmed);
      if (trimmed === "" || !Number.isFinite(value)) {
        throw new ConfigError(`${origin} expects a number — got "${text}"`);
      }
      return checkRange(spec, value, origin);
    }
    case "list":
      return checkItems(
        spec,
        texts.flatMap((entry) => entry.split(",")),
        origin,
      );
    default:
      return checkChoice(spec, text, origin);
  }
}

/** A value that came out of the config file, already typed by JSON. */
function coerceJson(
  spec: OptionSpec,
  value: unknown,
  origin: string,
): OptionValue {
  switch (spec.type) {
    case "boolean":
      if (typeof value !== "boolean") {
        throw new ConfigError(
          `${origin} expects a JSON boolean — got ${describeJson(value)}`,
        );
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ConfigError(
          `${origin} expects a JSON number — got ${describeJson(value)}`,
        );
      }
      return checkRange(spec, value, origin);
    case "list": {
      if (!isJsonArray(value)) {
        throw new ConfigError(
          `${origin} expects an array of strings — got ${describeJson(value)}`,
        );
      }
      const items = value.map((item) => {
        if (typeof item !== "string") {
          throw new ConfigError(
            `${origin} expects an array of strings — one item is ${describeJson(item)}`,
          );
        }
        return item;
      });
      return checkItems(spec, items, origin);
    }
    default:
      if (typeof value !== "string") {
        throw new ConfigError(
          `${origin} expects a JSON string — got ${describeJson(value)}`,
        );
      }
      return checkChoice(spec, value, origin);
  }
}

function checkChoice(spec: OptionSpec, text: string, origin: string): string {
  const value = text.trim();
  if (value === "")
    throw new ConfigError(`${origin} expects a non-empty value`);
  if (spec.choices !== undefined && !spec.choices.includes(value)) {
    throw new ConfigError(
      `${origin} expects one of ${spec.choices.join(", ")} — got "${value}"`,
    );
  }
  return value;
}

/**
 * A repeated item is the same request twice, not two requests, so the list is
 * de-duplicated in first-seen order. Nothing is dropped that carried meaning.
 */
function checkItems(
  spec: OptionSpec,
  items: readonly string[],
  origin: string,
): readonly string[] {
  const seen: string[] = [];
  for (const item of items) {
    const value = checkChoice(spec, item, origin);
    if (!seen.includes(value)) seen.push(value);
  }
  if (seen.length === 0) {
    throw new ConfigError(`${origin} expects at least one value`);
  }
  return seen;
}

function checkRange(spec: OptionSpec, value: number, origin: string): number {
  if (spec.integer === true && !Number.isSafeInteger(value)) {
    throw new ConfigError(`${origin} expects a whole number — got ${value}`);
  }
  if (spec.min !== undefined && value < spec.min) {
    throw new ConfigError(
      `${origin} expects a number >= ${spec.min} — got ${value}`,
    );
  }
  if (spec.max !== undefined && value > spec.max) {
    throw new ConfigError(
      `${origin} expects a number <= ${spec.max} — got ${value}`,
    );
  }
  return value;
}

// ── the ARCH-29 alias ───────────────────────────────────────────────────────

/**
 * `--instance` is an alias, not a fourth role: it resolves to `source`,
 * `runner` and `target` EXPLICITLY, so everything downstream reads the three
 * §2a roles and never has to know the alias existed. `aliasedFrom` keeps the
 * fan-out visible in the startup log.
 *
 * A role that was set explicitly to a DIFFERENT value is a refusal, at any
 * layer — including a file `instance` against a `--runner` flag. Precedence
 * could pick a winner there, but not a meaning: it is genuinely unclear whether
 * `--runner` was meant to re-point one role or all three, and "silently picking
 * one" is what the phase forbids. Identical values are accepted; they say the
 * same thing twice and the role keeps its own provenance.
 */
function collapseInstanceAlias(
  options: readonly OptionSpec[],
  values: Record<string, OptionValue>,
  provenance: Record<string, ConfigSource>,
): Record<string, string> {
  const aliasedFrom: Record<string, string> = {};
  const alias = findByKey(options, INSTANCE_ALIAS_KEY);
  if (alias === undefined) return aliasedFrom;

  const aliasValue = values[INSTANCE_ALIAS_KEY];
  if (typeof aliasValue !== "string") return aliasedFrom;
  const aliasSource = provenance[INSTANCE_ALIAS_KEY] ?? "default";

  for (const role of TOPOLOGY_ROLE_KEYS) {
    const spec = findByKey(options, role);
    if (spec === undefined) continue;
    const own = values[role];
    const ownSource = provenance[role];

    if (
      own === undefined ||
      ownSource === undefined ||
      ownSource === "default"
    ) {
      values[role] = aliasValue;
      provenance[role] = aliasSource;
      aliasedFrom[role] = INSTANCE_ALIAS_KEY;
      continue;
    }
    if (own !== aliasValue) {
      throw new ConfigError(
        `${alias.flag}=${aliasValue} (from ${aliasSource}) conflicts with ${spec.flag}=${String(own)} (from ${ownSource}) — ${alias.flag} collapses all three §2a roles onto one instance, so either drop it or name the roles explicitly`,
      );
    }
  }
  return aliasedFrom;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
