/**
 * RFC 6238 time-based one-time passwords (F-X-11), for basic-auth accounts
 * that must present an MFA code. Pure apart from `node:crypto`'s HMAC: the
 * clock is passed in, so callers and tests control the time step. Nothing here
 * ever puts a seed or a code into an error message.
 */
import { createHmac } from "node:crypto";

/** HMAC algorithms RFC 6238 defines. ServiceNow's authenticator uses SHA-1. */
export type TotpAlgorithm = "sha1" | "sha256" | "sha512";

export interface TotpOptions {
  /** Code length, 6..8 (default 6). */
  digits?: number;
  /** Time step in seconds, 1..300 (default 30). */
  period?: number;
  /** HMAC algorithm (default `sha1`). */
  algorithm?: TotpAlgorithm;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Why `options` are invalid, or `undefined` when they are usable. */
export function totpOptionsProblem(options: TotpOptions): string | undefined {
  const { digits, period } = options;
  if (
    digits !== undefined &&
    (!Number.isInteger(digits) || digits < 6 || digits > 8)
  ) {
    return "digits must be an integer from 6 to 8";
  }
  if (
    period !== undefined &&
    (!Number.isInteger(period) || period < 1 || period > 300)
  ) {
    return "period must be an integer number of seconds from 1 to 300";
  }
  return undefined;
}

/**
 * Decode an RFC 4648 base32 seed, the form authenticator apps show. Case,
 * spaces, dashes and `=` padding are ignored. Throws on any other character or
 * an empty seed; the message never repeats the input.
 */
export function decodeBase32(seed: string): Buffer {
  const clean = seed.replace(/[\s=-]/g, "").toUpperCase();
  if (!clean) throw new Error("The TOTP secret is empty.");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) {
      throw new Error("The TOTP secret is not valid base32 (A-Z, 2-7).");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** The RFC 4226 HOTP value for `counter`, zero-padded to `digits`. */
export function hotp(
  key: Buffer,
  counter: number,
  digits = 6,
  algorithm: TotpAlgorithm = "sha1",
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The time step (window index) `timeMs` falls in. */
export function totpWindow(timeMs: number, period = 30): number {
  return Math.floor(timeMs / 1000 / period);
}

/** The RFC 6238 code for time step `window`. */
export function totpForWindow(
  key: Buffer,
  window: number,
  options: TotpOptions = {},
): string {
  return hotp(key, window, options.digits ?? 6, options.algorithm ?? "sha1");
}

/** The RFC 6238 code valid at `timeMs`. */
export function totp(
  key: Buffer,
  timeMs: number,
  options: TotpOptions = {},
): string {
  return totpForWindow(key, totpWindow(timeMs, options.period ?? 30), options);
}
