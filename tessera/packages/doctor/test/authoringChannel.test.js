// ADR-007 C3/C4 — the authoring-channel precondition, prepared but NOT
// promoted (delegated decision 2026-09-23). Imports the module directly: the
// new constants reach the package barrel when the promotion lands.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  AUTHORING_CHANNEL_C3_PROMOTED,
  AUTHORING_CHANNEL_C3_REQUIRED_KINDS,
  AUTHORING_CHANNEL_REQUIRED_MAJOR,
  AUTHORING_CHANNEL_VERSION_PROPERTY,
  PRECONDITION_IDS,
  authoringChannelPrecondition,
  createDefaultPreconditions,
} from "../build/preconditions.js";
import { createEnvironmentDoctor } from "../build/doctor.js";

/** An `InstanceProbe` whose `readProperty` answers with a fixed probe. */
function propertyProbe(answer) {
  const reads = [];
  return {
    reads,
    readProperty(name) {
      reads.push(name);
      return Promise.resolve(answer);
    },
    readTable: () => Promise.reject(new Error("not used")),
    reachApi: () => Promise.reject(new Error("not used")),
  };
}

const found = (value) => ({
  outcome: "found",
  value,
  sysId: "abc",
  detail: `read ${value}`,
});

describe("authoring channel precondition (ADR-007 C3)", () => {
  it("is promoted and required for unit (delegated decision 2026-09-23)", () => {
    assert.equal(AUTHORING_CHANNEL_C3_PROMOTED, true);
    assert.deepEqual([...AUTHORING_CHANNEL_C3_REQUIRED_KINDS], ["unit"]);
  });

  it("unpromoted it stays a deferred row that gates nothing and probes nothing", async () => {
    const probe = propertyProbe(found("1.0.0"));
    const precondition = authoringChannelPrecondition(probe, {
      promoted: false,
    });
    assert.equal(precondition.id, PRECONDITION_IDS.authoringChannel);
    assert.deepEqual(precondition.requiredForKinds, []);
    assert.equal(precondition.deferredTo, "Phase 4");
    const probed = await precondition.probe();
    assert.equal(probed.status, "unknown");
    // TODO "Three docs/ai claims" (a): the evidence no longer calls the
    // channel's absence benign.
    assert.doesNotMatch(probed.evidence, /not from an instance channel/);
    assert.match(probed.evidence, /ADR-007/);
    assert.deepEqual(probe.reads, []);
  });

  it("the default catalogue carries the promoted row", () => {
    const row = createDefaultPreconditions(propertyProbe(found("1.0.0"))).find(
      (p) => p.id === PRECONDITION_IDS.authoringChannel,
    );
    assert.equal(row.deferredTo, undefined);
    assert.deepEqual([...row.requiredForKinds], ["unit"]);
  });

  it("the default (promoted) row probes the C4 version row", async () => {
    const probe = propertyProbe(found("1.0.0"));
    const probed = await authoringChannelPrecondition(probe).probe();
    assert.equal(probed.status, "ready");
    assert.deepEqual(probe.reads, [AUTHORING_CHANNEL_VERSION_PROPERTY]);
  });

  it("promoted: requires unit and reads the C4 version row", async () => {
    const probe = propertyProbe(found("1.0.0"));
    const precondition = authoringChannelPrecondition(probe, {
      promoted: true,
    });
    assert.deepEqual(precondition.requiredForKinds, ["unit"]);
    assert.equal(precondition.deferredTo, undefined);
    const probed = await precondition.probe();
    assert.equal(probed.status, "ready");
    assert.deepEqual(probe.reads, [AUTHORING_CHANNEL_VERSION_PROPERTY]);
  });

  it("promoted: status per probe outcome", async () => {
    const cases = [
      [found("1.4.2"), "ready"],
      [found("1.0"), "ready"],
      [found("2.0.0"), "not-ready"],
      [found("one"), "not-ready"],
      [{ outcome: "absent", detail: "no row" }, "not-ready"],
      [{ outcome: "denied", detail: "403" }, "unknown"],
      [{ outcome: "undecidable", detail: "timeout" }, "unknown"],
    ];
    for (const [answer, status] of cases) {
      const probed = await authoringChannelPrecondition(propertyProbe(answer), {
        promoted: true,
      }).probe();
      assert.equal(probed.status, status, JSON.stringify(answer));
    }
  });

  it("promoted: an absent channel refuses a unit run and names the runbook", async () => {
    const precondition = authoringChannelPrecondition(
      propertyProbe({ outcome: "absent", detail: "no row" }),
      { promoted: true },
    );
    const report = await createEnvironmentDoctor([precondition]).diagnose({
      kinds: ["unit"],
    });
    assert.notEqual(report.status, "ready");
    const finding = report.findings[0];
    assert.equal(finding.applicability, "required");
    assert.match(
      finding.evidence,
      /tessera-authoring-channel\.update-set\.xml/,
    );
    assert.match(finding.evidence, /never\s+installs, upgrades or grants/);
  });

  it("promoted without a probe is a construction error", () => {
    assert.throws(
      () => authoringChannelPrecondition(undefined, { promoted: true }),
      TypeError,
    );
  });

  it("re-declared constants equal @tessera/teststore-atf's (doctor rule #2)", () => {
    const source = fs.readFileSync(
      new URL("../../teststore-atf/src/channel.ts", import.meta.url),
      "utf8",
    );
    const property = /AUTHORING_CHANNEL_VERSION_PROPERTY = "([^"]+)"/.exec(
      source,
    );
    const version = /AUTHORING_CHANNEL_VERSION = "(\d+)\.\d+(?:\.\d+)?"/.exec(
      source,
    );
    assert.ok(property && version, "teststore-atf channel constants not found");
    assert.equal(property[1], AUTHORING_CHANNEL_VERSION_PROPERTY);
    assert.equal(Number(version[1]), AUTHORING_CHANNEL_REQUIRED_MAJOR);
  });
});
