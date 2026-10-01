// The result key (DESIGN §13.4 "How mutants are versioned"): a benchmark
// result is valid ONLY for its `{platformVersion, mutantSetHash, genConfig}`
// triple. Change any element and the prior result is invalid — never adjusted.
// There is deliberately no function here that maps an old result onto a new
// key; `compareResultKey` can only say "same" or "invalid, because".

import { canonicalJson, sha256Hex } from "@tessera/core";

/**
 * DESIGN §13.1 `PinnedGenConfig`. Structurally identical to the interface of
 * the same name in `@tessera/generate`, which is declared there and not
 * imported here because `@tessera/benchmark` builds BEFORE `@tessera/generate`
 * (root `build:all`) and needs nothing else from it; a generator's config is
 * assignable to this one as-is.
 */
export interface PinnedGenConfig {
  readonly modelId: string;
  readonly temperature: number;
  readonly maxTokens: number;
  /** sha256 of the frozen generation prompt(s). */
  readonly promptHash: string;
  readonly promptVersion: string;
}

export interface ResultKey {
  /** The instance's platform stamp, read at run start (drift, §13.4). */
  readonly platformVersion: string;
  readonly mutantSetHash: string;
  readonly genConfig: PinnedGenConfig;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Every reason `config` does not count as PINNED, or `[]`. An alias or a
 * floating "latest" model id is not a pin: the same string can name a
 * different model tomorrow, which is exactly the silent update SUB-4 says
 * must invalidate a result rather than be absorbed by it.
 */
export function pinnedGenConfigProblems(config: unknown): string[] {
  if (config === null || typeof config !== "object") {
    return ["genConfig is not an object"];
  }
  const c = config as Record<string, unknown>;
  const problems: string[] = [];
  const modelId = c["modelId"];
  if (typeof modelId !== "string" || modelId.trim() === "") {
    problems.push("modelId must be a non-empty string");
  } else if (/\s/.test(modelId) || /latest/i.test(modelId)) {
    problems.push(
      `modelId ${JSON.stringify(modelId)} is not an exact versioned id (whitespace or "latest")`,
    );
  }
  if (
    typeof c["temperature"] !== "number" ||
    !Number.isFinite(c["temperature"])
  ) {
    problems.push("temperature must be a finite number");
  }
  const maxTokens = c["maxTokens"];
  if (
    typeof maxTokens !== "number" ||
    !Number.isInteger(maxTokens) ||
    maxTokens <= 0
  ) {
    problems.push("maxTokens must be a positive integer");
  }
  const promptHash = c["promptHash"];
  if (typeof promptHash !== "string" || !SHA256_HEX.test(promptHash)) {
    problems.push("promptHash must be a lowercase sha256 hex digest");
  }
  const promptVersion = c["promptVersion"];
  if (typeof promptVersion !== "string" || promptVersion.trim() === "") {
    problems.push("promptVersion must be a non-empty string");
  }
  return problems;
}

/** A stable digest of the whole key, for logs and file names. */
export function resultKeyHash(key: ResultKey): string {
  return sha256Hex(
    canonicalJson({
      platformVersion: key.platformVersion,
      mutantSetHash: key.mutantSetHash,
      genConfig: {
        modelId: key.genConfig.modelId,
        temperature: key.genConfig.temperature,
        maxTokens: key.genConfig.maxTokens,
        promptHash: key.genConfig.promptHash,
        promptVersion: key.genConfig.promptVersion,
      },
    }),
  );
}

export type ResultKeyField =
  | "platformVersion"
  | "mutantSetHash"
  | "genConfig.modelId"
  | "genConfig.temperature"
  | "genConfig.maxTokens"
  | "genConfig.promptHash"
  | "genConfig.promptVersion";

export type ResultKeyComparison =
  | { readonly valid: true }
  | { readonly valid: false; readonly mismatched: readonly ResultKeyField[] };

/**
 * Is a PRIOR result still valid for the CURRENT key? Only on an exact match of
 * every element. There is no tolerance and no "compatible" model family.
 */
export function compareResultKey(
  prior: ResultKey,
  current: ResultKey,
): ResultKeyComparison {
  const mismatched: ResultKeyField[] = [];
  if (prior.platformVersion !== current.platformVersion) {
    mismatched.push("platformVersion");
  }
  if (prior.mutantSetHash !== current.mutantSetHash) {
    mismatched.push("mutantSetHash");
  }
  const fields = [
    "modelId",
    "temperature",
    "maxTokens",
    "promptHash",
    "promptVersion",
  ] as const;
  for (const field of fields) {
    if (!Object.is(prior.genConfig[field], current.genConfig[field])) {
      mismatched.push(`genConfig.${field}`);
    }
  }
  return mismatched.length === 0
    ? { valid: true }
    : { valid: false, mismatched };
}

export class StaleResultError extends Error {
  override readonly name = "StaleResultError";
  constructor(readonly mismatched: readonly ResultKeyField[]) {
    super(
      `prior benchmark result is INVALID for the current key (${mismatched.join(", ")} changed) — it is re-run on a fresh substrate, never adjusted (DESIGN §13.4)`,
    );
  }
}

/** Throw `StaleResultError` unless `prior` matches `current` exactly. */
export function assertResultKeyMatches(
  prior: ResultKey,
  current: ResultKey,
): void {
  const comparison = compareResultKey(prior, current);
  if (!comparison.valid) throw new StaleResultError(comparison.mismatched);
}
