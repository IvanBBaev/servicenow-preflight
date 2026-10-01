// The benchmark catalog (DESIGN §13.4 "What the benchmark app must contain",
// "Who seeds the mutants", "How mutants are versioned").
//
// This module LOADS and REFUSES; it never authors. The mutants are the ground
// truth the generator is measured against, hand-authored by the human QA
// owner — an LLM-authored set would make the benchmark circular. So there is
// no default catalog, no catalog path baked in anywhere, and no generator of
// entries: `loadCatalog` takes exactly what the caller hands it.
//
// Refusal is all-or-nothing and lists every problem at once: a catalog with a
// missing sign-off, overlapping populations or thin composition is not
// "mostly usable", it is a benchmark whose score would mean something other
// than what §13.1 says.

import { readFile } from "node:fs/promises";

import { canonicalJson, sha256Hex } from "@tessera/core";
import type { TargetArtifactRef } from "@tessera/types";

import { MUTANT_CATEGORIES, isMutantCategory } from "./gate.js";
import type { MutantCategory, OutcomeGatePolicy } from "./gate.js";

/** Bumped when the hashed preimage changes shape, so old hashes never collide. */
export const CATALOG_SCHEMA = "tessera-benchmark-catalog/1";

/** A human reviewer's sign-off on one fault injection (§13.4). */
export interface SignOff {
  /** Who reviewed it — a person, never a tool. */
  readonly by: string;
  /** ISO-8601 date or timestamp of the review. */
  readonly at: string;
}

/** One seeded mutant: a single, reviewed fault injection. */
export interface MutantEntry {
  readonly id: string;
  readonly category: MutantCategory;
  readonly baseArtifact: TargetArtifactRef;
  /** Which behaviour of the artifact the fault targets (artifact×behaviour). */
  readonly behaviour: string;
  /** The fault, in whatever form the substrate's applier understands. */
  readonly diff: string;
  /** A mutant exists to be caught: the only verdict it may expect is red. */
  readonly expectedVerdict: "red";
  readonly signOff: SignOff;
  /**
   * Optional sha256 of the artifact's CORRECT source. When present, the live
   * substrate refuses to capture a live text whose hash differs (F4).
   */
  readonly correctSha256?: string;
}

/** The per-target liveness control (§13.1): a trivially broken twin. */
export interface DetonatorEntry {
  readonly diff: string;
  readonly signOff: SignOff;
}

/** One correct-code target for the false-green denominator. */
export interface BaselineEntry {
  readonly id: string;
  readonly category?: MutantCategory;
  readonly artifact: TargetArtifactRef;
  readonly behaviour: string;
  readonly detonator: DetonatorEntry;
  readonly signOff: SignOff;
  /** Optional sha256 of the artifact's CORRECT source (see `MutantEntry`). */
  readonly correctSha256?: string;
}

export interface CatalogMutant extends MutantEntry {
  /** Content address: sha256 of `diff`. */
  readonly diffSha256: string;
}

export interface CatalogBaseline extends BaselineEntry {
  readonly detonatorSha256: string;
}

export interface BenchmarkCatalog {
  readonly catalogVersion: string;
  /**
   * True for a test fixture. A fixture catalog can be scored, but a finding
   * built from it is forced to `open` (see `./finding.ts`), so no fixture can
   * ever be read as the S5 result.
   */
  readonly fixture: boolean;
  readonly mutants: readonly CatalogMutant[];
  readonly baselines: readonly CatalogBaseline[];
  /** sha256 over the canonical content of the whole set (§13.4 mutant-set version). */
  readonly mutantSetHash: string;
}

