// The model seam, and the pinned configuration that makes a generation run
// reproducible (DESIGN §12.3, PLAN Phase 6).
//
// `LLMProvider` is the only place in this package that knows a model exists.
// Everything else — the prompt assembly, the gate, the quality bar, the writer
// — works on strings and structures and would run identically against a
// provider that returned canned text, which is exactly what `createTemplateProvider`
// is. The package therefore has no mandatory API key, no mandatory network, and
// a full test suite that never leaves the process (QA-19: the PR-blocking half
// of QA-12 is hermetic).
//
// Two properties of this file are load-bearing.
//
// The `fetch` is INJECTED and is never the global. A module that reached for
// `globalThis.fetch` would be a module whose tests can only be written by
// monkey-patching the runtime, and a package whose "no network in CI" claim
// rests on nobody having called it. Passing the function in makes the hermetic
// path the default and the network path a decision somebody typed.
//
// No secret is ever interpolated into a message. The key lives in a closure,
// is written to exactly one header, and appears in no error, no log line and no
// returned value. Errors here carry the HTTP status and the API's own error
// TYPE (a closed enum) and nothing else — not the response body, which can
// quote the request back, and not model output, which `./errors.ts` explains is
// untrusted text that must not travel to a log.
//
// ── A note on `temperature`, because the field is not wired and pretending
// otherwise would be the wrong kind of tidy ────────────────────────────────
// `PinnedGenConfig` carries `temperature` because DESIGN §12.3 defines it as
// part of the reproducibility record. The current Messages API does NOT accept
// it on the current models: `temperature`, `top_p` and `top_k` were removed on
// Opus 5, Fable 5 and Opus 4.8/4.7 and are answered with a 400, and Sonnet 5
// rejects any non-default value. So the field is RECORDED — it travels with
// the run as provenance and it changes nothing about the request — and it is
// sent only to a model id outside that family. `MODELS_WITHOUT_SAMPLING_PARAMS`
// below is the list, and it is the first thing to revisit when the pinned model
// id changes.

import { TEST_KINDS, untrusted, unwrapUntrusted } from "@tessera/types";
import type { TargetArtifactRef, TestKind, Untrusted } from "@tessera/types";

import { GenerateInputError, GenerationFaultError } from "./errors.js";
import {
  MAX_FILENAME_CHARS,
  MAX_ID_CHARS,
  MAX_SYS_ID_CHARS,
  MAX_TABLE_CHARS,
  MAX_TARGET_NAME_CHARS,
  MAX_TARGETS_PER_SPEC,
  isSafeField,
} from "./fieldSafety.js";
import type { RenderedPrompt } from "./prompt.js";

/** DESIGN §12.3 — everything a run has to record to be reproducible. */
export interface PinnedGenConfig {
  /** An exact model id. Never an alias and never a floating "latest". */
  readonly modelId: string;
  /** Recorded provenance; see the file header for why it is not always sent. */
  readonly temperature: number;
  readonly maxTokens: number;
  /** sha256 of the frozen instruction channel — `RenderedPrompt.instructionHash`. */
  readonly promptHash: string;
  /** A human-readable tag for the prompt, for a changelog to point at. */
  readonly promptVersion: string;
}

/**
 * What a provider is asked for. The prompt arrives already rendered into its
 * two channels (TM-2) and is never re-joined here.
 */
export interface GenerationRequest {
  readonly prompt: RenderedPrompt;
  readonly kind: TestKind;
  /**
   * The artifacts the batch is expected to bind to. Structural identity, used
   * by the offline provider to produce a spec and by the quality bar to check
   * that a model did not invent a target.
   */
  readonly targets: readonly TargetArtifactRef[];
}

/**
 * The raw answer. `text` is branded on arrival for the reason `./errors.ts`
 * gives: model output is untrusted text with a different origin, and a package
 * whose whole point is a gate would be absurd if it treated the thing it gates
 * as clean.
 */
export interface ProviderCompletion {
  readonly text: Untrusted<string>;
  readonly modelId: string;
  readonly promptHash: string;
  readonly stopReason: string;
}

export interface LLMProvider {
  /** For logs and error text. A constant, never anything caller-supplied. */
  readonly name: string;
  readonly config: PinnedGenConfig;
  complete(
    request: GenerationRequest,
    signal: AbortSignal,
  ): Promise<ProviderCompletion>;
}

/** One spec as the model proposed it, before any gate has looked at it. */
export interface GenerationCandidate {
  readonly id: string;
  readonly kind: TestKind;
  readonly filename: string;
  readonly targets: readonly TargetArtifactRef[];
  readonly source: Untrusted<string>;
}

