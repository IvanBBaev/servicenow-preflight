// The `TestGenerator` port adapter — the stage `@tessera/core` declares and this
// package fills in.
//
// One property carries this whole suite: `generate` NEVER RETURNS AN EMPTY
// ARRAY. An empty spec list is a claim — "nothing in the impact graph is worth
// testing" — and downstream it is indistinguishable from a clean bill of health,
// so a provider outage that degraded into `[]` would report a green run over a
// change nobody tested (OPP-1b). Every failure this adapter can meet is
// therefore a throw, and the tests below walk the whole matrix one exit at a
// time. The umbrella test at the end restates it as one assertion, because the
// day somebody adds a sixteenth failure mode, that is the test that must fail.
//
// The second property is ARCH-1. The adapter names no collaborator: provider,
// gate, quality bar, writer and clock all arrive as arguments, and all five are
// validated at CONSTRUCTION rather than on the first call, so a composition root
// that forgot to wire the gate fails while it is being wired and not fifteen
// minutes into a pipeline with a provider bill already paid. Every test here is
// therefore written as the composition root, with stubs that record what they
// were handed — which lets the suite assert the pipeline's ORDER and ARGUMENTS
// and not merely its return value.
//
// Both judges run BEFORE the write (review W7b, L1). The gate, because unsafe
// text must not reach the filesystem; the quality bar, because a rejected batch
// written first replaced the previous review queue with one nobody asked for.
// The bar judges the PREDICTED binding, `proposed/<filename>`, and the write
// report is then checked against that prediction: a writer that bound a spec
// anywhere else is a fault, so the path judged is the path the manifest holds.
//
// Everything runs on an injected clock, so a fifteen-minute deadline is exercised
// in microseconds and the timeout path is a fact rather than a flake.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GENERATION_DEADLINE_MS,
  GenerateInputError,
  GenerationFaultError,
  buildGenerationPrompt,
  createAiTestGenerator,
  generationTargets,
  renderPrompt,
} from "../build/index.js";

import {
  ASSERTING_SOURCE,
  CANARY,
  MODEL_ID,
  abortedSignal,
  clearanceFor,
  completionOf,
  demand,
  edge,
  gateRejection,
  graphWith,
  makeCtx,
  manualClock,
  specPayload,
  stubGate,
  stubProvider,
  stubQuality,
  stubWriter,
  target,
  unanalyzed,
  writeReport,
} from "./support.js";

const TESTS_ROOT = "/repo/tests";

const TARGET_A = target("rule-a");
const GRAPH = graphWith([TARGET_A]);

/**
 * The composition root, as a function. Every collaborator defaults to a stub
 * that behaves, so a test overrides exactly the one it is about.
 */
function harness(overrides = {}) {
  const clock = overrides.clock ?? manualClock();
  const provider = overrides.provider ?? stubProvider();
  const gate = overrides.gate ?? stubGate();
  const quality = overrides.quality ?? stubQuality();
  const writer = overrides.writer ?? stubWriter();
  const generator = createAiTestGenerator({
    provider,
    gate,
    quality,
    writer,
    testsRoot: overrides.testsRoot ?? TESTS_ROOT,
    now: overrides.now ?? clock.now,
    ...(overrides.deadlineMs === undefined
      ? {}
      : { deadlineMs: overrides.deadlineMs }),
    ...(overrides.instruction === undefined
      ? {}
      : { instruction: overrides.instruction }),
  });
  return { generator, provider, gate, quality, writer, clock };
}

/** Reject with a named Tessera error, and say which one arrived when it is not. */
async function rejectsWith(promise, name, expected) {
  await assert.rejects(promise, (error) => {
    assert.equal(
      error.name,
      name,
      `expected ${name}, got ${error.name}: ${error.message}`,
    );
    if (expected !== undefined) assert.match(error.message, expected);
    return true;
  });
}

/** The one and only argument shape a construction test varies. */
function options(overrides = {}) {
  return {
    provider: stubProvider(),
    gate: stubGate(),
    quality: stubQuality(),
    writer: stubWriter(),
    testsRoot: TESTS_ROOT,
    ...overrides,
  };
}

