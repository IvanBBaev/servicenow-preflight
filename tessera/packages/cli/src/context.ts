// Everything the CLI reads from the outside world, in one injectable place.
//
// THE PROCESS BOUNDARY of the whole workspace lives in this package: no other
// module anywhere reads `argv`, reads `process.env` or calls the wall clock.
// `defaultContext()` is the only function that samples the real process, and
// `stage.ts` is the only module that WRITES `process.env` (the vendored
// transport insists on it — ARCH-7/18).

export interface CliContext {
  readonly now: () => Date;
  /** Default `--actor` — who is passing an override (§11.4). */
  readonly actor: string;
  /** `$SN_INSTANCE`, the default instance when no role flag is given. */
  readonly instance?: string;
  readonly cwd: string;
  /**
   * The environment `@tessera/config` resolves its `env` layer from. Injected
   * rather than read inside the resolver so a test can pin precedence without
   * mutating the real process.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** Render an unknown throwable without ever producing "[object Object]". */
export function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "an unprintable value";
}

/**
 * The `instance` member of a `CliContext`, read from `$SN_INSTANCE` in `env`:
 * trimmed, and absent (never `""`) when unset or blank. Shared by
 * `defaultContext()` and by any front-end that builds its own context — the MCP
 * server does — so the default instance cannot mean one thing to `tess` and
 * another to a tool call over the same environment.
 */
export function instanceFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): { readonly instance?: string } {
  const instance = env["SN_INSTANCE"]?.trim();
  return instance === undefined || instance === "" ? {} : { instance };
}

export function defaultContext(): CliContext {
  return {
    now: () => new Date(),
    actor:
      process.env["USER"]?.trim() ?? process.env["USERNAME"]?.trim() ?? "cli",
    ...instanceFromEnv(process.env),
    cwd: process.cwd(),
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}
