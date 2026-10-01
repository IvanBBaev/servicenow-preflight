// Configuration vocabulary (PLAN Phase 1 §Configuration).
//
// The package has exactly ONE extension point: the option table. Flag parsing,
// environment lookup, config-file mapping, help text and redaction are all
// derived from it, so an option added in a later phase is a new row of data,
// never new code. That is the whole reason the descriptor carries `flag`,
// `env`, `type` and `secret` together instead of those facts living in four
// separate switch statements that drift apart.
//
// Pure data; nothing in this file performs I/O.

/**
 * `list` is a repeated or comma-separated string set (`--kind unit --kind e2e`).
 * There is no `object` type on purpose: a nested config section would need a
 * second mapping rule, and Phase 1 has nothing that needs one.
 */
export type OptionType = "string" | "number" | "boolean" | "list";

/**
 * Which layer produced a value, in precedence order. Exactly four.
 *
 * The ARCH-29 `--instance` alias is deliberately NOT a fifth source: it is not
 * another place a value can come from, it is one value fanned out onto three
 * topology roles, and it stays a `flag`/`env`/`file` value the whole time.
 * `ResolvedConfig.aliasedFrom` records the fan-out separately so the startup
 * log can show both facts without overloading either.
 */
export const CONFIG_SOURCES = ["flag", "env", "file", "default"] as const;
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

export type OptionValue = string | number | boolean | readonly string[];

export type ConfigValues = Readonly<Record<string, OptionValue | undefined>>;

export interface OptionSpec {
  /** Identity in `values`/`provenance`. Need not match the flag (`--kind` → `kinds`). */
  readonly key: string;
  /** Long flag, with dashes: `--update-set`. Short flags are not supported. */
  readonly flag: string;
  /** Tessera's own namespace: `TESSERA_*`. Omit to keep the option off the env layer. */
  readonly env?: string;
  /**
   * A second, pre-existing env name for an option that is a pass-through to the
   * vendored transport (DEV-15's docs dir → `SN_DOCS_DIR`). `env` always wins:
   * `SN_*` belongs to the transport and Tessera reads it only as a fallback, so
   * an operator who sets the Tessera name gets the Tessera name.
   */
  readonly legacyEnv?: string;
  readonly type: OptionType;
  /** `list` only — the flag may appear more than once and the values accumulate. */
  readonly repeatable?: boolean;
  /**
   * This option carries a credential. Implies `sources: ["env"]` (asserted at
   * resolve time) and renders as `<redacted>` in every human output.
   */
  readonly secret?: boolean;
  /**
   * INPUT layers allowed to supply this option, defaulting to all four. Only
   * `flag`, `env` and `file` are enforced: a value arriving through a layer
   * this list omits is a named error. `default` is not an input layer, so a
   * declared `default` still applies to an option whose sources omit it.
   *
   * `["env"]` is the only sanctioned channel for a secret — a config file is
   * committable and a command line is readable through `ps(1)`.
   */
  readonly sources?: readonly ConfigSource[];
  /** Closed value set; validated on every layer, including the config file. */
  readonly choices?: readonly string[];
  /** `number` only — inclusive lower bound. */
  readonly min?: number;
  /**
   * `number` only — inclusive upper bound. Delegated decision 2026-09-25: a
   * millisecond option feeds `setTimeout`, which silently clamps anything
   * above 2147483647 to 1 ms — so a deadline of "3e9" became an immediate
   * timeout. Such options declare `max: MAX_TIMER_MS`.
   */
  readonly max?: number;
  /**
   * `number` only — the value must be a safe integer, and text (flag/env) must
   * be plain decimal digits: hex (`0x10`), exponent (`1e3`), sign and decimal
   * point are refused rather than reinterpreted (delegated decision
   * 2026-09-25, fail closed).
   */
  readonly integer?: boolean;
  /** Absent means the option has no value unless somebody supplies one. */
  readonly default?: OptionValue;
  /** One line of help; the `--help` text is generated from these. */
  readonly describe: string;
}

/** The TypeScript type a descriptor's resolved value has. */
type ValueTypeOf<S extends OptionSpec> = S["type"] extends "string"
  ? string
  : S["type"] extends "number"
    ? number
    : S["type"] extends "boolean"
      ? boolean
      : readonly string[];

/**
 * The `values` shape a given table produces. Derived from the table so the
 * option set has exactly one definition — a hand-written mirror interface would
 * be the second config system PLAN Phase 1 explicitly refuses.
 *
 * Every field is optional: an option with no default and nothing supplied is
 * absent from `values`, which is what makes `provenance` total over the keys
 * that are actually there.
 */
export type ValuesOf<T extends readonly OptionSpec[]> = {
  readonly [S in T[number] as S["key"]]?: ValueTypeOf<S>;
};

export interface ResolvedConfig<T extends ConfigValues = ConfigValues> {
  readonly values: T;
  /**
   * Which layer produced each present value. Keyed by option key; an option
   * absent from `values` is absent here too. This is what makes the redacted
   * startup log worth printing — "runner = https://… (from file)" answers the
   * question an operator actually has when a run targets the wrong instance.
   */
  readonly provenance: Readonly<Record<string, ConfigSource>>;
  /**
   * Role key → the alias option that produced it (ARCH-29 `--instance`). Empty
   * when nothing was collapsed. Kept apart from `provenance`, which still
   * reports the layer the alias itself came from.
   */
  readonly aliasedFrom: Readonly<Record<string, string>>;
  /** Absolute path of the config file that took part, if one did. */
  readonly configFile?: string;
  /** The table this result was resolved against — what redaction keys on. */
  readonly options: readonly OptionSpec[];
}
