// The real (Phases 2–8) composition — all eight ports resolved.
//
// This suite used to be a tripwire: `REAL_PIPELINE.store` named an adapter
// nothing registered, and the headline test asserted that composition THREW.
// `@tessera/teststore-atf` is now registered under "atf" (delegated decision
// 2026-09-23, TODO "run --live"), so the tripwire has been flipped: the suite
// pins that the real composition resolves, that the store it returns IS the
// store the ports carry (so the caller can `release()` the lock it owns), and
// that "atf" is the only store registered — a typo'd second registration would
// otherwise pass silently.
//
// Nothing here touches a network or an environment. `createRealRegistries` is
// pure composition: every factory it calls builds an object and closes over its
// collaborators, so the profile names below need not exist and the first byte
// over the wire would only be sent by a stage port, during a run. The store's
// lock file is only taken by `project()`, so the lock path below is never
// created.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { createTemplateProvider } from "@tessera/generate";

import {
  composeRealPipeline,
  composeSkeletonPipeline,
  createRealRegistries,
  REAL_PIPELINE,
  SKELETON_PIPELINE,
} from "../build/index.js";

// Profiles that do not resolve to anything, on purpose: if any of this reached
// the credential store, these would throw a different error and the suite would
// stop proving what it claims to prove.
const OPTIONS = {
  sourceProfile: "no_such_source_profile",
  runnerProfile: "no_such_runner_profile",
  scope: "x_test_app",
  testsRoot: "/nonexistent/tests",
  provider: createTemplateProvider(),
  now: () => new Date("2026-01-01T00:00:00.000Z"),
  console: () => {},
  writeJson: () => {},
  writeJUnit: () => {},
  lockPath: path.join(os.tmpdir(), "tessera-real-pipeline-never-taken.lock"),
};

describe("the real pipeline composition", () => {
  it("composes, returning the store the ports carry", () => {
    const { ports, store, config } = composeRealPipeline(OPTIONS);
    assert.equal(config, REAL_PIPELINE);
    // Identity, not shape: the caller releases the projection lock through
    // `store`, and a second store instance would hold a different lock.
    assert.equal(ports.store, store);
    assert.equal(typeof store.release, "function");
    assert.equal(typeof store.project, "function");
    assert.equal(typeof store.teardown, "function");
  });

  it("registers exactly the ATF test store", () => {
    // The anti-fabrication guard, inverted with the tripwire. A store under a
    // DIFFERENT name next to "atf" would be a typo, and `createS5TestStore`
    // (one hardcoded spec, ephemeral only) is still not a real store — wiring
    // it here would produce a Phase-0.5 pipeline wearing a Phase-4 label.
    const registries = createRealRegistries(OPTIONS);
    assert.deepEqual(registries.stores.names(), ["atf"]);
    assert.equal(REAL_PIPELINE.store, "atf");
  });

  it("resolves every port the config names", () => {
    // Each `get` throws if the name in `REAL_PIPELINE` has no registration, so
    // reaching the end is the assertion; the returned adapters are checked for
    // existence only.
    const registries = createRealRegistries(OPTIONS);

    assert.ok(registries.resolvers.get(REAL_PIPELINE.resolver));
    assert.ok(registries.impactAnalyzers.get(REAL_PIPELINE.impactAnalyzer));
    assert.ok(registries.generators.get(REAL_PIPELINE.generator));
    assert.ok(registries.provisioners.get(REAL_PIPELINE.provisioner));
    assert.ok(registries.gates.get(REAL_PIPELINE.gate));

    assert.ok(REAL_PIPELINE.runners.length > 0);
    for (const name of REAL_PIPELINE.runners) {
      assert.ok(registries.runners.get(name));
    }

    assert.ok(REAL_PIPELINE.reporters.length > 0);
    for (const name of REAL_PIPELINE.reporters) {
      assert.ok(registries.reporters.get(name));
    }
  });

  it("selects its adapters by name, like the skeleton does", () => {
    // ARCH-1: the difference between the two pipelines is data, not code. Both
    // are `PipelineConfig` records resolved through the same registries, and no
    // caller of `runPipeline` can tell them apart. This test is what stops a
    // future edit from "temporarily" hand-building a ports object literal for
    // the real path.
    assert.deepEqual(Object.keys(REAL_PIPELINE).sort(), [
      "gate",
      "generator",
      "impactAnalyzer",
      "provisioner",
      "reporters",
      "resolver",
      "runners",
      "store",
    ]);
    for (const [key, value] of Object.entries(REAL_PIPELINE)) {
      const names = Array.isArray(value) ? value : [value];
      for (const name of names) {
        assert.equal(
          typeof name,
          "string",
          `REAL_PIPELINE.${key} must select adapters by name`,
        );
        assert.ok(name.length > 0, `REAL_PIPELINE.${key} must not be empty`);
      }
    }
  });
});

describe("the frozen skeleton composition", () => {
  it("still resolves all eight ports", () => {
    // The real config is additive. `SKELETON_PIPELINE` and its registries are
    // frozen (a CI job and the MCP tests are pinned to them), so a change that
    // broke the skeleton while wiring the real path would be a regression, not
    // a trade-off. Asserting the skeleton composes here catches that in the
    // same file that introduces the risk.
    const { ports, config } = composeSkeletonPipeline({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(config, SKELETON_PIPELINE);
    assert.ok(ports.resolver);
    assert.ok(ports.impactAnalyzer);
    assert.ok(ports.generator);
    assert.ok(ports.store);
    assert.ok(ports.gate);
    assert.equal(ports.runners.length, SKELETON_PIPELINE.runners.length);
    assert.equal(ports.reporters.length, SKELETON_PIPELINE.reporters.length);
    assert.ok(ports.provisioner);
  });
});
