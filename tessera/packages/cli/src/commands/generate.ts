// `tess generate` — PLAN Phase 6, the write side of the gap report.
//
// `tess coverage` ends with a list of impacted artifacts that no spec declares
// and calls it "the work list". This command is the thing that works it: same
// composite, same single-scope analysis, same instance, and then the graph goes
// to a `TestGenerator` instead of a join.
//
// Six facts shape the file, and five of them are about what it refuses to do.
//
//  * **It writes to `proposed/`, and to nothing else (DEV-4).** The generated
//    tree is inert: a separate directory, a separate `.manifest.proposed.json`,
//    and the live `.manifest.json` is never opened for writing. That is the
//    entire safety envelope of AI-authored tests — a human reads the diff and
//    promotes it, and until they do, nothing this command produced can be run,
//    counted as coverage, or retire a passing test.
//
//  * **It NEVER returns an empty list as a success.** Every failure in the
//    package throws (`./errors.ts` in @tessera/generate argues it at length),
//    and this command adds no catch that converts one back into a green zero.
//    "No specs were generated" and "nothing here needs testing" are the same
//    bytes on a terminal and opposite facts about the code (OPP-1b).
//
//  * **It never returns 1**, for `tess impact`'s reason one step further on.
//    A proposal is not a verdict: these specs have not been run, and a command
//    that fails a build over an unwritten test would be asserting something no
//    evidence supports (QA-8).
//
//  * **The credential is env-only.** `--api-key` is declared so the obvious
//    spelling gets an explanation instead of an unknown-flag error, and refused
//    so the key never reaches argv, `ps(1)` or a shell history. The resolved
//    config is printed through `formatResolvedConfig`, which redacts by
//    descriptor — see `../options.ts`.
//
//  * **TM-1/TM-2 hold at the print boundary, and this command has more to lose
//    by them than any before it.** Two untrusted sources meet here: the script
//    bodies the analyzer read, and the source text a model wrote. Neither
//    reaches stdout. What is printed below is spec ids, repo-relative paths,
//    artifact identities and counts. The model-authored ones (id, path, the
//    target triple) were refused upstream if they carry a control, bidi or
//    zero-width character or run past a cap (`parseCandidates` and the
//    quality bar's `unsafe-field` rule); a target's NAME is otherwise free text
//    and is held to no charset. So every such field is also passed through
//    `escapeForTerminal` on the way out — the refusal is the guard, the escape
//    is what keeps a regression in it from reaching the terminal raw (review
//    W7b M1). No line here may grow into one that renders a generated body, an
//    excerpt of one, or a message assembled out of either.
//
//  * **It is the composition root's job to name the provider** (ARCH-1), and
//    that is why the pinned generation config is built HERE rather than defaulted
//    inside the adapter. A run that cannot name the model that produced it cannot
//    be reproduced, and the layer that reads argv is the layer that knows.

import path from "node:path";

import {
  ConfigError,
  formatResolvedConfig,
  resolveConfig,
} from "@tessera/config";
import {
  ANTHROPIC_DEFAULT_MODEL_ID,
  createAiTestGenerator,
  createAnthropicProvider,
  createGeneratedCodeGate,
  createGenerationQualityBar,
  createTemplateProvider,
  escapeForTerminal,
  generationTargets,
  GenerateInputError,
  PROMPT_VERSION,
  writeProposedSpecs,
  type LLMProvider,
  type PinnedGenConfig,
  type ProposedSpecWriter,
  type ProposedWriteReport,
  type ProviderFetch,
} from "@tessera/generate";
import {
  isIncomplete as impactIsIncomplete,
  type ImpactNote,
  type ImpactReport,
} from "@tessera/impact";
import {
  createCompositeResolver,
  createScopeResolver,
  createSnRecordReader,
  createStoryResolver,
  isIncomplete as resolutionIsIncomplete,
  ResolutionInputError,
  type ResolutionReport,
} from "@tessera/resolvers";
import { TEST_KINDS } from "@tessera/types";
import type {
  PipelineContext,
  TargetArtifactRef,
  TargetInput,
  TestKind,
  TestSpec,
} from "@tessera/types";

