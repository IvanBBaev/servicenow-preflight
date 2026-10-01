// The ARCH-5 composite — PLAN Phase 2.
//
// Everything here runs against hand-written stub `SourceResolver`s. What is
// under test is the merge contract and nothing else: which artifact survives a
// tie, whose label it keeps, which notes come out in which order, and which
// inputs are refused before an adapter is ever touched. Wiring the real story
// and scope adapters in would only add ways for these assertions to pass (or
// fail) for reasons that have nothing to do with the composite.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ResolutionFaultError,
  ResolutionInputError,
  createCompositeResolver,
  isIncomplete,
} from "../build/index.js";

const CTX = {
  runId: "run-composite-1",
  lifecycle: "ephemeral",
  coverageSource: "atf",
  topology: { source: "dev", runner: "test", target: "prod" },
  signal: new AbortController().signal,
};

const INCLUDE = {
  table: "sys_script_include",
  sysId: "aaaa0000000000000000000000000001",
  name: "TesseraUtils",
};

const RULE = {
  table: "sys_script",
  sysId: "bbbb0000000000000000000000000002",
  name: "Tessera demo rule",
};

const POLICY = {
  table: "sys_ui_policy",
  sysId: "cccc0000000000000000000000000003",
  name: "Tessera demo policy",
};

const found = (ref, resolvedBy) => ({ ref, resolvedBy });

/**
 * A canned `SourceResolver`. `calls` records every `(ctx, input)` pair it was
 * handed — by identity, so the pass-through test can assert that the composite
 * forwarded the caller's objects rather than a reconstruction of them.
 */
function stub(source, { artifacts = [], notes = [], throws } = {}) {
  const calls = [];
  const resolveWithReport = (ctx, input) => {
    calls.push({ ctx, input });
    if (throws !== undefined) return Promise.reject(throws);
    return Promise.resolve({ artifacts, notes });
  };
  return {
    source,
    calls,
    resolveWithReport,
    resolve: (ctx, input) =>
      resolveWithReport(ctx, input).then((report) => [...report.artifacts]),
  };
}

const note = (source, level, message) => ({ source, level, message });

describe("createCompositeResolver — refusals", () => {
  it("refuses --update-set before any adapter runs", async () => {
    const story = stub("story");
    const scope = stub("scope");
    const composite = createCompositeResolver([story, scope]);

    await assert.rejects(
      composite.resolveWithReport(CTX, {
        story: "STRY0010001",
        updateSet: "dddd0000000000000000000000000004",
      }),
      (error) => {
        assert.ok(error instanceof ResolutionInputError);
        assert.match(error.message, /--update-set is not supported/);
        // The message has to name what the user CAN pass; otherwise the only
        // route from the refusal to a working command is the design doc.
        assert.match(error.message, /--story/);
        assert.match(error.message, /--scope/);
        return true;
      },
    );

    // The point of refusing early: an update-set run must not half-happen.
    assert.deepEqual(story.calls, []);
    assert.deepEqual(scope.calls, []);
  });

  it("refuses an input that names nothing", async () => {
    const story = stub("story");
    const composite = createCompositeResolver([story]);

    await assert.rejects(
      composite.resolveWithReport(CTX, {}),
      ResolutionInputError,
    );
    assert.deepEqual(story.calls, []);
  });

  it("treats a blank flag value as naming nothing", async () => {
    const story = stub("story");
    const composite = createCompositeResolver([story]);

    // `--story "$UNSET"` named no story; resolving the empty string would send
    // the adapter looking for a record that cannot exist.
    await assert.rejects(
      composite.resolveWithReport(CTX, { story: "   ", scope: "" }),
      ResolutionInputError,
    );
    assert.deepEqual(story.calls, []);

    // A blank --update-set is the same non-input, so it does not trip the
    // deferral refusal while a real subject is named.
    const report = await composite.resolveWithReport(CTX, {
      story: "STRY0010001",
      updateSet: "",
    });
    assert.equal(story.calls.length, 1);
    assert.deepEqual(report.artifacts, []);
  });

  it("refuses an empty resolver list at construction", () => {
    // Construction, not resolve(): the mistake is in the wiring, so the throw
    // belongs where the list was built and not one call site later.
    assert.throws(() => createCompositeResolver([]), ResolutionInputError);
  });
});

