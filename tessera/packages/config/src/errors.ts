/**
 * Configuration input this package refuses: an unknown flag, an unknown config
 * file key, a stray positional, a missing flag value, a value outside a closed
 * set, a `--instance` that contradicts an explicit role.
 *
 * Every one of these is thrown rather than dropped. A silently ignored
 * `--scpoe` is the failure mode this repository has already shipped once (the
 * `commandSync` extra-positional drop) — the operator gets a green run against
 * the wrong artifacts and no way to tell.
 */
export class ConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigError";
  }
}

/**
 * A credential was supplied through a channel that leaks it — a config file
 * (committable by construction) or argv (readable through `ps(1)`).
 *
 * Subclasses `ConfigError` so a caller can catch every configuration refusal in
 * one place, while this one stays separately catchable: it is the refusal an
 * operator must never "fix" by loosening the check.
 *
 * Carries `keyPath` because the first question is always WHICH key, and a
 * config file can bury it several levels down.
 */
export class ConfigSecretError extends ConfigError {
  readonly keyPath: string;
  /**
   * `env` is only ever reported for a value that no channel may carry — a
   * topology key with URL userinfo (delegated decision 2026-09-25).
   */
  readonly channel: "file" | "flag" | "env";

  constructor(
    message: string,
    detail: { keyPath: string; channel: "file" | "flag" | "env" },
  ) {
    super(message);
    this.name = "ConfigSecretError";
    this.keyPath = detail.keyPath;
    this.channel = detail.channel;
  }
}