export class CatalogError extends Error {
  override readonly name = "CatalogError";
  constructor(readonly problems: readonly string[]) {
    super(
      `benchmark catalog refused (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.join("; ")}`,
    );
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function checkSignOff(
  value: unknown,
  where: string,
  problems: string[],
): SignOff | undefined {
  if (!isRecord(value)) {
    problems.push(`${where}: missing human sign-off`);
    return undefined;
  }
  const by = value["by"];
  const at = value["at"];
  let ok = true;
  if (!nonEmptyString(by)) {
    problems.push(`${where}: sign-off has no reviewer ("by")`);
    ok = false;
  }
  if (
    typeof at !== "string" ||
    !ISO_DATE.test(at) ||
    Number.isNaN(Date.parse(at))
  ) {
    problems.push(`${where}: sign-off "at" is not an ISO-8601 date`);
    ok = false;
  }
  return ok ? { by: by as string, at: at as string } : undefined;
}

function checkArtifact(
  value: unknown,
  where: string,
  problems: string[],
): TargetArtifactRef | undefined {
  if (
    isRecord(value) &&
    nonEmptyString(value["table"]) &&
    nonEmptyString(value["sysId"]) &&
    nonEmptyString(value["name"])
  ) {
    return {
      table: value["table"],
      sysId: value["sysId"],
      name: value["name"],
    };
  }
  problems.push(
    `${where}: artifact must be { table, sysId, name } of non-empty strings`,
  );
  return undefined;
}

/** Verify an optional author-recorded hash; a mismatch is a silent edit. */
function contentAddress(
  diff: string,
  recorded: unknown,
  where: string,
  problems: string[],
): string {
  const hash = sha256Hex(diff);
  if (recorded !== undefined && recorded !== hash) {
    problems.push(
      typeof recorded === "string" && SHA256_HEX.test(recorded)
        ? `${where}: diff does not match its recorded sha256 — the fault was edited after sign-off`
        : `${where}: recorded diffSha256 is not a sha256 hex digest`,
    );
  }
  return hash;
}

/**
 * Validate an optional `correctSha256` and check it agrees with every other
 * entry on the same artifact. Delegated decision 2026-09-26: two entries that
 * pin DIFFERENT correct sources for one artifact cannot both be right, so the
 * catalog is refused rather than one pin silently winning at capture.
 */
function checkCorrectSha256(
  recorded: unknown,
  artifact: TargetArtifactRef,
  at: string,
  seen: Map<string, { hash: string; at: string }>,
  problems: string[],
): string | undefined {
  if (recorded === undefined) return undefined;
  if (typeof recorded !== "string" || !SHA256_HEX.test(recorded)) {
    problems.push(`${at}: correctSha256 is not a sha256 hex digest`);
    return undefined;
  }
  const key = `${artifact.table}\u0000${artifact.sysId}`;
  const prior = seen.get(key);
  if (prior !== undefined && prior.hash !== recorded) {
    problems.push(
      `${at}: conflicting correctSha256 for ${artifact.table}/${artifact.sysId} (${prior.at} pins a different correct source)`,
    );
  }
  if (prior === undefined) seen.set(key, { hash: recorded, at });
  return recorded;
}

/** artifact×behaviour — the §13.4 unit a target is. */
function targetKey(artifact: TargetArtifactRef, behaviour: string): string {
  return `${artifact.table}\u0000${artifact.sysId}\u0000${behaviour}`;
}

/** The §13.4 mutant-set version over everything a score depends on. */
export function computeMutantSetHash(
  catalog: Pick<
    BenchmarkCatalog,
    "catalogVersion" | "fixture" | "mutants" | "baselines"
  >,
): string {
  // Delegated decision 2026-09-23: sign-offs are provenance, not content —
  // re-signing a fault does not change what is measured, so it does not
  // change the key. Every field that DOES change the measurement is in.
  const byId = <T extends { id: string }>(xs: readonly T[]): T[] =>
    [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256Hex(
    canonicalJson({
      schema: CATALOG_SCHEMA,
      catalogVersion: catalog.catalogVersion,
      fixture: catalog.fixture,
      mutants: byId(catalog.mutants).map((m) => ({
        id: m.id,
        category: m.category,
        baseArtifact: m.baseArtifact,
        behaviour: m.behaviour,
        diffSha256: m.diffSha256,
        expectedVerdict: m.expectedVerdict,
        // Delegated decision 2026-09-26: the correct-source pin changes what
        // a run will accept as "correct", so it is hashed — but only when
        // present, so every catalog without one keeps its existing hash.
        ...(m.correctSha256 === undefined
          ? {}
          : { correctSha256: m.correctSha256 }),
      })),
      baselines: byId(catalog.baselines).map((b) => ({
        id: b.id,
        category: b.category ?? null,
        artifact: b.artifact,
        behaviour: b.behaviour,
        detonatorSha256: b.detonatorSha256,
        ...(b.correctSha256 === undefined
          ? {}
          : { correctSha256: b.correctSha256 }),
      })),
    }),
  );
}

/**
 * Validate a catalog against DESIGN §13.4 and the policy's composition floors.
 * Throws `CatalogError` listing every problem; never returns a partial set.
 */
export function loadCatalog(
  input: unknown,
  policy: OutcomeGatePolicy,
): BenchmarkCatalog {
  const problems: string[] = [];
  if (!isRecord(input))
    throw new CatalogError(["catalog is not a JSON object"]);

  const catalogVersion = input["catalogVersion"];
  if (!nonEmptyString(catalogVersion)) {
    problems.push("catalogVersion must be a non-empty string");
  }
  const fixtureFlag = input["fixture"];
  if (fixtureFlag !== undefined && typeof fixtureFlag !== "boolean") {
    problems.push("fixture must be a boolean when present");
  }
  const rawMutants = input["mutants"];
  const rawBaselines = input["baselines"];
  if (!Array.isArray(rawMutants)) problems.push("mutants must be an array");
  if (!Array.isArray(rawBaselines)) problems.push("baselines must be an array");
  if (
    problems.length > 0 ||
    !Array.isArray(rawMutants) ||
    !Array.isArray(rawBaselines)
  ) {
    throw new CatalogError(problems);
  }

  const ids = new Set<string>();
  const claimId = (id: unknown, where: string): string | undefined => {
    if (!nonEmptyString(id)) {
      problems.push(`${where}: id must be a non-empty string`);
      return undefined;
    }
    if (ids.has(id))
      problems.push(`${where}: duplicate id ${JSON.stringify(id)}`);
    ids.add(id);
    return id;
  };

  const correctPins = new Map<string, { hash: string; at: string }>();
  const mutants: CatalogMutant[] = [];
  const mutantTargets = new Map<string, string>();
  const mutantHashes = new Map<string, string>();
  rawMutants.forEach((raw: unknown, index) => {
    const where = `mutants[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const id = claimId(raw["id"], where);
    const at = id === undefined ? where : `mutant ${JSON.stringify(id)}`;
    const category = raw["category"];
    if (!isMutantCategory(category)) {
      problems.push(
        `${at}: category must be one of ${MUTANT_CATEGORIES.join(", ")}`,
      );
    }
    const baseArtifact = checkArtifact(raw["baseArtifact"], at, problems);
    const behaviour = raw["behaviour"];
    if (!nonEmptyString(behaviour))
      problems.push(`${at}: behaviour must be a non-empty string`);
    const diff = raw["diff"];
    if (!nonEmptyString(diff))
      problems.push(`${at}: diff must be a non-empty string`);
    if (raw["expectedVerdict"] !== "red") {
      problems.push(
        `${at}: expectedVerdict must be "red" — a mutant is a fault the suite must catch`,
      );
    }
    const signOff = checkSignOff(raw["signOff"], at, problems);
    if (
      id === undefined ||
      !isMutantCategory(category) ||
      baseArtifact === undefined ||
      !nonEmptyString(behaviour) ||
      !nonEmptyString(diff) ||
      signOff === undefined
    ) {
      return;
    }
    const diffSha256 = contentAddress(diff, raw["diffSha256"], at, problems);
    const correctSha256 = checkCorrectSha256(
      raw["correctSha256"],
      baseArtifact,
      at,
      correctPins,
      problems,
    );
    const key = targetKey(baseArtifact, behaviour);
    const sameTarget = mutantTargets.get(key);
    if (sameTarget !== undefined) {
      // Delegated decision 2026-09-23: §13.4 asks for distinct artifact×
      // behaviour targets to yield the N mutant bases; two faults on one
      // target would count one behaviour twice toward N.
      problems.push(
        `${at}: same artifact×behaviour target as mutant ${JSON.stringify(sameTarget)}`,
      );
    }
    mutantTargets.set(key, id);
    const sameDiff = mutantHashes.get(diffSha256);
    if (sameDiff !== undefined) {
      problems.push(
        `${at}: identical diff to mutant ${JSON.stringify(sameDiff)}`,
      );
    }
    mutantHashes.set(diffSha256, id);
    mutants.push({
      id,
      category,
      baseArtifact,
      behaviour,
      diff,
      expectedVerdict: "red",
      signOff,
      diffSha256,
      ...(correctSha256 === undefined ? {} : { correctSha256 }),
    });
  });

  const baselines: CatalogBaseline[] = [];
  const baselineTargets = new Map<string, string>();
  const detonatorHashes = new Map<string, string>();
  rawBaselines.forEach((raw: unknown, index) => {
    const where = `baselines[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const id = claimId(raw["id"], where);
    const at = id === undefined ? where : `baseline ${JSON.stringify(id)}`;
    const category = raw["category"];
    if (category !== undefined && !isMutantCategory(category)) {
      problems.push(
        `${at}: category must be one of ${MUTANT_CATEGORIES.join(", ")} when present`,
      );
    }
    const artifact = checkArtifact(raw["artifact"], at, problems);
    const behaviour = raw["behaviour"];
    if (!nonEmptyString(behaviour))
      problems.push(`${at}: behaviour must be a non-empty string`);
    const signOff = checkSignOff(raw["signOff"], at, problems);
    const rawDetonator = raw["detonator"];
    let detonator: DetonatorEntry | undefined;
    let detonatorSha256: string | undefined;
    if (!isRecord(rawDetonator)) {
      problems.push(
        `${at}: missing detonator (the per-target liveness control)`,
      );
    } else {
      const diff = rawDetonator["diff"];
      const detonatorSignOff = checkSignOff(
        rawDetonator["signOff"],
        `${at} detonator`,
        problems,
      );
      if (!nonEmptyString(diff)) {
        problems.push(`${at}: detonator diff must be a non-empty string`);
      } else if (detonatorSignOff !== undefined) {
        detonatorSha256 = contentAddress(
          diff,
          rawDetonator["diffSha256"],
          `${at} detonator`,
          problems,
        );
        detonator = { diff, signOff: detonatorSignOff };
      }
    }
    if (
      id === undefined ||
      (category !== undefined && !isMutantCategory(category)) ||
      artifact === undefined ||
      !nonEmptyString(behaviour) ||
      signOff === undefined ||
      detonator === undefined ||
      detonatorSha256 === undefined
    ) {
      return;
    }
    const correctSha256 = checkCorrectSha256(
      raw["correctSha256"],
      artifact,
      at,
      correctPins,
      problems,
    );
    const key = targetKey(artifact, behaviour);
    const mutantOnTarget = mutantTargets.get(key);
    if (mutantOnTarget !== undefined) {
      problems.push(
        `${at}: overlaps the mutant population — same artifact×behaviour target as mutant ${JSON.stringify(mutantOnTarget)} (the two denominators must be disjoint)`,
      );
    }
    const sameTarget = baselineTargets.get(key);
    if (sameTarget !== undefined) {
      problems.push(
        `${at}: same artifact×behaviour target as baseline ${JSON.stringify(sameTarget)} — baselines must be independent`,
      );
    }
    baselineTargets.set(key, id);
    const scoredMutant = mutantHashes.get(detonatorSha256);
    if (scoredMutant !== undefined) {
      problems.push(
        `${at}: detonator is identical to scored mutant ${JSON.stringify(scoredMutant)} — detonators are held out of the scored set`,
      );
    }
    const sameDetonator = detonatorHashes.get(detonatorSha256);
    if (sameDetonator !== undefined) {
      problems.push(
        `${at}: identical detonator to baseline ${JSON.stringify(sameDetonator)}`,
      );
    }
    detonatorHashes.set(detonatorSha256, id);
    baselines.push({
      id,
      ...(category === undefined ? {} : { category }),
      artifact,
      behaviour,
      detonator,
      signOff,
      detonatorSha256,
      ...(correctSha256 === undefined ? {} : { correctSha256 }),
    });
  });

  // Composition floors (§13.1). N and M count the RAW submitted entries; the
  // per-category floor counts the ACCEPTED mutants (a refused entry has no
  // trusted category). A refused entry can still never pad N or M into a
  // passing catalog: any refusal is itself a problem, so the catalog throws.
  if (rawMutants.length < policy.minMutants) {
    problems.push(
      `composition: N = ${rawMutants.length} mutants < ${policy.minMutants}`,
    );
  }
  for (const category of MUTANT_CATEGORIES) {
    const count = mutants.filter((m) => m.category === category).length;
    if (count < policy.minPerCategory) {
      problems.push(
        `composition: category ${category} has ${count} mutants < ${policy.minPerCategory}`,
      );
    }
  }
  if (rawBaselines.length < policy.minBaselines) {
    problems.push(
      `composition: M = ${rawBaselines.length} baselines < ${policy.minBaselines}`,
    );
  }

  if (problems.length > 0) throw new CatalogError(problems);

  const shape = {
    catalogVersion: catalogVersion as string,
    fixture: fixtureFlag === true,
    mutants,
    baselines,
  };
  return { ...shape, mutantSetHash: computeMutantSetHash(shape) };
}

/**
 * Read and validate a catalog file. The path is REQUIRED — there is no
 * default location, so nothing can pick up a catalog by accident.
 */
export async function readCatalogFile(
  path: string,
  policy: OutcomeGatePolicy,
): Promise<BenchmarkCatalog> {
  if (!nonEmptyString(path)) {
    throw new CatalogError([
      "a catalog path is required — there is no default catalog",
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CatalogError([
      `cannot read catalog ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  return loadCatalog(parsed, policy);
}