describe("createAiTestGenerator — construction (ARCH-1)", () => {
  it("refuses to build without a provider", () => {
    // The composition root chooses what answers a prompt. A default wired in
    // here would mean a test that "injects a fake provider" was proving
    // something about a default it never replaced.
    assert.throws(
      () => createAiTestGenerator(options({ provider: undefined })),
      {
        name: "GenerateInputError",
      },
    );
    assert.throws(() => createAiTestGenerator(options({ provider: {} })), {
      name: "GenerateInputError",
    });
  });

  it("refuses to build without a code gate", () => {
    // TM-3: generated source is never written unreviewed by one.
    assert.throws(() => createAiTestGenerator(options({ gate: undefined })), {
      name: "GenerateInputError",
    });
    assert.throws(
      () => createAiTestGenerator(options({ gate: { inspect: "no" } })),
      { name: "GenerateInputError" },
    );
  });

  it("refuses to build without a quality bar", () => {
    // QA-12: a batch nothing judged is a batch that can assert nothing and pass.
    assert.throws(
      () => createAiTestGenerator(options({ quality: undefined })),
      {
        name: "GenerateInputError",
      },
    );
    assert.throws(() => createAiTestGenerator(options({ quality: {} })), {
      name: "GenerateInputError",
    });
  });

  it("refuses to build without a writer", () => {
    assert.throws(() => createAiTestGenerator(options({ writer: undefined })), {
      name: "GenerateInputError",
    });
    assert.throws(() => createAiTestGenerator(options({ writer: {} })), {
      name: "GenerateInputError",
    });
  });

  it("refuses to build without a usable tests root", () => {
    for (const testsRoot of [undefined, "", "   ", 7]) {
      assert.throws(
        () => createAiTestGenerator(options({ testsRoot })),
        { name: "GenerateInputError" },
        `testsRoot ${JSON.stringify(testsRoot)} was accepted`,
      );
    }
  });

  it("refuses a deadline that is not a positive number of milliseconds", () => {
    for (const deadlineMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createAiTestGenerator(options({ deadlineMs })),
        { name: "GenerateInputError" },
        `deadline ${String(deadlineMs)} was accepted`,
      );
    }
  });

  it("ships the documented fifteen-minute default budget", () => {
    // Same order as the ATF runner's per-run deadline, for the same reason:
    // generous enough that hitting it means something is wrong, not slow.
    assert.equal(DEFAULT_GENERATION_DEADLINE_MS, 900_000);
    assert.equal(DEFAULT_GENERATION_DEADLINE_MS, 15 * 60 * 1_000);
  });

  it("builds a `TestGenerator` when every collaborator is present", () => {
    const generator = createAiTestGenerator(options());
    assert.equal(typeof generator.generate, "function");
  });
});

