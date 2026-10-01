// Generic path / filesystem helpers for the artifact directory.
//
// Written for this package from a behavioural specification, not copied. Until
// 2026-09-23 `artifacts.ts` imported these five helpers from `@tessera/store`,
// the vendored syncrona (GPL-3.0) package; that one import was the only edge
// from the shipped closure into the GPL surface (delegated decision 2026-09-23,
// TODO "~98% of the vendored GPL surface is dead weight"). None of them carries
// any ServiceNow semantics, so they are reimplemented here and `@tessera/store`
// is no longer a dependency of `@tessera/reporter`.
//
// The contract each helper keeps is the one `artifacts.ts` was written
// against, including the parts a tidy rewrite would lose — stated per helper
// below and pinned by `test/pathkit.test.js`.

import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";

/**
 * INJ-1: is `component` usable as exactly ONE path segment? A non-empty
 * string, not made solely of dots (`.`, `..`, `...`), containing neither
 * separator — `\` is refused on every platform, not only on Windows, because
 * the value may come from the instance and the rule must not depend on the
 * host OS.
 */
export function isSafePathComponent(component: string): boolean {
  if (typeof component !== "string" || component === "") return false;
  if (/^\.+$/.test(component)) return false;
  return !component.includes("/") && !component.includes("\\");
}

/** Segments of `p`, split on EITHER separator, with empty segments dropped. */
function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/**
 * Is `child` at or below `parent`? Containment is decided SEGMENT BY SEGMENT,
 * never by string prefix, so `/a/bc` is not under `/a/b`.
 *
 * Deliberate properties (#19 cross-platform separators), all load-bearing:
 * - `/` and `\` are interchangeable, so a mixed-separator path compares
 *   correctly on Windows, where Node emits `\` and git/globs/config emit `/`;
 * - trailing and doubled separators are ignored;
 * - `.` and `..` are NOT normalised — callers `path.resolve` first, which is
 *   what makes an escape visible to this check;
 * - comparison is case-sensitive;
 * - a path is under itself (callers exclude equality themselves), and an empty
 *   `parent` contains everything.
 */
export function isUnderPath(parent: string, child: string): boolean {
  const parentSegments = segments(parent);
  const childSegments = segments(child);
  if (childSegments.length < parentSegments.length) return false;
  for (let i = 0; i < parentSegments.length; i += 1) {
    if (parentSegments[i] !== childSegments[i]) return false;
  }
  return true;
}

/**
 * Does anything exist at `target`? EVERY error reads as `false` — including an
 * `EACCES` on a parent directory. That is intentional for its one caller
 * (`put`), which then attempts the `mkdir` and surfaces the real error there.
 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** `mkdir -p`: creates every missing level; an existing directory is not an error. */
export async function createDirRecursively(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
}

/** Retry policy for {@link withRetry}. */
export interface RetryOptions {
  /** Total attempts, including the first. Default 3; values below 1 mean 1. */
  attempts?: number;
  /** Constant pause between attempts, in ms (not exponential). Default 50. */
  delayMs?: number;
}

/**
 * Run `task` until it resolves, up to `attempts` times, pausing `delayMs`
 * between attempts — never after the last one. When every attempt fails, the
 * LAST error is rethrown unchanged; earlier ones are discarded.
 */
export async function withRetry<T>(
  task: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const delayMs = options.delayMs ?? 50;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}
