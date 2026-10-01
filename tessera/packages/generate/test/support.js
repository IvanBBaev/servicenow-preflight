// Shared fixtures for the QA-12(a) quality bar and the `TestGenerator` adapter.
//
// Only `quality.test.js` and `generator.test.js` import this file, and the
// reasons each fixture exists are the reasons those two suites are worth
// reading.
//
// 1. `graphWith()` builds a WHOLE `ImpactGraph` — all four lists, always
//    present. Both units read all four (`graphTargetKeys` unions them,
//    `generationTargets` walks them in order), and a fixture that shipped only
//    `nodes` would let a regression in the other three go unnoticed by every
//    test that did not explicitly reach for them.
//
// 2. `source()` is the one branding door these suites use. Model output arrives
//    as `Untrusted<string>` (TM-1) and both units unwrap it through a named
//    boundary; a fixture that handed over a bare string would fail inside
//    `unwrapUntrusted` with a type error instead of exercising the unit, and
//    so would a fixture that hand-rolled the box `{ value }`: the door checks
//    provenance (a WeakSet of minted boxes), not shape.
//
// 3. The four stubs exist because of ARCH-1. `createAiTestGenerator` names no
//    collaborator — provider, gate, quality bar and writer all arrive as
//    arguments — so the only way to test the pipeline is to be the composition
//    root. Each stub records every call, so the suite can assert the ORDER and
//    the ARGUMENTS of the pipeline rather than only its return value, and each
//    takes a full behaviour override so a single test can make exactly one
//    collaborator misbehave.
//
// 4. `manualClock()` is why no test here touches the wall clock. The generator's
//    deadline is checked with an injected `now`, so a fifteen-minute budget is
//    exercised in microseconds and the timeout path is a fact rather than a
//    flake.

import { untrusted } from "@tessera/types";

export const RUN_ID = "run-2026-08-25-000042";

/**
 * A string that could only have come out of the model. Planted in a candidate
 * `source` so a suite can assert the negative that TM-1 is actually about: not
 * "the message is tidy" but "these exact bytes reached no error, no finding and
 * no summary". A marker nothing else could plausibly emit is the only way to
 * state that.
 */
export const CANARY = "canary-7f21-model-authored-never-print-this";

/** Deterministic 32-char hex sys_id from a label, so fixtures read as prose. */
export function sysId(label) {
  let hex = "";
  for (const ch of label) hex += ch.charCodeAt(0).toString(16).padStart(2, "0");
  return `${hex}${"0".repeat(32)}`.slice(0, 32);
}

/**
 * One `TargetArtifactRef`. `table`/`sysId`/`name` are separately overridable
 * because "missing exactly one of the three" is its own rule in both units —
 * `malformed-target` in the bar, and a dropped target in `generationTargets`.
 */
export function target(label, overrides = {}) {
  return {
    table: overrides.table ?? "sys_script",
    sysId: overrides.sysId ?? sysId(label),
    name: overrides.name ?? `Business Rule: ${label}`,
  };
}

/** An `ImpactEdge`. `via`/`confidence` are never inspected by either unit. */
export function edge(from, to) {
  return { from, to, via: "where_used", confidence: "high" };
}

/** A QA-9 entry: an artifact static analysis could not trace, but which counts. */
export function unanalyzed(artifact) {
  return { artifact, reason: "dynamic table name" };
}

/** A `PlannedSpec` for `graph.demanded`; only its `target` is read by either unit. */
export function demand(artifact, id = "demanded-1") {
  return {
    spec: { id, path: `tests/${id}.unit.ts` },
    kind: "unit",
    target: artifact,
  };
}

/**
 * An `ImpactGraph` whose `nodes` are the given targets, with the other three
 * lists empty unless a test says otherwise. Always complete: see the header.
 */
export function graphWith(targets, extras = {}) {
  return {
    nodes: targets,
    edges: extras.edges ?? [],
    unanalyzable: extras.unanalyzable ?? [],
    demanded: extras.demanded ?? [],
  };
}

/**
 * A `TestSpec`. Every field uses `??` and not `||` on purpose — a blank `id` and
 * a blank `path` are the inputs two of the fourteen rules exist to catch, and a
 * factory that helpfully replaced them would make those rules untestable.
 */
export function testSpec(fields = {}) {
  return {
    ref: {
      id: fields.id ?? "spec-1",
      path: fields.path ?? "generated/spec-1.unit.ts",
    },
    kind: fields.kind ?? "unit",
    targets: fields.targets ?? [target("spec-1")],
  };
}

/** The branding door: a model-authored body, marked as what it is (TM-1). */
export function source(text) {
  return untrusted(text);
}

/**
 * A body that asserts exactly once, non-trivially. The baseline every
 * single-rule test in `quality.test.js` is built on: a subject that breaks one
 * rule must be otherwise clean, or the test is not about the rule it names.
 */
export const ASSERTING_SOURCE = [
  "export function run(step) {",
  "  const record = step.getRecord();",
  '  assertEqual("the record is on the expected table", "incident", record.getTableName());',
  "}",
].join("\n");

/** A `QualitySubject`: the manifest binding plus the body it points at. */
export function subject(fields = {}) {
  return {
    spec: fields.spec ?? testSpec(fields),
    source: source(fields.source ?? ASSERTING_SOURCE),
  };
}

