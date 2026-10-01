// The subcommand split, and nothing else.
//
// One tiny layer with one job: decide WHICH command runs, and hand it the rest
// of argv untouched. It exists because the commands do not share a parser —
// `preflight`, `resolve`, `impact` and `doctor` resolve their flags through
// `@tessera/config`'s four-layer table (each against its own option table),
// while `run --skeleton` keeps the frozen Phase-0.5 hand-rolled parser (its
// flags are dev-harness switches that were deliberately never given env or
// config-file layers), and `status` / `confirm` / `cleanup` take a small argv
// parser of their own (they are addressed by run id). Splitting first keeps that difference from leaking into
// a single mega-parser that has to know about all of it.

/** Every command `tess` answers to. Order is the order `--help` prints. */
export const COMMANDS = [
  "preflight",
  "resolve",
  "impact",
  "coverage",
  "generate",
  "doctor",
  "run",
  "status",
  "confirm",
  "cleanup",
  "benchmark",
] as const;

export type CommandName = (typeof COMMANDS)[number];

export type ArgvSplit =
  /** Top-level help, or `tess <command> --help`. */
  | { readonly kind: "help"; readonly command?: CommandName }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "command";
      readonly name: CommandName;
      readonly rest: readonly string[];
    };

function isCommand(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

/**
 * Value flags whose value is validated up front, before the command reads,
 * composes or contacts anything — so a `--help` in their value position can be
 * handed to the command as that value and is refused there as a usage error.
 *
 * Delegated decision 2026-09-25: `--help` / `-h` is help only in a FLAG
 * position. It is NOT help when it is the value of the immediately preceding
 * flag — but only for the flags listed here. There is no generic way to know in
 * this layer which flags take a value (each command owns its own parser), and
 * the two ways of guessing wrong are not symmetric: reading a real help request
 * as a value would RUN the command with its side effects, while reading a value
 * as help only prints help. So the default stays "help wins" (fail-closed), and
 * a flag is listed only when a value of `--help` is guaranteed to be refused
 * before anything happens: `--run-id` (the ledger's `validateRunId`),
 * `--since` (a non-negative integer) and cleanup's `--mode` (plan|apply). This
 * is what an MCP call such as `{"runId":"--help"}` produces
 * (`status --json --run-id --help`), and it now ends as an invalid-run-id usage
 * error instead of help text read back as an internal fault. The MCP server
 * also refuses any string argument starting with "-" before building argv.
 */
const VALIDATED_VALUE_FLAGS: Partial<Record<CommandName, ReadonlySet<string>>> =
  {
    status: new Set(["--run-id", "--since"]),
    confirm: new Set(["--run-id"]),
    cleanup: new Set(["--run-id", "--mode"]),
  };

function asksForHelp(command: CommandName, argv: readonly string[]): boolean {
  const valueFlags = VALIDATED_VALUE_FLAGS[command];
  return argv.some((token, index) => {
    if (token !== "--help" && token !== "-h") return false;
    const previous = index === 0 ? undefined : argv[index - 1];
    return previous === undefined || valueFlags?.has(previous) !== true;
  });
}

export function splitArgv(argv: readonly string[]): ArgvSplit {
  const [head, ...rest] = argv;
  if (
    head === undefined ||
    head === "help" ||
    head === "--help" ||
    head === "-h"
  ) {
    return { kind: "help" };
  }

  if (!isCommand(head)) {
    // A leading flag is almost always a forgotten command rather than a typo in
    // the flag, so the message names the commands instead of the flag.
    return {
      kind: "error",
      message: head.startsWith("-")
        ? `expected a command before ${JSON.stringify(head)} — one of: ${COMMANDS.join(", ")}`
        : `unknown command ${JSON.stringify(head)} — expected one of: ${COMMANDS.join(", ")}`,
    };
  }

  // `--help` in a flag position anywhere in a command's own argv wins over
  // running it: a caller who asked for help never wanted the side effects of
  // the run (see `VALIDATED_VALUE_FLAGS` for the one narrow exception).
  if (asksForHelp(head, rest)) return { kind: "help", command: head };

  return { kind: "command", name: head, rest };
}