describe("createCompositeResolver — union and precedence", () => {
  it("unions disjoint adapters in adapter order", async () => {
    const story = stub("story", {
      artifacts: [found(INCLUDE, "story"), found(RULE, "story")],
    });
    const scope = stub("scope", { artifacts: [found(POLICY, "scope")] });
    const composite = createCompositeResolver([story, scope]);

    const report = await composite.resolveWithReport(CTX, {
      story: "STRY0010001",
      scope: "x_tess_demo",
    });

    assert.deepEqual(report.artifacts, [
      found(INCLUDE, "story"),
      found(RULE, "story"),
      found(POLICY, "scope"),
    ]);
    // Nothing collided and the list is non-empty, so the composite has nothing
    // of its own to say.
    assert.deepEqual(report.notes, []);
    assert.equal(isIncomplete(report), false);
  });

  it("keeps one row per sys_id, labelled by the earlier adapter", async () => {
    const story = stub("story", { artifacts: [found(INCLUDE, "story")] });
    const scope = stub("scope", {
      artifacts: [found(INCLUDE, "scope"), found(POLICY, "scope")],
    });
    const composite = createCompositeResolver([story, scope]);

    const report = await composite.resolveWithReport(CTX, {
      story: "STRY0010001",
      scope: "x_tess_demo",
    });

    assert.deepEqual(report.artifacts, [
      found(INCLUDE, "story"),
      found(POLICY, "scope"),
    ]);

    // The loser is reported, not dropped: a single `resolvedBy` label would
    // otherwise read as "only story ever mentioned this artifact".
    assert.equal(report.notes.length, 1);
    const [precedence] = report.notes;
    assert.equal(precedence.level, "info");
    assert.equal(precedence.source, "scope");
    assert.match(precedence.message, /sys_script_include/);
    assert.match(precedence.message, /also resolved by scope/);
    assert.match(precedence.message, /reported as story/);
    assert.equal(isIncomplete(report), false);
  });

  it("lets the adapter order decide which resolvedBy survives", async () => {
    // The test that pins "order sets reporting precedence, not first-wins":
    // the same two adapters, reversed, keep the same union and swap the label.
    const artifacts = (source) => ({ artifacts: [found(INCLUDE, source)] });
    const input = { story: "STRY0010001", scope: "x_tess_demo" };

    const storyFirst = await createCompositeResolver([
      stub("story", artifacts("story")),
      stub("scope", artifacts("scope")),
    ]).resolveWithReport(CTX, input);

    const scopeFirst = await createCompositeResolver([
      stub("scope", artifacts("scope")),
      stub("story", artifacts("story")),
    ]).resolveWithReport(CTX, input);

    assert.deepEqual(storyFirst.artifacts, [found(INCLUDE, "story")]);
    assert.deepEqual(scopeFirst.artifacts, [found(INCLUDE, "scope")]);

    assert.equal(storyFirst.notes[0].source, "scope");
    assert.match(storyFirst.notes[0].message, /reported as story/);
    assert.equal(scopeFirst.notes[0].source, "story");
    assert.match(scopeFirst.notes[0].message, /reported as scope/);
  });

  it("de-duplicates by table AND sys_id", async () => {
    // Same sys_id on two tables is two artifacts; collapsing them would hide
    // one behind the other for the rest of the pipeline.
    const twin = { ...RULE, table: "sys_script_include", name: "Twin" };
    const story = stub("story", { artifacts: [found(RULE, "story")] });
    const scope = stub("scope", { artifacts: [found(twin, "scope")] });

    const report = await createCompositeResolver([
      story,
      scope,
    ]).resolveWithReport(CTX, { story: "STRY0010001", scope: "x_tess_demo" });

    assert.equal(report.artifacts.length, 2);
    assert.deepEqual(report.notes, []);
  });
});

describe("createCompositeResolver — notes", () => {
  it("concatenates adapter notes in order, each keeping its source", async () => {
    const story = stub("story", {
      artifacts: [found(INCLUDE, "story")],
      notes: [
        note("story", "info", "1 update set linked to STRY0010001"),
        note("story", "warning", "sys_update_xml could not be read"),
      ],
    });
    const scope = stub("scope", {
      artifacts: [found(POLICY, "scope"), found(INCLUDE, "scope")],
      notes: [note("scope", "info", "2 artifact table(s) enumerated")],
    });
    const composite = createCompositeResolver([story, scope]);

    const report = await composite.resolveWithReport(CTX, {
      story: "STRY0010001",
      scope: "x_tess_demo",
    });

    assert.deepEqual(
      report.notes.map((entry) => [entry.source, entry.level]),
      [
        ["story", "info"],
        ["story", "warning"],
        ["scope", "info"],
        // The composite's own notes come last — the adapters' account of the
        // read first, then what the merge did to it.
        ["scope", "info"],
      ],
    );
    assert.match(report.notes.at(-1).message, /ARCH-5 precedence/);
    // A warning anywhere in the merged list still makes the whole report
    // incomplete, even though the artifact list is not empty.
    assert.equal(isIncomplete(report), true);
  });

  it("warns when a quiet resolution matched nothing (M3)", async () => {
    const story = stub("story");
    const scope = stub("scope");
    const report = await createCompositeResolver([
      story,
      scope,
    ]).resolveWithReport(CTX, { story: "STRY0010001", scope: "x_tess_demo" });

    assert.deepEqual(report.artifacts, []);
    assert.equal(report.notes.length, 1);
    // A warning, not info: an empty answer cannot be told apart from rows an
    // ACL hid (OPP-1b), so an empty union is never a clean, complete answer.
    assert.equal(report.notes[0].level, "warning");
    // No `composite` source exists in the union; the note speaks as the
    // highest-precedence adapter.
    assert.equal(report.notes[0].source, "story");
    assert.match(report.notes[0].message, /matched no artifacts/);
    assert.equal(isIncomplete(report), true);
  });

  it("does not double up when an empty resolution already warned", async () => {
    const warning = note(
      "scope",
      "warning",
      "sys_script on dev: read refused (403) for the connected user",
    );
    const story = stub("story");
    const scope = stub("scope", { notes: [warning] });

    const report = await createCompositeResolver([
      story,
      scope,
    ]).resolveWithReport(CTX, { story: "STRY0010001", scope: "x_tess_demo" });

    assert.deepEqual(report.artifacts, []);
    // The warning already explains the emptiness; a cheerful "matched no
    // artifacts" underneath it would read as a second, contradicting verdict.
    assert.deepEqual(report.notes, [warning]);
    assert.equal(isIncomplete(report), true);
  });
});

