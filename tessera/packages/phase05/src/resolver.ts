// TEMPORARY — PLAN Phase 0.5 walking skeleton (named ARCH-1 exception; README).
//
// The hardcoded Resolver. It answers exactly one question — "where does
// sys_script_include 'TesseraS5Target' live on the source instance?" — and it
// is deliberately NOT general: ARCH-5's three-way composite resolution
// (story → linked update sets → scope, de-duplicated by sys_id, `resolvedBy`
// keeping the winning source visible) is Phase 2 work. What this file proves is
// only the shape of the seam: a Resolver reads, never writes, and hands the
// pipeline `AffectedArtifact`s carrying a real instance sys_id.

import type { Resolver } from "@tessera/core";
import type {
  AffectedArtifact,
  PipelineContext,
  TargetInput,
} from "@tessera/types";
import { tableApi } from "@tessera/sn-client";

import { SCRIPT_INCLUDE_TABLE } from "./atf.js";
import { SkeletonInfrastructureError } from "./errors.js";
import { S5_TARGET_NAME } from "./fixtures.js";
import { readField, requireSysId } from "./snRecords.js";

/**
 * Rows the ambiguity probe reads. Two, not one: the point of the read is to
 * prove the name matches EXACTLY one Script Include, and a limit of one turns
 * an ambiguous name into a confident wrong answer.
 */
const AMBIGUITY_PROBE_LIMIT = 2;

/**
 * Delegated decision 2026-09-25: the target name is spliced into an encoded
 * query (`name=<targetName>`), so a name carrying `^` (term join, `^OR`),
 * `=`/`@` (operator syntax) or anything else outside this conservative set is
 * refused before any request rather than escaped — ServiceNow has no reliable
 * escape for encoded-query values. Script Include names in scope are
 * identifiers, so the set loses nothing legitimate.
 */
const SAFE_TARGET_NAME = /^[A-Za-z0-9_.-]+$/;

export interface S5ResolverOptions {
  /** Overridable only so a test can point at a differently named copy. */
  readonly targetName?: string;
}

/**
 * `resolvedBy` is pinned to `"scope"`: of ARCH-5's three sources, scope is the
 * one this resolver actually behaves like — it enumerates by name inside a
 * scope rather than reading a story or an update set. Reporting `"story"` here
 * would be a lie the verdict later repeats.
 */
export function createS5Resolver(options: S5ResolverOptions = {}): Resolver {
  const targetName = options.targetName ?? S5_TARGET_NAME;

  return {
    async resolve(
      _ctx: PipelineContext,
      input: TargetInput,
    ): Promise<AffectedArtifact[]> {
      // GUESS/STUB: the hardcoded skeleton ignores `story` and `updateSet`
      // rather than pretending to honour them. Refusing loudly keeps a Phase-1
      // caller from believing resolution happened.
      if (input.story !== undefined || input.updateSet !== undefined) {
        throw new SkeletonInfrastructureError(
          "the Phase 0.5 resolver is hardcoded to one Script Include: " +
            "story / update-set resolution lands with ARCH-5 in Phase 2",
        );
      }

      if (!SAFE_TARGET_NAME.test(targetName)) {
        throw new SkeletonInfrastructureError(
          `resolve: target name ${JSON.stringify(targetName)} is not safe to splice into a ServiceNow encoded query (expected ${SAFE_TARGET_NAME.source}) — refusing before any request`,
        );
      }

      const { records } = await tableApi.queryTable({
        table: SCRIPT_INCLUDE_TABLE,
        query: `name=${targetName}`,
        fields: ["sys_id", "name", "api_name", "sys_scope"],
        limit: AMBIGUITY_PROBE_LIMIT,
      });

      const first = records[0];
      if (first === undefined) {
        throw new SkeletonInfrastructureError(
          `resolve: ${SCRIPT_INCLUDE_TABLE} "${targetName}" does not exist on the source instance`,
        );
      }
      if (records.length > 1) {
        // Two same-named Script Includes means two scopes; picking one blind
        // would silently test the wrong artifact.
        //
        // The count is deliberately NOT reported. `limit: 2` proves ambiguity
        // and nothing more: `records.length` can only ever read 2, so printing
        // it would state a total the query never asked the instance for — a
        // truncated read wearing the confidence of a complete one. The same
        // rule is why `@tessera/resolvers` (story.ts) says "more than one".
        throw new SkeletonInfrastructureError(
          `resolve: ${SCRIPT_INCLUDE_TABLE} "${targetName}" is ambiguous ` +
            `(more than one match; this read is capped at ${AMBIGUITY_PROBE_LIMIT})`,
        );
      }

      // Delegated decision 2026-09-25: `=` on ServiceNow string fields is
      // case-INSENSITIVE, so the row returned is not proven to be the one asked
      // for. Its own `name` must equal the requested one exactly (fail closed:
      // a missing or different name is a refusal, never a quiet substitution).
      const returnedName = readField(first, "name");
      if (returnedName !== targetName) {
        throw new SkeletonInfrastructureError(
          `resolve: ${SCRIPT_INCLUDE_TABLE} query for "${targetName}" returned a row named ${JSON.stringify(returnedName ?? null)} — refusing to resolve a record whose name does not match exactly`,
        );
      }

      return [
        {
          ref: {
            table: SCRIPT_INCLUDE_TABLE,
            sysId: requireSysId(first, `resolve ${targetName}`),
            name: targetName,
          },
          resolvedBy: "scope",
        },
      ];
    },
  };
}