import type { CliContext } from "../context.js";
import { EXIT_CODES, type ExitCode } from "../exitCodes.js";
import { GENERATE_OPTIONS } from "../options.js";
import { createCliImpactAnalyzer } from "../impactComposition.js";
import { bindRole, TopologyError } from "../topology.js";

/**
 * The exit-code contract.
 *
 *   0  specs were proposed and written to `proposed/`. Read them before you
 *      promote them; that review is the control this command is built around.
 *   2  the request was wrong: no source, no scope, no tests root, a kind outside
 *      the union, `--provider anthropic` with no key in the environment, or any
 *      `GenerateInputError` — every one of them is fixed by a different
 *      argument, not by a retry.
 *   3  the instance never answered, the model never answered, the answer was
 *      truncated, the gate refused the batch, or the quality bar rejected it.
 *      All of them are DEV-1 faults reaching `cli.ts`: no spec was produced, and
 *      none is being claimed.
 *   5  something could not be answered in full — a partial resolution or an
 *      artifact nobody could analyse. The specs that WERE written are still on
 *      disk and still valid; what is not established is that they are the whole
 *      work list, and a green 0 would say they were.
 */
function exitCodeFor(
  resolution: ResolutionReport,
  impact: ImpactReport,
): ExitCode {
  return resolutionIsIncomplete(resolution) || impactIsIncomplete(impact)
    ? EXIT_CODES.inconclusive
    : EXIT_CODES.ok;
}

/**
 * `<table>/<sys_id>` — the label is what a human recognises, this is what they
 * can open. Escaped for the terminal: both halves came out of a model.
 */
function address(ref: TargetArtifactRef): string {
  return escapeForTerminal(`${ref.table}/${ref.sysId}`);
}

/** The three identity fields, and never a fourth: see the TM-1 note above. */
function refJson(ref: TargetArtifactRef): Record<string, string> {
  return { table: ref.table, sysId: ref.sysId, name: ref.name };
}

/** Aligns the leading column so the rows are scannable down the page. */
function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function isTestKind(value: unknown): value is TestKind {
  return typeof value === "string" && TEST_KINDS.some((kind) => kind === value);
}

/**
 * `globalThis.fetch`, narrowed to the four fields the provider sends and the
 * three it reads.
 *
 * Written out rather than passed through, because the narrow type is the point:
 * `AnthropicProviderOptions.fetch` exists so that @tessera/generate has no
 * opinion about the transport and no way to reach one, and the adapter that
 * closes that seam belongs in the composition root where every other concrete
 * collaborator is named.
 */
export const nodeFetch: ProviderFetch = async (url, init) =>
  await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  });

