/**
 * A wiring bug, not an instance condition. Thrown only for a request this
 * stage cannot honestly answer at all — a blank profile name would leave both
 * sides reading the same ambient credentials and manufacture a `match` out of
 * one instance. Every condition an instance can actually be in is reported as
 * a row instead.
 */
export class ParityContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ParityContractError";
  }
}