describe("generate — the happy path", () => {
  it("calls the injected collaborators, in the documented order", async () => {
    // prompt → provider → parse → gate → quality bar → write → specs.
    const order = [];
    const provider = stubProvider({
      complete: async () => {
        order.push("provider");
        return completionOf([specPayload()]);
      },
    });
    const gate = stubGate({
      inspect: (inspected) => {
        order.push("gate");
        return clearanceFor(inspected);
      },
    });
    const writer = stubWriter({
      write: async (request) => {
        order.push("writer");
        return writeReport(
          request,
          request.specs.map((entry) => ({
            id: entry.candidate.id,
            path: `proposed/${entry.candidate.filename}`,
            absolutePath: `${request.testsRoot}/proposed/${entry.candidate.filename}`,
            bytes: 1,
            overwritten: false,
          })),
        );
      },
    });
    const quality = stubQuality({
      check: (subjects) => {
        order.push("quality");
        return { ok: true, checked: subjects.length, assertions: 1 };
      },
    });
    const { generator } = harness({ provider, gate, writer, quality });

    await generator.generate(makeCtx(), GRAPH, "unit");
    assert.deepEqual(order, ["provider", "gate", "quality", "writer"]);
  });

  it("hands the provider the rendered prompt, the kind, the targets and the signal", async () => {
    const { generator, provider } = harness();
    const ctx = makeCtx();
    await generator.generate(ctx, GRAPH, "unit");

    assert.equal(provider.calls.length, 1);
    const { request, signal } = provider.calls[0];
    // The prompt is the two-channel `RenderedPrompt` (TM-2); nothing rejoins it.
    assert.deepEqual(
      request.prompt,
      renderPrompt(buildGenerationPrompt("unit", GRAPH)),
    );
    assert.equal(request.kind, "unit");
    assert.deepEqual(request.targets, generationTargets(GRAPH));
    // ARCH-28: the run's own signal, so a cancelled pipeline cancels the call
    // in flight rather than only its aftermath.
    assert.equal(signal, ctx.signal);
  });

  it("lets the instruction override reach the prompt and change its hash", async () => {
    // For pinning an older prompt while reproducing a past run — which only
    // works if the override is actually what gets rendered and hashed.
    const instruction = "Pinned instruction from an earlier release.";
    const { generator, provider, writer } = harness({ instruction });
    await generator.generate(makeCtx(), GRAPH, "unit");

    const expected = renderPrompt(
      buildGenerationPrompt("unit", GRAPH, instruction),
    );
    assert.deepEqual(provider.calls[0].request.prompt, expected);
    assert.equal(writer.calls[0].provenance.promptHash, expected.promptHash);
    assert.notEqual(
      expected.promptHash,
      renderPrompt(buildGenerationPrompt("unit", GRAPH)).promptHash,
    );
  });

  it("inspects every candidate body with the gate before anything is written", async () => {
    const { generator, gate, writer } = harness({
      provider: stubProvider({
        specs: [
          specPayload({ id: "a", filename: "a.unit.ts" }),
          specPayload({ id: "b", filename: "b.unit.ts" }),
        ],
      }),
    });
    await generator.generate(makeCtx(), GRAPH, "unit");
    assert.equal(gate.calls.length, 2, "a candidate reached disk ungated");
    assert.equal(writer.calls[0].specs.length, 2);
    // The writer receives the gate's clearance token, not a bare source: writing
    // an uninspected body is a compile error rather than a review comment.
    for (const entry of writer.calls[0].specs) {
      assert.notEqual(entry.cleared, undefined);
    }
  });

  it("records the provenance a reviewer needs to trace the batch", async () => {
    const { generator, writer, provider } = harness();
    await generator.generate(
      makeCtx({ runId: "run-provenance" }),
      GRAPH,
      "unit",
    );

    const rendered = renderPrompt(buildGenerationPrompt("unit", GRAPH));
    assert.deepEqual(writer.calls[0].provenance, {
      runId: "run-provenance",
      generator: provider.name,
      modelId: MODEL_ID,
      promptHash: rendered.promptHash,
      promptVersion: rendered.promptVersion,
    });
    assert.equal(writer.calls[0].testsRoot, TESTS_ROOT);
  });

  it("records the FULL prompt hash, not the pinned instruction hash", async () => {
    // The field exists so a past batch can be reproduced, and the data channel
    // is half of what produced it. Pinning the instruction alone would pin
    // nothing, because the data changes every run by definition.
    const { generator, writer } = harness();
    await generator.generate(makeCtx(), GRAPH, "unit");

    const rendered = renderPrompt(buildGenerationPrompt("unit", GRAPH));
    const recorded = writer.calls[0].provenance.promptHash;
    assert.equal(recorded, rendered.promptHash);
    assert.notEqual(recorded, rendered.instructionHash);
    // Nor is it the hash the provider volunteered, or the one pinned in its
    // config — both of those describe a different thing.
    assert.notEqual(recorded, "provider-reported-hash");
    assert.notEqual(recorded, "pinned-instruction-hash");
  });

  it("refuses a write report that binds a spec to a path the quality bar did not judge", async () => {
    // Review W7b, L1: the bar judges `proposed/<filename>` before the write,
    // so a writer that bound the spec elsewhere wrote a manifest the bar never
    // saw. That is a fault, and the message names neither id nor path (TM-1).
    const surprising = "proposed/2026/renamed-by-the-writer.unit.ts";
    const { generator } = harness({
      writer: stubWriter({
        write: async (request) =>
          writeReport(
            request,
            request.specs.map((entry) => ({
              id: entry.candidate.id,
              path: surprising,
              absolutePath: `${request.testsRoot}/${surprising}`,
              bytes: 1,
              overwritten: false,
            })),
          ),
      }),
    });
    await assert.rejects(
      generator.generate(makeCtx(), GRAPH, "unit"),
      (error) => {
        assert.equal(error.name, "GenerationFaultError");
        assert.match(
          error.message,
          /different path than the one the quality bar judged/,
        );
        assert.equal(error.message.includes(surprising), false);
        return true;
      },
    );
  });

  it("builds each returned spec from the write report and its own candidate", async () => {
    const targets = [target("bound")];
    const { generator } = harness({
      provider: stubProvider({
        specs: [
          specPayload({ id: "spec-one", filename: "one.unit.ts", targets }),
        ],
      }),
    });
    const specs = await generator.generate(makeCtx(), GRAPH, "unit");
    assert.deepEqual(specs, [
      {
        ref: { id: "spec-one", path: "proposed/one.unit.ts" },
        kind: "unit",
        targets,
      },
    ]);
  });

  it("hands the quality bar the written specs and the graph they came from", async () => {
    // QA-16 joins on the declared link, so the bar has to see the same binding
    // the manifest will hold — and the same graph, to tell a grounded target
    // from an invented one.
    const { generator, quality } = harness({
      provider: stubProvider({
        specs: [specPayload({ id: "spec-one", filename: "one.unit.ts" })],
      }),
    });
    await generator.generate(makeCtx(), GRAPH, "unit");

    assert.equal(quality.calls.length, 1);
    const { subjects, graph } = quality.calls[0];
    assert.equal(graph, GRAPH);
    assert.equal(subjects.length, 1);
    assert.equal(subjects[0].spec.ref.id, "spec-one");
    assert.equal(subjects[0].spec.ref.path, "proposed/one.unit.ts");
    // Still branded. Passing the gate did not launder it (TM-1).
    assert.equal(typeof subjects[0].source, "object");
  });
});

