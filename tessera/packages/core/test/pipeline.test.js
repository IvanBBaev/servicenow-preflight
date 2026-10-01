// Composition root (ARCH-1): registries + resolvePipeline. Phase 0 has no run
// loop — these tests cover composition and its startup-time failure mode.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Registry, createRegistries, resolvePipeline } from "../build/index.js";

const stub = (label) => ({ label });

describe("Registry", () => {
  it("registers and resolves by name", () => {
    const reg = new Registry("runner");
    const runner = stub("atf");
    reg.register("atf", runner);
    assert.equal(reg.get("atf"), runner);
  });

  it("rejects duplicate registration", () => {
    const reg = new Registry("runner");
    reg.register("atf", stub("atf"));
    assert.throws(
      () => reg.register("atf", stub("other")),
      /already registered/,
    );
  });

  it("names unknown entries and lists the registered alternatives", () => {
    const reg = new Registry("runner");
    reg.register("atf", stub("atf"));
    reg.register("playwright", stub("pw"));
    assert.throws(
      () => reg.get("selenium"),
      /unknown runner "selenium" \(registered: atf, playwright\)/,
    );
  });

  it("reports an empty registry as such", () => {
    const reg = new Registry("reporter");
    assert.throws(() => reg.get("junit"), /registered: none/);
  });
});

describe("resolvePipeline", () => {
  const populated = () => {
    const r = createRegistries();
    r.resolvers.register("composite", stub("resolver"));
    r.impactAnalyzers.register("static", stub("impact"));
    r.generators.register("atf-gen", stub("gen"));
    r.stores.register("atf-store", stub("store"));
    r.runners.register("atf", stub("runner-atf"));
    r.runners.register("playwright", stub("runner-pw"));
    r.reporters.register("console", stub("rep-console"));
    r.reporters.register("junit", stub("rep-junit"));
    r.provisioners.register("noop", stub("prov"));
    r.gates.register("default", stub("gate"));
    return r;
  };

  const config = {
    resolver: "composite",
    impactAnalyzer: "static",
    generator: "atf-gen",
    store: "atf-store",
    runners: ["atf", "playwright"],
    reporters: ["console"],
    provisioner: "noop",
    gate: "default",
  };

  it("resolves a full config to concrete ports", () => {
    const ports = resolvePipeline(populated(), config);
    assert.equal(ports.resolver.label, "resolver");
    assert.deepEqual(
      ports.runners.map((r) => r.label),
      ["runner-atf", "runner-pw"],
    );
    assert.deepEqual(
      ports.reporters.map((r) => r.label),
      ["rep-console"],
    );
    assert.equal(ports.gate.label, "gate");
  });

  it("fails at composition time on an unknown adapter name", () => {
    assert.throws(
      () => resolvePipeline(populated(), { ...config, store: "nope" }),
      /unknown test store "nope"/,
    );
  });
});
