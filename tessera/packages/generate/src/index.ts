// @tessera/generate — PLAN Phase 6. The AI test generator, as one adapter of
// the `TestGenerator` port `@tessera/core` owns, plus the five pieces it is
// assembled from.
//
// `createAiTestGenerator` is the only thing the pipeline needs. Everything else
// on this list is exported for one of two reasons, and both are deliberate:
//
//   * ARCH-1. The adapter names no collaborator, so somebody else has to. That
//     somebody is `@tessera/cli`, and it can only pass `createTemplateProvider`
//     or `createGeneratedCodeGate` to `createAiTestGenerator` if this barrel
//     hands them over. A narrow surface here would not make the package more
//     encapsulated — it would make it unusable.
//   * DR-2. An adapter reachable only through its port has parts that never get
//     pinned down. The gate's rule table, the prompt's fence sentinel, the
//     quality bar's assertion counter and the writer's suffix map are each
//     testable propositions on their own, and each is a security or correctness
//     claim this package makes out loud. They are exported so a test can hold
//     them to it directly, rather than inferring the rule from the one bit that
//     survives a full `generate` call.
//
// The exports are listed one by one rather than `export *`, so the public
// surface is a decision made here and not a side effect of what a module
// happened to export.
//
// What is NOT here is as deliberate. There is no exported way to skip the gate,
// no helper that turns an `Untrusted<string>` back into a plain one, and no
// write path to the live `.manifest.json` — a generated spec becomes runnable
// when a human moves it, and nothing in this package can do that for them
// (DEV-4, TM-1, TM-3).

export { GenerateInputError, GenerationFaultError } from "./errors.js";

export {
  MAX_FILENAME_CHARS,
  MAX_ID_CHARS,
  MAX_MODEL_ID_CHARS,
  MAX_SYS_ID_CHARS,
  MAX_TABLE_CHARS,
  MAX_TARGET_NAME_CHARS,
  MAX_TARGETS_PER_SPEC,
  escapeForTerminal,
  hasUnsafeTextCharacter,
  isSafeField,
  sanitizeModelId,
} from "./fieldSafety.js";

export {
  GATE_CATEGORIES,
  MAX_GATED_SOURCE_CHARS,
  createGeneratedCodeGate,
  gateRuleNames,
  inspectGeneratedSource,
} from "./gate.js";
export type {
  ClearedSource,
  GateCategory,
  GateClearance,
  GateRuleName,
  GateVerdict,
  GateViolation,
  GeneratedCodeGate,
} from "./gate.js";

export {
  DEFAULT_GENERATION_DEADLINE_MS,
  createAiTestGenerator,
  generationTargets,
} from "./generator.js";
export type {
  AiTestGeneratorOptions,
  ProposedSpecWriter,
} from "./generator.js";

export {
  GENERATION_INSTRUCTION,
  PROMPT_FENCE_REPLACEMENT,
  PROMPT_FENCE_SENTINEL,
  PROMPT_VERSION,
  buildGenerationPrompt,
  graphDataBlocks,
  instructionHashFor,
  renderPrompt,
} from "./prompt.js";
export type {
  PromptAssembly,
  PromptDataBlock,
  RenderedPrompt,
} from "./prompt.js";

export {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL_ID,
  ANTHROPIC_MESSAGES_PATH,
  ANTHROPIC_VERSION_HEADER,
  MODELS_WITHOUT_SAMPLING_PARAMS,
  SUFFIX_BY_KIND,
  createAnthropicProvider,
  createTemplateProvider,
  modelAcceptsSamplingParams,
  parseCandidates,
} from "./provider.js";
export type {
  AnthropicProviderOptions,
  GenerationCandidate,
  GenerationRequest,
  LLMProvider,
  PinnedGenConfig,
  ProviderCompletion,
  ProviderFetch,
  ProviderFetchInit,
  ProviderFetchResponse,
  TemplateProviderOptions,
} from "./provider.js";

export {
  MIN_ASSERTIONS,
  QUALITY_RULES,
  QUALITY_RULE_DETAILS,
  analyzeAssertions,
  checkGenerationQuality,
  createGenerationQualityBar,
  graphTargetKeys,
  summarizeQualityFindings,
  targetKey,
} from "./quality.js";
export type {
  AssertionAnalysis,
  GenerationQualityBar,
  QualityFinding,
  QualityRuleName,
  QualitySubject,
  QualityVerdict,
} from "./quality.js";

export {
  ALLOWED_SUFFIXES,
  LIVE_MANIFEST_FILENAME,
  PROPOSED_DIRNAME,
  PROPOSED_MANIFEST_FILENAME,
  PROPOSED_MANIFEST_VERSION,
  writeProposedSpecs,
} from "./writer.js";
export type {
  ProposedManifest,
  ProposedManifestEntry,
  ProposedProvenance,
  ProposedSpec,
  ProposedWriteReport,
  SwapStep,
  WriteProposedOptions,
  WriterSeams,
  WrittenSpec,
} from "./writer.js";