describe("generate — GenerateInputError: the request is malformed", () => {
  it("refuses a kind no runner claims", async () => {
    const { generator, provider } = harness();
    for (const kind of ["smoke", "", undefined, 3]) {
      await rejectsWith(
        generator.generate(makeCtx(), GRAPH, kind),
        "GenerateInputError",
        /unsupported test kind/,
      );
    }
    assert.equal(provider.calls.length, 0, "a bad kind reached the provider");
  });

  it("refuses a missing impact graph", async () => {
    const { generator } = harness();
    for (const graph of [undefined, null, "not-a-graph"]) {
      await rejectsWith(
        generator.generate(makeCtx(), graph, "unit"),
        "GenerateInputError",
        /impact graph is missing/,
      );
    }
  });

  it("refuses a graph that names no usable artifact", async () => {
    // An input error, not an empty result. A graph with nothing to bind to is a
    // stage that should not have been called, and the caller can see that from
    // its own input — whereas `[]` returned from here is indistinguishable from
    // "the model found nothing worth testing" (OPP-1b).
    const { generator, provider } = harness();
    await rejectsWith(
      generator.generate(makeCtx(), graphWith([]), "unit"),
      "GenerateInputError",
      /names no artifact/,
    );
    await rejectsWith(
      generator.generate(
        makeCtx(),
        graphWith([
          { table: "sys_script", sysId: "", name: "no sys_id" },
          { table: "", sysId: "abc", name: "no table" },
          { table: "sys_script", sysId: "abc", name: "  " },
        ]),
        "unit",
      ),
      "GenerateInputError",
      /names no artifact/,
    );
    assert.equal(provider.calls.length, 0);
  });

  it("CURRENT BEHAVIOUR: a graph object with no lists at all throws a TypeError", async () => {
    // Documented here rather than asserted as correct. `checkGenerationQuality`
    // deliberately tolerates a graph that omits a list (`listOf` treats a
    // missing one as empty, so a hand-written fixture cannot crash the bar),
    // but `generationTargets` iterates `graph.nodes` directly. The result is
    // that `{}` — which passes the adapter's own `typeof graph === "object"`
    // guard — escapes as a raw `TypeError` instead of the `GenerateInputError`
    // every other malformed-graph shape produces. Reported, not fixed.
    const { generator } = harness();
    await assert.rejects(generator.generate(makeCtx(), {}, "unit"), {
      name: "TypeError",
    });
  });
});