describe("createCompositeResolver — faults and pass-through", () => {
  it("propagates an adapter fault and stops the walk", async () => {
    const fault = new ResolutionFaultError(
      "rm_story on dev: read refused (403) for the connected user",
    );
    const story = stub("story", { throws: fault });
    const scope = stub("scope", { artifacts: [found(POLICY, "scope")] });
    const composite = createCompositeResolver([story, scope]);

    // Unchanged: the CLI's exit code depends on this class surviving the trip.
    await assert.rejects(
      composite.resolveWithReport(CTX, {
        story: "STRY0010001",
        scope: "x_tess_demo",
      }),
      (error) => {
        assert.equal(error, fault);
        return true;
      },
    );

    assert.equal(story.calls.length, 1);
    assert.deepEqual(scope.calls, []);
  });

  it("passes ctx and input through to every adapter unchanged (ARCH-23)", async () => {
    const story = stub("story");
    const scope = stub("scope");
    const composite = createCompositeResolver([story, scope]);
    const input = { story: "STRY0010001", scope: "x_tess_demo" };

    await composite.resolveWithReport(CTX, input);

    for (const adapter of [story, scope]) {
      assert.equal(adapter.calls.length, 1);
      assert.equal(adapter.calls[0].ctx, CTX);
      assert.equal(adapter.calls[0].input, input);
    }
  });

  it("resolve() returns exactly the report's artifacts", async () => {
    const story = stub("story", { artifacts: [found(INCLUDE, "story")] });
    const scope = stub("scope", {
      artifacts: [found(INCLUDE, "scope"), found(POLICY, "scope")],
    });
    const composite = createCompositeResolver([story, scope]);
    const input = { story: "STRY0010001", scope: "x_tess_demo" };

    const artifacts = await composite.resolve(CTX, input);
    const report = await composite.resolveWithReport(CTX, input);

    assert.deepEqual(artifacts, [...report.artifacts]);
    assert.deepEqual(artifacts, [
      found(INCLUDE, "story"),
      found(POLICY, "scope"),
    ]);
    // The port's array is the caller's to sort in place — it must not be the
    // list the report is holding.
    assert.notEqual(artifacts, report.artifacts);
  });

  it("resolve() refuses to hand back a partial resolution (H1)", async () => {
    // An adapter that found something AND warned: the report is incomplete,
    // and the narrow port has no channel for the warning, so it throws.
    const story = stub("story", {
      artifacts: [found(INCLUDE, "story")],
      notes: [note("story", "warning", "sys_update_set list was truncated")],
    });
    const composite = createCompositeResolver([story]);
    await assert.rejects(
      composite.resolve(CTX, { story: "STRY0010001" }),
      (error) =>
        error instanceof ResolutionFaultError &&
        /incomplete/.test(error.message) &&
        /truncated/.test(error.message),
    );
  });

  it("resolve() refuses an empty union as well (H1 + M3)", async () => {
    const composite = createCompositeResolver([stub("story")]);
    await assert.rejects(
      composite.resolve(CTX, { story: "STRY0010001" }),
      ResolutionFaultError,
    );
  });

  it("refuses --update-set through resolve() as well", async () => {
    const composite = createCompositeResolver([stub("story")]);
    await assert.rejects(
      composite.resolve(CTX, { updateSet: "dddd0000000000000000000000000004" }),
      ResolutionInputError,
    );
  });
});