// ── the offline provider ────────────────────────────────────────────────────

/**
 * The file suffix each kind is written with, from `@tessera/specs`'
 * `SPEC_FILE_SUFFIXES`. Kept as a total map over `TestKind` so adding a kind
 * without deciding its suffix is a compile error rather than a spec nobody's
 * reader recognises.
 */
export const SUFFIX_BY_KIND: Readonly<Record<TestKind, string>> = {
  unit: ".unit.ts",
  e2e: ".e2e.atf.yaml",
  ui: ".spec.ts",
};

/** A table name reduced to what a filename may contain. Schema, never prose. */
function tableSlug(table: string): string {
  const slug = table.toLowerCase().replace(/[^a-z0-9_]+/g, "-");
  return slug === "" ? "artifact" : slug.slice(0, 60);
}

/** Enough sys_id to be unique in a batch, little enough to read. */
function shortId(sysId: string): string {
  const hex = sysId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return hex === "" ? "unknown" : hex.slice(0, 12);
}

/**
 * The offline body.
 *
 * It is built ONLY from `table` and `sysId`. `name` is instance-derived prose
 * and is deliberately absent: the manifest declares it in a `targets[].name`
 * field, where it is labelled data a reader can see is data, and a spec file is
 * the one place where an un-labelled copy of it would look like something a
 * person wrote (TM-1). Nothing here needs it — the join is on identity (QA-16).
 */
function templateSource(kind: TestKind, target: TargetArtifactRef): string {
  return [
    "// PROPOSED spec — generated, not armed.",
    "// Nothing runs this until a human moves its entry into .manifest.json.",
    `// target table: ${tableSlug(target.table)}`,
    `// target sys_id: ${shortId(target.sysId)}`,
    `// kind: ${kind}`,
    "",
    "export function run(step) {",
    "  const record = step.getRecord();",
    '  assertNotEqual("the target record was not loaded", null, record);',
    `  assertEqual("the record is on the expected table", "${tableSlug(target.table)}", record.getTableName());`,
    '  assertNotEqual("the record has a state", "", record.getValue("state"));',
    "}",
    "",
  ].join("\n");
}

export interface TemplateProviderOptions {
  readonly config?: PinnedGenConfig;
}

/**
 * A provider with no model behind it: one spec per target, from a fixed
 * template, deterministic to the byte.
 *
 * It exists for three reasons that are all the same reason. It makes the
 * package runnable with no API key, so `tess generate` has something honest to
 * do in a sandbox. It makes the QA-12(a) suite hermetic, so the PR gate never
 * depends on a vendor's availability. And it keeps the seam honest: a template
 * provider that could not be substituted for the real one would mean the
 * pipeline had grown a dependency on the model that nothing declared.
 *
 * Its `promptHash` is blank by default, which means "not pinned" — an offline
 * template has no frozen prompt to drift from. Nothing in this package checks
 * a pin: `./generator.ts` never compares `config.promptHash` with the prompt it
 * renders. The drift check (DESIGN §12.3) lives in the composition root that
 * keys results on the pin — `@tessera/cli`'s `promptHashDrift`
 * (`benchmarkRun.ts`), which compares a non-blank pin with
 * `instructionHashFor(kind)` from `./prompt.ts` and skips a blank one.
 */
export function createTemplateProvider(
  options: TemplateProviderOptions = {},
): LLMProvider {
  const config: PinnedGenConfig = options.config ?? {
    modelId: "template://tessera-generate/1",
    temperature: 0,
    maxTokens: 0,
    promptHash: "",
    promptVersion: "template/1",
  };

  return {
    name: "template",
    config,
    complete(request: GenerationRequest): Promise<ProviderCompletion> {
      const specs = request.targets.map((target) => ({
        id: `${tableSlug(target.table)}.${shortId(target.sysId)}.${request.kind}`,
        kind: request.kind,
        filename: `${tableSlug(target.table)}.${shortId(target.sysId)}${SUFFIX_BY_KIND[request.kind]}`,
        targets: [
          { table: target.table, sysId: target.sysId, name: target.name },
        ],
        source: templateSource(request.kind, target),
      }));

      return Promise.resolve({
        // Branded like any other completion. The template author is trusted;
        // the shape of the seam is not the place to make an exception, because
        // an exception here is a second code path through the gate.
        text: untrusted(JSON.stringify({ specs }, null, 2)),
        modelId: config.modelId,
        promptHash: config.promptHash,
        stopReason: "end_turn",
      });
    },
  };
}