export async function generateCommand(
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  const usage = (message: string): ExitCode => {
    context.stderr(`tess generate: ${message}`);
    return EXIT_CODES.usage;
  };

  let resolved;
  try {
    resolved = resolveConfig({
      argv,
      env: context.env,
      cwd: context.cwd,
      options: GENERATE_OPTIONS,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      context.stderr(`tess generate: ${error.message}`);
      context.stderr("");
      context.stderr("Run `tess generate --help` for usage.");
      return EXIT_CODES.usage;
    }
    throw error;
  }

  const values = resolved.values;
  const json = values.json === true;

  // Redacted by descriptor — `apiKey` renders `<redacted>` here, on every layer
  // it could have come from.
  if (!json) {
    context.stdout(formatResolvedConfig(resolved));
    context.stdout("");
  }

  const sourceValue = values.source;
  if (typeof sourceValue !== "string" || sourceValue.trim() === "") {
    return usage(
      "no source instance — pass --source <profile> (or --instance <profile>, the ARCH-29 alias); generation READS the source role and writes only to disk (ARCH-19)",
    );
  }

  const scopeValue = values.scope;
  if (typeof scopeValue !== "string" || scopeValue.trim() === "") {
    return usage(
      "no scope — pass --scope <name|sys_id>; the set this generates against comes from the same single-scope analysis as `tess impact` (DESIGN §12.3 row 3)",
    );
  }

  const testsRootValue = values.testsRoot;
  if (typeof testsRootValue !== "string" || testsRootValue.trim() === "") {
    return usage(
      "no tests root — pass --tests-root <dir>; it is the directory the proposed/ tree is written under, and there is no safe implicit answer to where generated code lands (DEV-4)",
    );
  }
  // Against the INJECTED cwd, for `tess coverage`'s reason: a relative
  // --tests-root has to mean the same place the config layers were discovered
  // from, not wherever the process happens to be.
  const testsRoot = path.resolve(context.cwd, testsRootValue);

  const kindValue = values.kind;
  if (!isTestKind(kindValue)) {
    return usage(
      `--kind must be one of ${TEST_KINDS.join(", ")}; one generation produces one kind, so there is no list form`,
    );
  }

  // ── the provider (ARCH-1: this is the only place either one is named) ──────
  const providerName = values.provider;
  const modelId =
    typeof values.model === "string" && values.model.trim() !== ""
      ? values.model
      : ANTHROPIC_DEFAULT_MODEL_ID;

  // Pinned here rather than defaulted inside the adapter — see the header. The
  // prompt hash stays empty at this layer: the real one belongs to a rendered
  // prompt, which does not exist until a graph does, and the generator attaches
  // it per run as provenance on every written spec.
  const genConfig: PinnedGenConfig = {
    modelId,
    temperature: 0,
    maxTokens: 8192,
    promptHash: "",
    promptVersion: PROMPT_VERSION,
  };

  let provider: LLMProvider;
  // Whether this run sends the scope's script bodies off the machine — the one
  // question about `--provider` the document could not answer. `provider.name`
  // and `modelId` were both there, and both are useless for it unless the
  // reader already knows which of the two spellings is the offline default: a
  // consumer looking at `{"name":"template"}` has to have read `provider.ts` to
  // know nothing was transmitted.
  //
  // Assigned inside the same branch that picks the provider, so it cannot
  // describe a provider that was not chosen. This is `coverage.ts`'s rule about
  // constants read the other way round: that file's `basis` is a literal
  // because no code path could make it anything else; this one has exactly such
  // a path, so it is computed rather than written down.
  //
  // A two-value union rather than `transmittedSource: boolean`, because a
  // boolean answers "did it leave" and not "to whom", and the next provider — a
  // self-hosted model, a corporate gateway — is a third value rather than a
  // flip of the first two. `--base-url` does not soften "third-party": it
  // redirects where the prompt goes, it does not keep it in this process.
  let egress: "none" | "third-party";
  if (providerName === "anthropic") {
    const apiKey = values.apiKey;
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      return usage(
        "--provider anthropic needs a key in TESSERA_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY); it is env-only on purpose — a flag would put the credential in your shell history and in `ps`",
      );
    }
    try {
      provider = createAnthropicProvider({
        fetch: nodeFetch,
        apiKey,
        config: genConfig,
        ...(typeof values.baseUrl === "string" && values.baseUrl.trim() !== ""
          ? { baseUrl: values.baseUrl }
          : {}),
      });
    } catch (error) {
      // The adapter validates its own config and reports what is wrong with it.
      // The key is never in that message; it checks only that one exists.
      if (error instanceof GenerateInputError) return usage(error.message);
      throw error;
    }
    egress = "third-party";
  } else {
    // Offline, deterministic, and the default: the spelling that costs money and
    // sends a scope's script bodies to a third party is the one you have to type.
    provider = createTemplateProvider();
    egress = "none";
  }

  let binding;
  try {
    binding = bindRole("source", sourceValue);
  } catch (error) {
    if (error instanceof TopologyError) return usage(error.message);
    throw error;
  }

  // The wiring from here to `analyzeWithReport` is `tess coverage`'s, duplicated
  // for the reason that file gives: what the commands share is one profile
  // binding and one composite, what differs is the strings inside it.
  const reader = createSnRecordReader(binding.profile);
  const artifactTables = values.artifactTables ?? [];
  const updateSetStoryField = values.updateSetStoryField;

  const resolver = createCompositeResolver([
    createStoryResolver(reader, {
      ...(updateSetStoryField === undefined ? {} : { updateSetStoryField }),
    }),
    createScopeResolver(reader, {
      ...(artifactTables.length === 0 ? {} : { artifactTables }),
    }),
  ]);

  const ctx: PipelineContext = {
    runId: `generate-${context.now().toISOString()}`,
    // Nothing is projected onto the instance — the only thing this run creates
    // is a directory of files, and it creates it on the operator's own disk.
    lifecycle: "ephemeral",
    // "intent", not "coverage": §4a reserves the second word for a fact a run
    // produced, and a generated spec has not even been run once.
    coverageSource: "intent",
    topology: {
      source: binding.profile,
      runner: binding.profile,
      target: binding.profile,
    },
    // Not yet wired to a process signal. The generator honours it at both of its
    // cancellation points, so the seam is here when a caller has one to give.
    signal: new AbortController().signal,
  };

  const input: TargetInput = {
    ...(typeof values.story === "string" && values.story.trim() !== ""
      ? { story: values.story }
      : {}),
    scope: scopeValue,
  };

  let resolution: ResolutionReport;
  try {
    resolution = await resolver.resolveWithReport(ctx, input);
  } catch (error) {
    if (error instanceof ResolutionInputError) return usage(error.message);
    throw error;
  }

  // Business Rules are traced too — see `../impactComposition.ts`.
  const analyzer = createCliImpactAnalyzer(reader, { scope: scopeValue });

  let report: ImpactReport;
  try {
    report = await analyzer.analyzeWithReport(ctx, [...resolution.artifacts]);
  } catch (error) {
    if (error instanceof ResolutionInputError) return usage(error.message);
    throw error;
  }

  // Asked BEFORE the generator is built, so an analysis that named nothing is
  // refused as the operator's mistake (exit 2) instead of arriving inside the
  // adapter as a fault. `generationTargets` is the generator's own selection
  // function, re-used rather than re-implemented: the CLI must not disagree with
  // the adapter about what a target is.
  const targets = generationTargets(report.graph);
  if (targets.length === 0) {
    return usage(
      `this analysis named no artifact a spec could target, so there is nothing to generate; \`tess coverage --scope ${scopeValue}\` shows what the same analysis found`,
    );
  }

  // The write report never leaves the generator: `TestGenerator.generate`
  // returns specs, and three facts about what happened on disk — which files
  // were overwritten, and the live manifest the writer deliberately did not
  // open — are consumed inside the adapter and dropped. Widening that port so
  // one command can print them would change a contract every stage in the
  // pipeline shares.
  //
  // The composition root already names the writer (ARCH-1), so it is the one
  // place that can keep what the writer said on the way past. This wrapper adds
  // no behaviour: it calls `writeProposedSpecs` and records its report. Every
  // field published below is the writer's own, recorded rather than recomputed
  // — which is the point, because a CLI that recomputes a path the writer owns
  // can be wrong about it and still look consistent.
  let writeReport: ProposedWriteReport | undefined;
  const writer: ProposedSpecWriter = {
    write: async (writeOptions) => {
      const report = await writeProposedSpecs(writeOptions);
      writeReport = report;
      return report;
    },
  };

  const generator = createAiTestGenerator({
    provider,
    gate: createGeneratedCodeGate(),
    quality: createGenerationQualityBar(),
    writer,
    testsRoot,
    // No `instruction` override. `../options.ts` argues why the CLI declares no
    // flag for it: the parameter replaces the frozen instruction channel whole,
    // and a run that does that while still recording the pinned prompt version
    // is a run whose provenance is wrong.
    ...(typeof values.deadlineMs === "number"
      ? { deadlineMs: values.deadlineMs }
      : {}),
    now: () => context.now().getTime(),
  });

  let specs: readonly TestSpec[];
  try {
    specs = await generator.generate(ctx, report.graph, kindValue);
  } catch (error) {
    // A `GenerateInputError` is the operator's to fix. A `GenerationFaultError`
    // is deliberately NOT caught: `cli.ts` renders it as INFRASTRUCTURE FAULT
    // (DEV-1) and exits 3, which is the distinction that keeps "the model
    // refused" from being reported as "your code needs no tests".
    if (error instanceof GenerateInputError) return usage(error.message);
    throw error;
  }

  if (writeReport === undefined) {
    // Unreachable on today's code: the generator's only successful exit runs
    // the writer, and every other exit throws. Kept, and kept as a throw,
    // because "unreachable" is a claim about today's code and the alternative
    // is a report that quietly loses the fields below — the exact failure this
    // block was added to close. `cli.ts` renders it as a DEV-1 fault, which is
    // what an internal disagreement of this kind is: no claim is made about
    // the change, and none should be.
    throw new Error(
      "the generator returned specs without the writer reporting the write that produced them; the proposal on disk cannot be described",
    );
  }

  // Read off the writer, no longer recomputed. These two used to be the CLI's
  // own copy of a fact `writer.ts` owns — correct only for as long as both
  // files agreed about where a proposed manifest sits — and the only reason for
  // the duplication was that the write report did not reach this far. It does
  // now.
  const { proposedDir, manifestPath, liveManifestPath } = writeReport;

  // Keyed by id rather than zipped by position. `generator.ts` builds one spec
  // per written entry, so the lookup is total, but nothing in the port promises
  // the order survives — and a destructive-write flag attached to the wrong
  // spec is worse than no flag at all.
  const overwrittenById = new Map(
    writeReport.written.map((entry) => [entry.id, entry.overwritten] as const),
  );
  const overwroteExisting = writeReport.written.some(
    (entry) => entry.overwritten,
  );

  const notes: readonly {
    readonly level: string;
    readonly source: string;
    readonly message: string;
  }[] = [
    ...resolution.notes.map((note) => ({
      level: note.level,
      source: note.source,
      message: note.message,
    })),
    ...report.notes.map((note: ImpactNote) => ({
      level: note.level,
      source: "impact",
      message: note.message,
    })),
  ];

  const incomplete =
    resolutionIsIncomplete(resolution) || impactIsIncomplete(report);

  if (json) {
    // One document, one write — a consumer piping stdout into a parser must not
    // have to reassemble it. Field by field, never a spread: the only strings
    // here are ids, repo paths and artifact identities (TM-1).
    context.stdout(
      JSON.stringify(
        {
          source: { profile: binding.profile, host: binding.ref.host },
          input,
          kind: kindValue,
          // The provider's own name and the pinned model, because a proposal
          // nobody can attribute to a model is a proposal nobody can reproduce.
          // The key is not here and has no field.
          provider: { name: provider.name, modelId: provider.config.modelId },
          // Top level rather than inside `provider`, because it is a fact about
          // the RUN and not about the adapter: if anything else in this command
          // ever transmits, it belongs to this field and not to a second one.
          egress,
          testsRoot,
          proposedDir,
          manifestPath,
          // The path the writer did NOT open. `writer.ts` returns it in so many
          // words — "so a caller, or a test, can assert the negative against a
          // concrete string rather than a convention" — and the document that
          // most needed it named `manifestPath` and `proposedDir` and left the
          // live manifest out. DEV-4's claim is that this file was untouched,
          // and a claim about a file nobody names is not checkable.
          liveManifestPath,
          specs: specs.map((generated) => ({
            id: generated.ref.id,
            path: generated.ref.path,
            kind: generated.kind,
            targets: generated.targets.map(refJson),
            // Per spec, because a batch that replaced one file of six is not
            // "a regeneration" to the reviewer who wrote that one file. The
            // writer records it ("regeneration is allowed; silence is not") and
            // nothing in production read it until here.
            overwritten: overwrittenById.get(generated.ref.id) ?? false,
          })),
          notes,
          incomplete,
          // DEV-4, carried into the machine document. The human branch closes
          // with "NOTHING HAS BEEN RUN and nothing has been promoted: proposed/
          // is inert until a human reads the diff and moves it into the live
          // manifest" — the safety envelope's whole claim. The `--json` branch
          // stated none of it, so a consumer saw `specs: [...]` next to a
          // `manifestPath` and had nothing to tell it these are proposals
          // rather than registered, passing tests.
          //
          // Two booleans because the human line states two separate facts, and
          // collapsing them would let a reader satisfy one and assume the
          // other. Constants for the reason given on the `basis` field in
          // `coverage.ts`: this command cannot run a spec and cannot promote
          // one, so there is no branch to compute from. A future edit that
          // adds one must compute these, and that is a DEV-4 change.
          executed: false,
          promoted: false,
          // The third fact in that family, and the only one of the three that
          // is NOT a constant — which is exactly why it has to be computed.
          // This one is the destructive half of the envelope: `proposed/` being
          // inert says a generated spec cannot run, and says nothing about the
          // previous proposal whose file this batch replaced. The MCP tool
          // description justifies `destructiveHint: true` on precisely this
          // case, so the flag that earns the hint had better be in the document
          // the hint is attached to.
          overwroteExisting,
          counts: {
            impacted: targets.length,
            proposed: specs.length,
          },
        },
        null,
        2,
      ),
    );
    return exitCodeFor(resolution, report);
  }

  context.stdout(`source: ${binding.profile} <${binding.ref.host}>`);
  context.stdout(
    `provider: ${provider.name} (${escapeForTerminal(provider.config.modelId)}), kind ${kindValue}`,
  );
  context.stdout(
    `tests root: ${testsRoot} (${targets.length} impacted artifact(s) offered to the generator)`,
  );
  context.stdout("");

  // Delegated decision 2026-09-26 (W7b M1): escape BEFORE padding, and
  // measure the escaped width — an id padded on its raw length would misalign
  // exactly the rows whose escapes the reviewer most needs to read.
  const printedIds = specs.map((s) => escapeForTerminal(s.ref.id));
  const idWidth = Math.max(0, ...printedIds.map((id) => id.length));
  context.stdout(`proposed (${specs.length}):`);
  specs.forEach((generated, index) => {
    context.stdout(
      `  ${pad(printedIds[index] ?? "", idWidth)}  ${escapeForTerminal(generated.ref.path)}`,
    );
    // Indented under the spec, because the row above is the subject: the
    // question a reviewer asks is "what does this spec claim to cover".
    for (const target of generated.targets) {
      context.stdout(
        `      ${address(target)}  ${escapeForTerminal(target.name)}`,
      );
    }
  });

  if (notes.length > 0) {
    context.stdout("");
    context.stdout("notes:");
    for (const note of notes) {
      // Warnings are marked in the line itself: in a CI log the only thing a
      // reader can grep for is the word.
      const mark = note.level === "warning" ? "WARNING" : "info";
      context.stdout(`  [${mark}] ${note.source}: ${note.message}`);
    }
  }

  context.stdout("");
  context.stdout(`written to ${proposedDir}`);
  context.stdout(`manifest:  ${manifestPath}`);
  context.stdout("");
  context.stdout(
    incomplete
      ? `INCOMPLETE — ${specs.length} spec(s) proposed for ${targets.length} impacted artifact(s), but at least one stage could not answer in full; these specs are real, the claim that they are the WHOLE work list is not (QA-9). Nothing has been run and nothing has been promoted.`
      : `${specs.length} spec(s) proposed for ${targets.length} impacted artifact(s) in scope ${scopeValue} on ${binding.profile}. NOTHING HAS BEEN RUN and nothing has been promoted: proposed/ is inert until a human reads the diff and moves it into the live manifest (DEV-4).`,
  );

  return exitCodeFor(resolution, report);
}
