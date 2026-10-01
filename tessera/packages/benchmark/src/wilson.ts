// Wilson score interval (DESIGN §13.1 "Decision rule — on the interval bound,
// not the point estimate"). Pure arithmetic: no I/O, no clock, no randomness.
//
// The gate decides on the bound that FACES the risk — the kill rate on its
// lower bound, the false-green rate on its upper bound — so a lucky small-N
// point estimate cannot pass. Everything here exists to make that bound exact
// and reproducible from `(successes, trials, confidence)` alone.

/**
 * Inverse standard-normal CDF (Acklam's rational approximation, relative error
 * below 1.2e-9 over the whole open interval). Used only to turn a two-sided
 * confidence level into its z, so the design's "z = 1.96 at 0.95" is derived
 * rather than transcribed and a different frozen confidence cannot silently
 * keep the old z.
 */
function inverseNormalCdf(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ] as const;
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ] as const;
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ] as const;
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ] as const;
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - low) {
    return -inverseNormalCdf(1 - p);
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
      q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/**
 * The two-sided z for a confidence level: 0.95 → 1.95996…. Throws on anything
 * outside the open interval (0, 1) — a confidence of 1 has no finite z, and a
 * non-number must not reach the gate as NaN.
 */
export function zForConfidence(confidence: number): number {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new RangeError(
      `confidence must be a number strictly between 0 and 1, got ${String(confidence)}`,
    );
  }
  return inverseNormalCdf(1 - (1 - confidence) / 2);
}

export interface WilsonInterval {
  readonly successes: number;
  readonly trials: number;
  readonly confidence: number;
  readonly z: number;
  /** successes / trials; recorded, never decided on. */
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
}

/**
 * The Wilson score interval for `successes` out of `trials`.
 *
 * `trials === 0` has no estimate at all and yields the uninformative [0, 1]
 * with a NaN point — so a gate reading the lower bound fails and a gate
 * reading the upper bound fails, whichever side the risk is on.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  confidence: number,
): WilsonInterval {
  if (!Number.isInteger(trials) || trials < 0) {
    throw new RangeError(
      `trials must be a non-negative integer, got ${String(trials)}`,
    );
  }
  if (!Number.isInteger(successes) || successes < 0 || successes > trials) {
    throw new RangeError(
      `successes must be an integer in [0, ${trials}], got ${String(successes)}`,
    );
  }
  const z = zForConfidence(confidence);
  if (trials === 0) {
    return {
      successes,
      trials,
      confidence,
      z,
      point: Number.NaN,
      lower: 0,
      upper: 1,
    };
  }
  const n = trials;
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half =
    (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    successes,
    trials,
    confidence,
    z,
    point: p,
    // At p = 0 (p = 1) the lower (upper) bound is exactly 0 (1); the closed
    // form only lands there up to a rounding error, so those corners are set
    // exactly and everything else is clamped into [0, 1].
    lower: successes === 0 ? 0 : Math.max(0, centre - half),
    upper: successes === n ? 1 : Math.min(1, centre + half),
  };
}

/**
 * The smallest M at which a CLEAN false-green run (0 of M) can clear an upper
 * bound of `threshold`: M >= ceil(z^2 (1 - t) / t) (DESIGN §13.1). 35 at
 * t = 0.10 and 95%. A threshold change recomputes M by this same formula —
 * which is why the policy check calls it instead of trusting a constant.
 */
export function minTrialsForZeroEventUpperBound(
  threshold: number,
  confidence: number,
): number {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
    throw new RangeError(
      `threshold must be strictly between 0 and 1, got ${String(threshold)}`,
    );
  }
  const z = zForConfidence(confidence);
  return Math.ceil((z * z * (1 - threshold)) / threshold);
}