// ── the Anthropic provider ──────────────────────────────────────────────────

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_MESSAGES_PATH = "/v1/messages";
export const ANTHROPIC_VERSION_HEADER = "2023-06-01";

/** The pinned default. An exact id — no alias, no date suffix appended. */
export const ANTHROPIC_DEFAULT_MODEL_ID = "claude-opus-5";

/**
 * Model ids that answer 400 to `temperature`/`top_p`/`top_k`, or reject any
 * non-default value. See the header: the pinned config still RECORDS the
 * temperature, it just is not sent to these.
 */
export const MODELS_WITHOUT_SAMPLING_PARAMS: readonly string[] = [
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-mythos-5",
];

export function modelAcceptsSamplingParams(modelId: string): boolean {
  return !MODELS_WITHOUT_SAMPLING_PARAMS.includes(modelId);
}

/**
 * The minimum of `fetch` this package uses, declared structurally.
 *
 * Not `typeof globalThis.fetch`: naming the global would tie the seam to one
 * runtime's lib types and would make a hand-written fake in a test a cast
 * exercise. A caller passes `(url, init) => fetch(url, init)` and the shapes
 * line up.
 */
export interface ProviderFetchInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface ProviderFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type ProviderFetch = (
  url: string,
  init: ProviderFetchInit,
) => Promise<ProviderFetchResponse>;

export interface AnthropicProviderOptions {
  /** Required and injected. There is deliberately no default. */
  readonly fetch: ProviderFetch;
  /** Read from the environment by the composition root, never from a file. */
  readonly apiKey: string;
  readonly config?: PinnedGenConfig;
  readonly baseUrl?: string;
}

