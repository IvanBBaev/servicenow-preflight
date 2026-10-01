/**
 * A wiring bug, not an instance condition. Thrown only from
 * `createEnvironmentDoctor` — once a doctor exists, `diagnose` reports
 * failures as `unknown` findings instead of throwing.
 */
export class DoctorContractError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DoctorContractError";
  }
}
