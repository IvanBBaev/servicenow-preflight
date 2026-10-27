/**
 * `snpf config migrate` (F-X-7): move each shared `options` key into
 * `checks.<name>` for every check that declares it, so each check's options
 * live in one closed, validated place. A value already set under
 * `checks.<name>` wins (it already overrode the shared one); keys no check
 * declares stay in `options`. The run's behaviour is unchanged: a check sees
 * the same merged options before and after.
 */
import type { Check } from "../types.js";

/** What {@link migrateConfig} did. */
export interface Migration {
  /** The migrated config (the input is not modified). */
  config: Record<string, unknown>;
  /** `option -> [check, ...]` for every key that moved. */
  moved: Record<string, string[]>;
  changed: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Migrate a parsed config file to the per-check `checks` layout. */
export function migrateConfig(
  raw: Record<string, unknown>,
  checks: readonly Check[],
): Migration {
  const config = structuredClone(raw);
  const options = config.options;
  if (!isPlainObject(options)) return { config, moved: {}, changed: false };

  const owners = new Map<string, string[]>();
  for (const check of checks) {
    for (const key of Object.keys(check.optionsSchema?.shape ?? {})) {
      owners.set(key, [...(owners.get(key) ?? []), check.name]);
    }
  }

  const perCheck = isPlainObject(config.checks) ? config.checks : {};
  const moved: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(options)) {
    const names = owners.get(key);
    if (!names) continue;
    for (const name of names) {
      const own = isPlainObject(perCheck[name]) ? perCheck[name] : {};
      if (!Object.hasOwn(own, key)) own[key] = structuredClone(value);
      perCheck[name] = own;
    }
    delete options[key];
    moved[key] = names;
  }
  if (Object.keys(moved).length === 0) {
    return { config, moved, changed: false };
  }
  config.checks = perCheck;
  if (Object.keys(options).length === 0) delete config.options;
  return { config, moved, changed: true };
}

type Op = { kind: " " | "-" | "+"; line: string };

/** Line-level LCS diff of two texts. */
function diffLines(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: " ", line: before[i++]! });
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "-", line: before[i++]! });
    } else {
      ops.push({ kind: "+", line: after[j++]! });
    }
  }
  while (i < n) ops.push({ kind: "-", line: before[i++]! });
  while (j < m) ops.push({ kind: "+", line: after[j++]! });
  return ops;
}

/**
 * A unified diff (`---`/`+++` headers, one `@@` hunk per change with three
 * lines of context) between two JSON renderings.
 */
export function unifiedDiff(
  label: string,
  before: string,
  after: string,
): string {
  const ops = diffLines(before.split("\n"), after.split("\n"));
  const context = 3;
  const keep = ops.map(() => false);
  ops.forEach((op, k) => {
    if (op.kind === " ") return;
    for (
      let c = Math.max(0, k - context);
      c <= Math.min(ops.length - 1, k + context);
      c++
    ) {
      keep[c] = true;
    }
  });
  const out = [`--- ${label}`, `+++ ${label} (migrated)`];
  let oldLine = 1;
  let newLine = 1;
  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) {
      if (ops[k]!.kind !== "+") oldLine++;
      if (ops[k]!.kind !== "-") newLine++;
      k++;
      continue;
    }
    const start = k;
    while (k < ops.length && keep[k]) k++;
    const hunk = ops.slice(start, k);
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.line}`);
    oldLine += oldCount;
    newLine += newCount;
  }
  return `${out.join("\n")}\n`;
}