/** The API's own error taxonomy. A closed set, so it is safe to put in a message. */
const KNOWN_ERROR_TYPES: readonly string[] = [
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "overloaded_error",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The API error type, or `unknown`. Only ever a member of the closed list
 * above — an unrecognised string is discarded rather than echoed, because an
 * error envelope is a place a server can put anything at all.
 */
function errorTypeOf(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "unknown";
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return "unknown";
  const type = parsed.error.type;
  return typeof type === "string" && KNOWN_ERROR_TYPES.includes(type)
    ? type
    : "unknown";
}

/** The concatenated text blocks of a Messages response, or undefined. */
function textOf(parsed: unknown): string | undefined {
  if (!isRecord(parsed) || !Array.isArray(parsed.content)) return undefined;
  const parts: string[] = [];
  for (const block of parsed.content as readonly unknown[]) {
    // `content` is a discriminated union — thinking blocks, tool blocks and
    // text blocks all live in it, and reading `.text` off the first element
    // without narrowing is how a thinking-enabled model turns into `undefined`.
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.length === 0 ? undefined : parts.join("");
}

function stringField(parsed: unknown, field: string): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const value = parsed[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * A provider over the Messages API, reached through the injected `fetch`.
 *
 * Every failure is a `GenerationFaultError`, and that is the whole DEV-1 point:
 * a refusal, a truncation, an empty content array, a 429 and an unparsable body
 * are all "the environment failed underneath a well-formed request", and the
 * one answer none of them may become is an empty spec list. `./errors.ts`
 * writes out why an empty list is the most dangerous wrong answer here.
 *
 * @throws GenerateInputError if no key was supplied — the fix is a different
 * argument, not a retry. The key itself never appears in the message.
 */
export function createAnthropicProvider(
  options: AnthropicProviderOptions,
): LLMProvider {
  const config: PinnedGenConfig = options.config ?? {
    modelId: ANTHROPIC_DEFAULT_MODEL_ID,
    temperature: 0,
    maxTokens: 8192,
    promptHash: "",
    promptVersion: "unpinned",
  };

  if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
    throw new GenerateInputError(
      "the Anthropic provider was created without an API key; supply one from the environment at the composition root",
    );
  }
  if (config.modelId.trim() === "") {
    throw new GenerateInputError(
      "the pinned generation config has a blank model id; a run that cannot name its model cannot be reproduced (DESIGN §12.3)",
    );
  }
  if (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0) {
    throw new GenerateInputError(
      `the pinned generation config has maxTokens ${config.maxTokens}; it must be a positive integer`,
    );
  }

  // Closure-scoped, and not a property of the returned object. Nothing that
  // inspects, serialises or logs the provider can reach it.
  const apiKey = options.apiKey;
  const url = `${options.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL}${ANTHROPIC_MESSAGES_PATH}`;

  return {
    name: "anthropic",
    config,
    async complete(
      request: GenerationRequest,
      signal: AbortSignal,
    ): Promise<ProviderCompletion> {
      const body: Record<string, unknown> = {
        model: config.modelId,
        max_tokens: config.maxTokens,
        // The instruction channel and ONLY the instruction channel (TM-2).
        system: request.prompt.instruction,
        // The data channel, fenced and labelled, in a user turn. The two are
        // never concatenated on the way out of this package.
        messages: [{ role: "user", content: request.prompt.data }],
      };
      if (modelAcceptsSamplingParams(config.modelId)) {
        body.temperature = config.temperature;
      }

      let response: ProviderFetchResponse;
      try {
        response = await options.fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": ANTHROPIC_VERSION_HEADER,
            "x-api-key": apiKey,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        // The cause is attached but the message is written here, so a transport
        // error carrying a URL with a query string cannot become the text a CI
        // annotation prints.
        throw new GenerationFaultError(
          "the request to the Anthropic Messages API did not complete",
          { cause: error },
        );
      }

      const raw = await response.text();
      if (!response.ok) {
        throw new GenerationFaultError(
          `the Anthropic Messages API answered ${response.status} (${errorTypeOf(raw)})`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new GenerationFaultError(
          "the Anthropic Messages API answered with a body that is not JSON",
          { cause: error },
        );
      }

      const stopReason = stringField(parsed, "stop_reason") ?? "unknown";
      if (stopReason === "refusal") {
        // Checked BEFORE the content is read: a refusal can carry an empty
        // content array, and "no text" must not be reported as "no tests".
        throw new GenerationFaultError(
          "the model declined to answer this generation request (stop_reason refusal); no specs were produced and none are being claimed",
        );
      }
      if (stopReason === "max_tokens") {
        throw new GenerationFaultError(
          `the model's answer was truncated at the ${config.maxTokens}-token limit; a half-written spec list is not a spec list`,
        );
      }

      const text = textOf(parsed);
      if (text === undefined) {
        throw new GenerationFaultError(
          `the Anthropic Messages API answered with no text content (stop_reason ${stopReason})`,
        );
      }

      return {
        text: untrusted(text),
        modelId: stringField(parsed, "model") ?? config.modelId,
        promptHash: config.promptHash,
        stopReason,
      };
    },
  };
}

// ── parsing the answer ──────────────────────────────────────────────────────

/**
 * The unwrap boundary for model output.
 *
 * The text is parsed as JSON and every field is validated rather than cast; the
 * only thing that leaves as a bare string is a `filename`, an `id` and a target
 * triple. Here each of them is refused if it carries a control, bidi or
 * zero-width character or runs past its cap (`./fieldSafety.ts`, review W7b
 * M1); `./quality.ts` repeats that check on the id, path and target triple
 * (its `unsafe-field` rule), and `./writer.ts` holds the filename to a
 * strict charset before anything is written. None of those checks is a
 * charset check on a target's `name`, which is free text by
 * design (a Script Include may be called anything) — the control-character
 * refusal is its only guard, and the CLI escapes it again at print time. The
 * `source` field never leaves unbranded — it goes straight back into
 * `untrusted()` and from there to the gate.
 */
const PARSE_BOUNDARY =
  "generation response parse — the answer is parsed as JSON and every field validated; `source` is immediately re-branded and reaches disk only through the gate and the DEV-4 writer (TM-1)";

/**
 * Pull the JSON object out of a completion.
 *
 * Three attempts, in order of how much they assume: the whole text, the inside
 * of a fenced code block, and the span between the first `{` and the last `}`.
 * Models wrap JSON in prose and in fences; refusing to cope with that would
 * turn a formatting habit into a pipeline outage. What is NOT done is repair —
 * no quote fixing, no trailing-comma removal. A body that needs mending is a
 * body nobody can reason about, and mending it silently converts a fault into a
 * plausible-looking answer.
 */
function extractJson(text: string): unknown {
  const attempts: string[] = [];
  const trimmed = text.trim();
  attempts.push(trimmed);

  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1] !== undefined) attempts.push(fence[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1));

  for (const attempt of attempts) {
    if (attempt === "") continue;
    try {
      return JSON.parse(attempt);
    } catch {
      continue;
    }
  }
  throw new GenerationFaultError(
    "the generation response did not contain a JSON object; no specs were parsed and an empty list would be a claim that none are needed",
  );
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isTestKind(value: unknown): value is TestKind {
  return typeof value === "string" && TEST_KINDS.some((kind) => kind === value);
}

/**
 * Turn a completion into candidates, or throw.
 *
 * Structural validation only — that the fields are present and of the right
 * type. Whether the values are any GOOD is `./quality.ts`'s question, and
 * whether the source is SAFE is `./gate.ts`'s; keeping the three apart is what
 * lets each of them be read on its own.
 *
 * @throws GenerationFaultError if the response is unparsable, malformed, or
 * carries no specs. The empty case is a throw for the reason in `./errors.ts`.
 */
export function parseCandidates(
  completion: ProviderCompletion,
): readonly GenerationCandidate[] {
  const parsed = extractJson(unwrapUntrusted(completion.text, PARSE_BOUNDARY));
  if (!isRecord(parsed) || !Array.isArray(parsed.specs)) {
    throw new GenerationFaultError(
      "the generation response has no `specs` array; the shape the prompt asked for is not what came back",
    );
  }

  const specs = parsed.specs as readonly unknown[];
  if (specs.length === 0) {
    throw new GenerationFaultError(
      "the generation response carried an empty `specs` array; that is a claim that nothing here is worth testing, and this package will not make it on a model's behalf (OPP-1b)",
    );
  }

  const candidates: GenerationCandidate[] = [];
  specs.forEach((value, index) => {
    if (!isRecord(value)) {
      throw new GenerationFaultError(
        `spec #${index + 1} in the generation response is not an object`,
      );
    }
    const { id, kind, filename, source } = value;
    if (!isNonBlank(id)) {
      throw new GenerationFaultError(
        `spec #${index + 1} in the generation response has no \`id\``,
      );
    }
    if (!isTestKind(kind)) {
      throw new GenerationFaultError(
        `spec #${index + 1} in the generation response has a \`kind\` outside ${TEST_KINDS.join(", ")}`,
      );
    }
    if (!isNonBlank(filename)) {
      throw new GenerationFaultError(
        `spec #${index + 1} in the generation response has no \`filename\``,
      );
    }
    if (typeof source !== "string") {
      throw new GenerationFaultError(
        `spec #${index + 1} in the generation response has no \`source\` string`,
      );
    }
    if (!Array.isArray(value.targets)) {
      throw new GenerationFaultError(
        `spec #${index + 1} in the generation response has no \`targets\` array`,
      );
    }
    // Delegated decision 2026-09-26 (W7b M1): refuse, with a constant message
    // that quotes none of the field, rather than strip. A stripped id is a
    // different id than the model wrote, and the message must not carry the
    // very bytes it is refusing to a terminal.
    if (
      !isSafeField(id, MAX_ID_CHARS) ||
      !isSafeField(filename, MAX_FILENAME_CHARS)
    ) {
      throw new GenerationFaultError(
        `spec #${index + 1} in the generation response has an \`id\` or \`filename\` with a control, bidi or zero-width character, or longer than its cap (${MAX_ID_CHARS}/${MAX_FILENAME_CHARS} chars)`,
      );
    }
    if (value.targets.length > MAX_TARGETS_PER_SPEC) {
      throw new GenerationFaultError(
        `spec #${index + 1} in the generation response names more than ${MAX_TARGETS_PER_SPEC} targets`,
      );
    }

    const targets: TargetArtifactRef[] = [];
    for (const target of value.targets as readonly unknown[]) {
      if (
        !isRecord(target) ||
        !isNonBlank(target.table) ||
        !isNonBlank(target.sysId) ||
        !isNonBlank(target.name)
      ) {
        throw new GenerationFaultError(
          `spec #${index + 1} in the generation response has a target without a non-blank table/sysId/name`,
        );
      }
      if (
        !isSafeField(target.table, MAX_TABLE_CHARS) ||
        !isSafeField(target.sysId, MAX_SYS_ID_CHARS) ||
        !isSafeField(target.name, MAX_TARGET_NAME_CHARS)
      ) {
        throw new GenerationFaultError(
          `spec #${index + 1} in the generation response has a target whose table/sysId/name carries a control, bidi or zero-width character, or is longer than its cap (${MAX_TABLE_CHARS}/${MAX_SYS_ID_CHARS}/${MAX_TARGET_NAME_CHARS} chars)`,
        );
      }
      targets.push({
        table: target.table,
        sysId: target.sysId,
        name: target.name,
      });
    }

    candidates.push({
      id,
      kind,
      filename,
      targets,
      source: untrusted(source),
    });
  });

  return candidates;
}