describe("generate — GenerationFaultError: the environment failed", () => {
  it("refuses to start once the run has been cancelled", async () => {
    // A throw and not an early `[]`: an aborted run has learned nothing about
    // the change, and "no tests needed" is not something an interrupted
    // generator is in a position to say (ARCH-28).
    const { generator, provider } = harness();
    await rejectsWith(
      generator.generate(makeCtx({ signal: abortedSignal() }), GRAPH, "unit"),
      "GenerationFaultError",
      /cancelled before the prompt was built/,
    );
    assert.equal(provider.calls.length, 0);
  });

  it("refuses to write a batch whose run was cancelled while the model answered", async () => {
    // The second checkpoint, and the one that matters most: a completion that
    // arrives after the run moved on must not drop files into `proposed/` and a
    // review queue belonging to a different attempt.
    const controller = new AbortController();
    const provider = stubProvider({
      complete: async () => {
        controller.abort();
        return completionOf([specPayload()]);
      },
    });
    const { generator, writer, gate } = harness({ provider });
    await rejectsWith(
      generator.generate(makeCtx({ signal: controller.signal }), GRAPH, "unit"),
      "GenerationFaultError",
      /cancelled before the batch was written/,
    );
    assert.equal(gate.calls.length, 1, "the gate should still have run");
    assert.equal(writer.calls.length, 0, "a cancelled batch reached disk");
  });

  it("wraps a provider failure and keeps its text out of the message", async () => {
    // An arbitrary provider's error text is not something this package has
    // cleared for a log, and a transport error routinely carries a URL. The
    // cause is attached; the message is written here.
    const upstream = new Error(`connection reset while fetching ${CANARY}`);
    const { generator, writer } = harness({
      provider: stubProvider({ throws: upstream }),
    });
    await assert.rejects(
      generator.generate(makeCtx(), GRAPH, "unit"),
      (error) => {
        assert.equal(error.name, "GenerationFaultError");
        assert.match(error.message, /did not complete the generation request/);
        assert.match(error.message, /stub-provider/);
        assert.equal(error.message.includes(CANARY), false, error.message);
        assert.equal(error.cause, upstream, "the cause was not attached");
        return true;
      },
    );
    assert.equal(writer.calls.length, 0);
  });

  it("lets a Tessera error from the provider through unchanged", async () => {
    // A provider that already speaks this package's vocabulary has said
    // something specific; re-wrapping it would bury the sentence a caller needs.
    // Built through the real constructors, so `instanceof` is what decides.
    for (const Ctor of [GenerateInputError, GenerationFaultError]) {
      const thrown = new Ctor("the provider refused the request");
      const { generator } = harness({
        provider: stubProvider({ throws: thrown }),
      });
      await assert.rejects(
        generator.generate(makeCtx(), GRAPH, "unit"),
        (error) => {
          assert.equal(error, thrown, "the error was re-wrapped");
          return true;
        },
      );
    }
  });

  it("refuses a completion the model cut off", async () => {
    // The dangerous case is the one that still parses: the last spec vanishes
    // mid-file and what is left looks like a complete, smaller batch.
    for (const stopReason of ["max_tokens", "length", "stop_sequence_limit"]) {
      const { generator, gate } = harness({
        provider: stubProvider({ stopReason }),
      });
      await rejectsWith(
        generator.generate(makeCtx(), GRAPH, "unit"),
        "GenerationFaultError",
        /stopped early/,
      );
      assert.equal(gate.calls.length, 0, `${stopReason} reached the gate`);
    }
  });

  it("accepts the stop reasons that mean the answer finished", async () => {
    for (const stopReason of ["end_turn", "stop_sequence", "tool_use"]) {
      const { generator } = harness({ provider: stubProvider({ stopReason }) });
      const specs = await generator.generate(makeCtx(), GRAPH, "unit");
      assert.equal(specs.length, 1, `${stopReason} was treated as truncation`);
    }
  });

  it("discards the WHOLE batch over one gate violation", async () => {
    // A batch is one answer to one prompt. Keeping the specs that happened to
    // pass would promote a partial answer to a complete one while quietly
    // dropping coverage of whatever the rejected specs were aimed at.
    const gate = stubGate({
      inspect: (inspected, index) =>
        index === 1
          ? gateRejection([
              {
                rule: "eval-call",
                category: "execution",
                line: 7,
                detail: "x",
              },
              {
                rule: "network-call",
                category: "egress",
                line: 9,
                detail: "y",
              },
            ])
          : clearanceFor(inspected),
    });
    const { generator, writer } = harness({
      gate,
      provider: stubProvider({
        specs: [
          specPayload({ id: "a", filename: "a.unit.ts" }),
          specPayload({ id: "b", filename: "b.unit.ts" }),
        ],
      }),
    });
    await assert.rejects(
      generator.generate(makeCtx(), GRAPH, "unit"),
      (error) => {
        assert.equal(error.name, "GenerationFaultError");
        assert.match(error.message, /rejected 1 of 2 generated specs/);
        // Rule names and a LINE NUMBER: a reviewer opens the file in `proposed/`
        // and looks, rather than having the offending text follow them into a
        // chat notification.
        assert.match(error.message, /spec #2: eval-call@7 network-call@9/);
        return true;
      },
    );
    assert.equal(writer.calls.length, 0, "a rejected batch reached disk");
  });

  it("refuses an answer that arrived after the deadline, by the injected clock", async () => {
    // Not a request timeout — `ctx.signal` cancels the call in flight. This is
    // the check on the way back, and it is driven by an injected `now` so the
    // wall clock never decides whether this test passes.
    const clock = manualClock();
    const { generator, writer } = harness({
      clock,
      deadlineMs: 1_000,
      provider: stubProvider({
        complete: async () => {
          clock.advance(1_001);
          return completionOf([specPayload()]);
        },
      }),
    });
    await rejectsWith(
      generator.generate(makeCtx(), GRAPH, "unit"),
      "GenerationFaultError",
      /took 1001ms, past the 1000ms deadline/,
    );
    assert.equal(writer.calls.length, 0, "a late batch reached disk");
  });

  it("accepts an answer that lands exactly on the deadline", async () => {
    // The comparison is `>`, not `>=`: a budget that rejected its own last
    // millisecond would be a budget nobody could describe honestly.
    const clock = manualClock();
    const { generator } = harness({
      clock,
      deadlineMs: 1_000,
      provider: stubProvider({
        complete: async () => {
          clock.advance(1_000);
          return completionOf([specPayload()]);
        },
      }),
    });
    assert.equal(
      (await generator.generate(makeCtx(), GRAPH, "unit")).length,
      1,
    );
  });

  it("refuses a write report describing a spec it never sent", async () => {
    // The report is the only evidence the proposed manifest matches this run.
    // An id that was not in the batch means it does not.
    const { generator } = harness({
      writer: stubWriter({
        write: async (request) =>
          writeReport(request, [
            {
              id: "an-id-from-another-run",
              path: "proposed/other.unit.ts",
              absolutePath: `${request.testsRoot}/proposed/other.unit.ts`,
              bytes: 1,
              overwritten: false,
            },
          ]),
      }),
    });
    await rejectsWith(
      generator.generate(makeCtx(), GRAPH, "unit"),
      "GenerationFaultError",
      /\/repo\/tests\/proposed\/\.manifest\.proposed\.json does not describe this run/,
    );
  });

  it("refuses a write report that names one spec twice (W7b L1)", async () => {
    const { generator } = harness({
      writer: stubWriter({
        write: async (request) => {
          const entry = request.specs[0];
          const ref = {
            id: entry.candidate.id,
            path: `proposed/${entry.candidate.filename}`,
            absolutePath: `${request.testsRoot}/proposed/${entry.candidate.filename}`,
            bytes: 1,
            overwritten: false,
          };
          return writeReport(request, [ref, { ...ref }]);
        },
      }),
    });
    await rejectsWith(
      generator.generate(makeCtx(), GRAPH, "unit"),
      "GenerationFaultError",
      /does not describe this run/,
    );
  });

  it("hands the writer a sanitised model id, never the raw one (W7b M1)", async () => {
    const raw = `model${String.fromCharCode(0x202e)}-x${String.fromCharCode(0x1b)}[2J`;
    const { generator, writer } = harness({
      provider: stubProvider({ modelId: raw }),
    });
    await generator.generate(makeCtx(), GRAPH, "unit");
    assert.equal(writer.calls[0].provenance.modelId, "model-x[2J");
  });

  it("fails a batch the quality bar rejected — before writing it (W7b L1)", async () => {
    // A rejected batch is not written: writing it first replaced the previous
    // review queue with a batch nobody asked for.
    const { generator, writer } = harness({
      quality: stubQuality({
        findings: [
          { rule: "no-assertion", position: 1, specId: "a", detail: "d" },
          { rule: "no-assertion", position: 2, specId: "b", detail: "d" },
          { rule: "blank-id", position: 3, specId: "", detail: "d" },
        ],
      }),
    });
    await assert.rejects(
      generator.generate(makeCtx(), GRAPH, "unit"),
      (error) => {
        assert.equal(error.name, "GenerationFaultError");
        assert.match(error.message, /failed the quality bar with 3 findings/);
        assert.match(error.message, /blank-id \(1\), no-assertion \(2\)/);
        assert.match(error.message, /nothing was written/);
        assert.match(error.message, /\/repo\/tests is unchanged/);
        return true;
      },
    );
    assert.equal(writer.calls.length, 0, "a rejected batch reached the writer");
  });

  it("refuses a write report that is missing a spec it was given", async () => {
    // A writer stub that reports nothing written. The binding check refuses it
    // before the (still kept) empty-batch guard is reached; either way the
    // function never returns `[]`.
    const { generator, quality } = harness({
      writer: stubWriter({
        write: async (request) => writeReport(request, []),
      }),
    });
    await rejectsWith(
      generator.generate(makeCtx(), GRAPH, "unit"),
      "GenerationFaultError",
      /reported 0 of the 1 specs/,
    );
    assert.equal(quality.calls[0].subjects.length, 1);
  });

  it("refuses a completion that carried no specs at all", async () => {
    for (const text of ['{"specs":[]}', "not json at all", '{"other":1}']) {
      const { generator } = harness({ provider: stubProvider({ text }) });
      await rejectsWith(
        generator.generate(makeCtx(), GRAPH, "unit"),
        "GenerationFaultError",
      );
    }
  });
});

describe("generate — it never answers with an empty array", () => {
  it("throws on every failing path and returns a non-empty list on the good one", async () => {
    // The property restated as one assertion. An empty spec list is a claim
    // that nothing in the impact graph needs testing; downstream it reads as a
    // clean bill of health, which is the most dangerous wrong answer this
    // component can give (OPP-1b). If a sixteenth failure mode is ever added
    // that returns `[]`, this is the test that must go red.
    const scenarios = [
      [
        "unknown kind",
        () => harness().generator.generate(makeCtx(), GRAPH, "x"),
      ],
      [
        "missing graph",
        () => harness().generator.generate(makeCtx(), null, "unit"),
      ],
      [
        "no usable target",
        () => harness().generator.generate(makeCtx(), graphWith([]), "unit"),
      ],
      [
        "cancelled run",
        () =>
          harness().generator.generate(
            makeCtx({ signal: abortedSignal() }),
            GRAPH,
            "unit",
          ),
      ],
      [
        "provider fault",
        () =>
          harness({
            provider: stubProvider({ throws: new Error("boom") }),
          }).generator.generate(makeCtx(), GRAPH, "unit"),
      ],
      [
        "truncated answer",
        () =>
          harness({
            provider: stubProvider({ stopReason: "max_tokens" }),
          }).generator.generate(makeCtx(), GRAPH, "unit"),
      ],
      [
        "empty specs array",
        () =>
          harness({
            provider: stubProvider({ text: '{"specs":[]}' }),
          }).generator.generate(makeCtx(), GRAPH, "unit"),
      ],
      [
        "gate violation",
        () =>
          harness({
            gate: stubGate({
              inspect: () =>
                gateRejection([
                  {
                    rule: "eval-call",
                    category: "execution",
                    line: 1,
                    detail: "d",
                  },
                ]),
            }),
          }).generator.generate(makeCtx(), GRAPH, "unit"),
      ],
      [
        "quality rejection",
        () =>
          harness({
            quality: stubQuality({
              findings: [
                { rule: "no-assertion", position: 1, specId: "a", detail: "d" },
              ],
            }),
          }).generator.generate(makeCtx(), GRAPH, "unit"),
      ],
      [
        "nothing written",
        () =>
          harness({
            writer: stubWriter({
              write: async (request) => writeReport(request, []),
            }),
          }).generator.generate(makeCtx(), GRAPH, "unit"),
      ],
      [
        "writer fault",
        () =>
          harness({
            writer: stubWriter({ throws: new Error("disk full") }),
          }).generator.generate(makeCtx(), GRAPH, "unit"),
      ],
    ];

    for (const [name, run] of scenarios) {
      let returned;
      await assert.rejects(
        (async () => {
          returned = await run();
        })(),
        (error) => {
          assert.ok(error instanceof Error, `${name} threw a non-Error`);
          return true;
        },
        `${name} resolved instead of throwing`,
      );
      assert.equal(returned, undefined, `${name} produced a value`);
    }

    const specs = await harness().generator.generate(makeCtx(), GRAPH, "unit");
    assert.ok(specs.length > 0, "the happy path returned an empty batch");
  });
});

describe("TM-1 — no model-authored byte reaches an error message", () => {
  it("keeps the canary out of every failure the pipeline can report", async () => {
    // Errors here carry counts, rule names and file paths only. The canary is
    // planted in the candidate body the provider answers with, which is exactly
    // the string a naive message would quote back into a log, a CI annotation
    // and a chat notification.
    const poisoned = [
      specPayload({
        id: `spec-${CANARY}`,
        filename: `${CANARY}.unit.ts`,
        source: `${ASSERTING_SOURCE}\n// ${CANARY}\n`,
      }),
    ];
    const failures = [
      [
        "gate violation",
        {
          provider: stubProvider({ specs: poisoned }),
          gate: stubGate({
            inspect: () =>
              gateRejection([
                {
                  rule: "eval-call",
                  category: "execution",
                  line: 4,
                  detail: CANARY,
                },
              ]),
          }),
        },
      ],
      [
        "quality rejection",
        {
          provider: stubProvider({ specs: poisoned }),
          quality: stubQuality({
            findings: [
              {
                rule: "no-assertion",
                position: 1,
                specId: CANARY,
                detail: CANARY,
              },
            ],
          }),
        },
      ],
      [
        "writer mismatch",
        {
          provider: stubProvider({ specs: poisoned }),
          writer: stubWriter({
            write: async (request) =>
              writeReport(request, [
                {
                  id: "unknown",
                  path: "proposed/x.unit.ts",
                  absolutePath: "/repo/tests/proposed/x.unit.ts",
                  bytes: 1,
                  overwritten: false,
                },
              ]),
          }),
        },
      ],
      [
        "truncated answer",
        {
          provider: stubProvider({ specs: poisoned, stopReason: "max_tokens" }),
        },
      ],
    ];

    for (const [name, overrides] of failures) {
      await assert.rejects(
        harness(overrides).generator.generate(makeCtx(), GRAPH, "unit"),
        (error) => {
          assert.equal(
            error.message.includes(CANARY),
            false,
            `${name} leaked model output: ${error.message}`,
          );
          return true;
        },
      );
    }
  });

  it("keeps the canary out of the deadline message too", async () => {
    const clock = manualClock();
    await assert.rejects(
      harness({
        clock,
        deadlineMs: 1,
        provider: stubProvider({
          specs: [specPayload({ source: `// ${CANARY}\nassert(ok);` })],
          complete: async () => {
            clock.advance(500);
            return completionOf([specPayload({ source: `// ${CANARY}` })]);
          },
        }),
      }).generator.generate(makeCtx(), GRAPH, "unit"),
      (error) => {
        assert.match(error.message, /past the 1ms deadline/);
        assert.equal(error.message.includes(CANARY), false, error.message);
        return true;
      },
    );
  });
});

describe("generationTargets", () => {
  it("walks the graph in order: nodes, edge endpoints, unanalyzable, demanded", async () => {
    // `unanalyzable` is in the list on purpose. An artifact static analysis
    // could not trace is still impacted, is still in the QA-15 floor's
    // denominator, and is precisely the part of a change a human is least able
    // to reason about — leaving it out would aim the generator at the easy half
    // of its own input (QA-9).
    const node = target("node");
    const from = target("from");
    const to = target("to");
    const opaque = target("opaque");
    const wanted = target("wanted");
    const graph = graphWith([node], {
      edges: [edge(from, to)],
      unanalyzable: [unanalyzed(opaque)],
      demanded: [demand(wanted)],
    });
    assert.deepEqual(
      generationTargets(graph).map((entry) => entry.sysId),
      [node, from, to, opaque, wanted].map((entry) => entry.sysId),
    );
  });

  it("deduplicates by table and sys_id, ignoring case, whitespace and name", () => {
    // The same record described in different words is one target. Keeping both
    // would ask the model for two tests over one artifact and inflate the
    // coverage denominator with a duplicate.
    const node = target("node");
    const restated = {
      table: node.table.toUpperCase(),
      sysId: ` ${node.sysId.toUpperCase()} `,
      name: "the same record, described differently",
    };
    const targets = generationTargets(
      graphWith([node, restated], { edges: [edge(node, restated)] }),
    );
    assert.equal(targets.length, 1);
    // First seen wins, so the graph's own node is what the prompt describes.
    assert.deepEqual(targets[0], node);
  });

  it("drops a target missing any of table, sys_id or name", () => {
    // A target the model cannot name is a target it cannot describe a test for,
    // and `@tessera/specs` drops the whole entry over it. Filling in a
    // placeholder would launder a defect in the analysis into a spec.
    const targets = generationTargets(
      graphWith([
        { table: "", sysId: "a1", name: "no table" },
        { table: "sys_script", sysId: "  ", name: "no sys_id" },
        { table: "sys_script", sysId: "a1", name: "" },
        null,
        "not-a-record",
        7,
      ]),
    );
    assert.deepEqual(targets, []);
  });

  it("returns a defensive copy shaped as plain refs, not the graph's objects", () => {
    // Each entry is rebuilt from its three fields, so a node carrying extra
    // instance-derived properties cannot ride along into the prompt request.
    const [only] = generationTargets(
      graphWith([{ ...TARGET_A, secretColumn: "instance data" }]),
    );
    assert.deepEqual(Object.keys(only).sort(), ["name", "sysId", "table"]);
  });

  it("joins the two halves of an identity with a separator neither can contain", () => {
    // The dedup key is `table` + separator + `sysId`. A separator that can occur
    // inside either half would make `a b`/`c` and `a`/`b c` one key — two
    // different artifacts silently collapsed into one, which loses a target from
    // the batch and from the QA-15 denominator without anything reporting it.
    // Both halves here contain a space, so a space separator fails this test.
    const collidable = generationTargets(
      graphWith([
        { table: "a b", sysId: "c", name: "first" },
        { table: "a", sysId: "b c", name: "second" },
      ]),
    );
    assert.equal(collidable.length, 2);
    assert.deepEqual(
      collidable.map((entry) => entry.name),
      ["first", "second"],
    );
  });
});

describe("determinism", () => {
  it("produces the same specs from the same inputs, twice", async () => {
    const first = await harness().generator.generate(makeCtx(), GRAPH, "unit");
    const second = await harness().generator.generate(makeCtx(), GRAPH, "unit");
    assert.deepEqual(first, second);
  });

  it("reads the injected clock exactly twice and never a real timer", async () => {
    // Once to open the budget, once to close it. A third read would mean some
    // step started measuring something the deadline does not describe.
    let reads = 0;
    const { generator } = harness({
      now: () => {
        reads += 1;
        return 5_000;
      },
    });
    await generator.generate(makeCtx(), GRAPH, "unit");
    assert.equal(reads, 2);
  });

  it("falls back to the wall clock only when no clock is injected", async () => {
    // The default exists; the budget it measures against is fifteen minutes, so
    // a sub-millisecond hermetic run can never trip it.
    const generator = createAiTestGenerator(options());
    const specs = await generator.generate(makeCtx(), GRAPH, "unit");
    assert.equal(specs.length, 1);
  });
});