/** A `PipelineContext`; `signal` defaults to one that never aborts. */
export function makeCtx(options = {}) {
  return {
    runId: options.runId ?? RUN_ID,
    lifecycle: options.lifecycle ?? "ephemeral",
    coverageSource: "test",
    topology: {
      source: "source.service-now.com",
      runner: "dev12345.service-now.com",
      target: "dev12345.service-now.com",
    },
    signal: options.signal ?? new AbortController().signal,
  };
}

/** A signal that is already aborted — the ARCH-28 cancellation input. */
export function abortedSignal() {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

/**
 * An injectable clock. Nothing advances it but a test, so the generator's
 * deadline arithmetic is asserted exactly rather than raced.
 */
export function manualClock(startMs = 1_000_000) {
  let current = startMs;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

export const MODEL_ID = "stub-model/2026-08";

export const PINNED_CONFIG = {
  modelId: MODEL_ID,
  temperature: 0,
  maxTokens: 4_096,
  promptHash: "pinned-instruction-hash",
  promptVersion: "tessera-generate/1",
};

/**
 * One entry of the `specs` array a provider answers with — the wire shape
 * `parseCandidates` validates, not the parsed candidate.
 */
export function specPayload(fields = {}) {
  const label = fields.id ?? "sys_script.aa01.unit";
  return {
    id: label,
    kind: fields.kind ?? "unit",
    filename: fields.filename ?? `${label}.unit.ts`,
    targets: fields.targets ?? [target("candidate")],
    source: fields.source ?? ASSERTING_SOURCE,
  };
}

/** A `ProviderCompletion` carrying `specs` as the JSON the prompt asked for. */
export function completionOf(specs, overrides = {}) {
  return {
    text: source(overrides.text ?? JSON.stringify({ specs })),
    modelId: overrides.modelId ?? MODEL_ID,
    promptHash: overrides.promptHash ?? "provider-reported-hash",
    stopReason: overrides.stopReason ?? "end_turn",
  };
}

/**
 * The `LLMProvider` seam. Records the request and the signal it was handed, so
 * a suite can prove ARCH-28 propagation without a real abort ever firing.
 */
export function stubProvider(options = {}) {
  const calls = [];
  const specs = options.specs ?? [specPayload()];
  return {
    calls,
    name: options.name ?? "stub-provider",
    config: options.config ?? PINNED_CONFIG,
    async complete(request, signal) {
      calls.push({ request, signal });
      if (options.throws !== undefined) throw options.throws;
      if (options.complete !== undefined)
        return options.complete(request, signal);
      return completionOf(specs, options);
    },
  };
}

/** An `ok` gate verdict that hands the SAME branded value back — passing the
 * gate is not laundering, and a stub that re-branded would hide that. */
export function clearanceFor(inspected) {
  return {
    ok: true,
    cleared: { source: inspected, clearance: {}, lines: 4, characters: 120 },
  };
}

/** A rejecting verdict. `rule` and `line` are what the generator's message quotes. */
export function gateRejection(violations) {
  return { ok: false, violations };
}

/** The TM-3 gate seam. Clears everything unless `inspect` says otherwise. */
export function stubGate(options = {}) {
  const calls = [];
  return {
    calls,
    inspect(inspected) {
      calls.push(inspected);
      if (options.inspect !== undefined)
        return options.inspect(inspected, calls.length - 1);
      return clearanceFor(inspected);
    },
  };
}

/** The QA-12(a) seam. Passes everything unless `check` or `findings` says otherwise. */
export function stubQuality(options = {}) {
  const calls = [];
  return {
    calls,
    check(subjects, graph) {
      calls.push({ subjects, graph });
      if (options.check !== undefined) return options.check(subjects, graph);
      if (options.findings !== undefined) {
        return {
          ok: false,
          checked: subjects.length,
          findings: options.findings,
        };
      }
      return {
        ok: true,
        checked: subjects.length,
        assertions: subjects.length,
      };
    },
  };
}

/** The `ProposedWriteReport` shape, built around whatever `written` a test wants. */
export function writeReport(request, written) {
  return {
    proposedDir: `${request.testsRoot}/proposed`,
    manifestPath: `${request.testsRoot}/proposed/.manifest.proposed.json`,
    liveManifestPath: `${request.testsRoot}/.manifest.json`,
    written,
  };
}

/**
 * The DEV-4 writer seam — the only collaborator that would touch a real
 * filesystem, which is exactly why substituting it is what makes a whole-pipeline
 * test hermetic. Its default `path` is `proposed/<filename>`, the binding the
 * real writer makes and the one the generator now predicts for the quality bar
 * (review W7b, L1); a report binding a spec anywhere else is refused.
 */
export function stubWriter(options = {}) {
  const calls = [];
  return {
    calls,
    async write(request) {
      calls.push(request);
      if (options.throws !== undefined) throw options.throws;
      if (options.write !== undefined) return options.write(request);
      const written = request.specs.map((entry) => ({
        id: entry.candidate.id,
        path: `proposed/${entry.candidate.filename}`,
        absolutePath: `${request.testsRoot}/proposed/${entry.candidate.filename}`,
        bytes: 256,
        overwritten: false,
      }));
      return writeReport(request, options.written ?? written);
    },
  };
}
