// EnvironmentDoctor — PLAN Phase 1.
//
// Two halves, and the split is deliberate.
//
//  * The ROLL-UP half uses hand-written preconditions. What is under test there
//    is the arithmetic of readiness — precedence, applicability, containment —
//    and an instance in the picture would only add ways for the test to pass
//    for the wrong reason.
//
//  * The ADAPTER half runs the real preconditions through the real
//    `@tessera/sn-client` transport against the QA-18 stateful fake. Those
//    assertions are about HTTP: that a 403 is not a 404, that a record-level
//    404 is not a namespace 404, and that a timeout is never a green.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createFakeInstance,
  namespace404Body,
  noRecordFoundBody,
} from "@tessera/fake-instance";
import { reloadCredentialsFromEnv, tableApi } from "@tessera/sn-client";

import {
  ATF_AUTHORING_TABLES,
  AUTHORING_CHANNEL_VERSION_PROPERTY,
  ATF_RUNNER_ENABLED_PROPERTY,
  CICD_PROBE_PATH,
  DoctorContractError,
  PRECONDITION_IDS,
  PRODUCTION_PROPERTY,
  PROPERTY_READ_LIMIT,
  PROPERTY_ROW_LIMIT,
  atfRunnerEnabledPrecondition,
  atfTablesPrecondition,
  cicdApiPrecondition,
  createDefaultPreconditions,
  createEnvironmentDoctor,
  createSnInstanceProbe,
  DEFAULT_PROBE_TIMEOUT_MS,
  formatDoctorReport,
  rollUp,
  SYS_PROPERTIES_TABLE,
} from "../build/index.js";
import { incompleteRead } from "../build/probe.js";
import * as sharedTypes from "@tessera/types";

// ── roll-up half ────────────────────────────────────────────────────────────

/** A precondition that answers with a fixed status and nothing else. */
function stub(id, status, extra = {}) {
  return {
    id,
    ...extra,
    probe() {
      return Promise.resolve({
        precondition: id,
        status,
        evidence: `stub says ${status}`,
      });
    },
  };
}

function findingFor(report, id) {
  const found = report.findings.find((f) => f.precondition === id);
  assert.ok(found, `expected a finding for ${id}`);
  return found;
}

describe("rollUp — fail-closed precedence", () => {
  it("is ready only when every required finding is ready", () => {
    assert.equal(rollUp([]), "ready");
    assert.equal(
      rollUp([
        {
          precondition: "a",
          status: "ready",
          applicability: "required",
          evidence: "x",
        },
        {
          precondition: "b",
          status: "ready",
          applicability: "required",
          evidence: "x",
        },
      ]),
      "ready",
    );
  });

  it("lets unknown outrank not-ready", () => {
    // The stronger claim ("not ready") cannot be made while a probe came back
    // blind — both block the gate, but only one of them is honest.
    const findings = [
      {
        precondition: "a",
        status: "not-ready",
        applicability: "required",
        evidence: "x",
      },
      {
        precondition: "b",
        status: "unknown",
        applicability: "required",
        evidence: "x",
      },
    ];
    assert.equal(rollUp(findings), "unknown");
    assert.equal(rollUp(findings.slice(0, 1)), "not-ready");
  });
});

describe("createEnvironmentDoctor — applicability", () => {
  it("always counts an ungated precondition", async () => {
    const doctor = createEnvironmentDoctor([stub("baseline", "not-ready")]);
    const report = await doctor.diagnose();
    assert.equal(report.status, "not-ready");
    assert.equal(findingFor(report, "baseline").applicability, "required");
  });

  it("reports a deferred precondition but keeps it out of the roll-up", async () => {
    const doctor = createEnvironmentDoctor([
      stub("baseline", "ready"),
      stub("later", "unknown", { requiredForKinds: [], deferredTo: "Phase 8" }),
    ]);
    const report = await doctor.diagnose({ kinds: ["unit"] });

    // Visible, owned, and inert — the three properties `deferred` exists for.
    assert.equal(report.status, "ready");
    assert.equal(findingFor(report, "later").applicability, "deferred");
    assert.equal(findingFor(report, "later").status, "unknown");
    assert.equal(report.hardFailure, undefined);
  });

  it("promotes a kind-gated precondition and fails hard on it (DEV-2)", async () => {
    const doctor = createEnvironmentDoctor([
      stub("baseline", "ready"),
      stub("runner", "unknown", {
        requiredForKinds: ["ui"],
        deferredTo: "Phase 8",
      }),
    ]);

    const unit = await doctor.diagnose({ kinds: ["unit"] });
    assert.equal(unit.status, "ready");
    assert.equal(unit.hardFailure, undefined);

    const ui = await doctor.diagnose({ kinds: ["unit", "ui"] });
    assert.equal(ui.status, "unknown");
    assert.equal(findingFor(ui, "runner").applicability, "required");
    assert.match(ui.hardFailure, /unit, ui cannot run/);
    assert.match(ui.hardFailure, /runner is unknown/);
  });

  it("raises no hard failure when the promoted precondition is ready", async () => {
    const doctor = createEnvironmentDoctor([
      stub("runner", "ready", { requiredForKinds: ["ui"] }),
    ]);
    const report = await doctor.diagnose({ kinds: ["ui"] });
    assert.equal(report.status, "ready");
    assert.equal(report.hardFailure, undefined);
  });
});

describe("createEnvironmentDoctor — containment", () => {
  it("turns a thrown probe into unknown instead of rejecting", async () => {
    const doctor = createEnvironmentDoctor([
      {
        id: "explodes",
        probe: () => Promise.reject(new Error("socket closed")),
      },
      stub("fine", "ready"),
    ]);
    const report = await doctor.diagnose();

    assert.equal(report.status, "unknown");
    assert.match(findingFor(report, "explodes").evidence, /socket closed/);
    // The other probe still reported: one bad adapter must not blind the rest.
    assert.equal(findingFor(report, "fine").status, "ready");
  });

  it("rejects a finding that answers for a different precondition", async () => {
    const doctor = createEnvironmentDoctor([
      {
        id: "mine",
        probe: () =>
          Promise.resolve({
            precondition: "someone-elses",
            status: "ready",
            evidence: "green",
          }),
      },
    ]);
    const report = await doctor.diagnose();
    assert.equal(report.status, "unknown");
    assert.match(findingFor(report, "mine").evidence, /instead of "mine"/);
  });

  it("refuses a green with no evidence", async () => {
    const doctor = createEnvironmentDoctor([
      {
        id: "bare",
        probe: () =>
          Promise.resolve({
            precondition: "bare",
            status: "ready",
            evidence: "  ",
          }),
      },
    ]);
    const report = await doctor.diagnose();
    assert.equal(report.status, "unknown");
    assert.match(findingFor(report, "bare").evidence, /no evidence/);
  });

  it("throws on duplicate ids at construction, not at diagnose time", () => {
    assert.throws(
      () =>
        createEnvironmentDoctor([stub("dup", "ready"), stub("dup", "ready")]),
      (error) =>
        error instanceof DoctorContractError &&
        /duplicate precondition id "dup"/.test(error.message),
    );
  });

  it("keeps catalogue order regardless of probe timing", async () => {
    const slow = {
      id: "slow",
      probe: () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                precondition: "slow",
                status: "ready",
                evidence: "late",
              }),
            10,
          ),
        ),
    };
    const doctor = createEnvironmentDoctor([slow, stub("fast", "ready")]);
    const report = await doctor.diagnose();
    assert.deepEqual(
      report.findings.map((f) => f.precondition),
      ["slow", "fast"],
    );
  });
});

describe("formatDoctorReport", () => {
  it("marks deferred rows, renders remedies and shouts the hard failure", async () => {
    const doctor = createEnvironmentDoctor([
      {
        id: "needs-fixing",
        probe: () =>
          Promise.resolve({
            precondition: "needs-fixing",
            status: "not-ready",
            evidence: "the property is false",
            remedy: {
              action: {
                kind: "update",
                table: "sys_properties",
                description: "flip it",
              },
            },
          }),
      },
      stub("gated", "unknown", { requiredForKinds: ["ui"] }),
    ]);
    const text = formatDoctorReport(await doctor.diagnose({ kinds: ["ui"] }));

    assert.match(text, /^readiness: unknown$/m);
    assert.match(text, /remedy: update sys_properties — flip it/);
    assert.match(text, /HARD FAILURE: requested kind\(s\) ui cannot run/);
    assert.match(text, /\[unknown\] gated/);
  });
});

// ── adapter half ────────────────────────────────────────────────────────────

const HOST = "dev-doctor.service-now.com";

const ENV_KEYS = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH",
  "SN_DOCS_DIR",
  "SN_READONLY",
  "SN_ACTIVE_PROFILE",
  "SN_ALLOWED_HOSTS",
  "SN_MAX_RETRIES",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
];

/** Seed with every ATF table present, and the DR-3 property as asked. */
function seed({ atfRunnerEnabled, authoringChannel, properties } = {}) {
  const state = {};
  for (const table of ATF_AUTHORING_TABLES) state[table] = [];
  state.sys_properties =
    atfRunnerEnabled === undefined
      ? []
      : [
          {
            name: ATF_RUNNER_ENABLED_PROPERTY,
            value: String(atfRunnerEnabled),
          },
        ];
  // ADR-007 C3 is promoted: a `unit` run needs the W2 channel's C4 version row.
  if (authoringChannel !== undefined)
    state.sys_properties.push({
      name: AUTHORING_CHANNEL_VERSION_PROPERTY,
      value: authoringChannel,
    });
  // Raw extra rows, duplicates included — the fake keeps insertion order.
  if (properties !== undefined) state.sys_properties.push(...properties);
  return state;
}

/**
 * Wire the real transport at the fake and hand back a restorer. Credentials go
 * through the environment because that is the only way `@tessera/sn-client`
 * accepts them — nothing here is a Tessera-specific back door.
 */
function withFake(options = {}) {
  const fake = createFakeInstance({ host: HOST, state: seed(options) });
  const restoreFetch = fake.install();

  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SN_INSTANCE = HOST;
  process.env.SN_USER = "tessera";
  process.env.SN_PASSWORD = "tessera";
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(os.tmpdir(), "tessera-doctor-docs");
  // One shot per probe. The transport retries idempotent GETs twice by default,
  // which would let a single-fire fault be papered over by the retry — the test
  // would then assert the retry's success rather than the failure it injected.
  process.env.SN_MAX_RETRIES = "0";
  delete process.env.SN_READONLY;
  delete process.env.SN_ACTIVE_PROFILE;
  // The client's own table policy would otherwise be inherited from whatever
  // shell ran the suite, and it can only ever *remove* access — an ambient
  // SN_TABLES_ALLOW would turn these probes into policy tests by accident.
  delete process.env.SN_TABLES_ALLOW;
  delete process.env.SN_TABLES_DENY;
  reloadCredentialsFromEnv();

  return {
    fake,
    probe: createSnInstanceProbe(),
    restore() {
      restoreFetch();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    },
  };
}

/** Every request the fake served — used to prove the doctor never writes. */
function methods(fake) {
  return [...new Set(fake.requests().map((r) => r.method))];
}

describe("sn-client probe — sn_atf.runner.enabled (DR-3)", () => {
  it("is ready when the property is true", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      const finding = await atfRunnerEnabledPrecondition(h.probe).probe();
      assert.equal(finding.status, "ready");
      assert.equal(finding.precondition, ATF_RUNNER_ENABLED_PROPERTY);
      assert.equal(finding.remedy, undefined);
    } finally {
      h.restore();
    }
  });

  it("is not-ready with a remedy when the property is false", async () => {
    const h = withFake({ atfRunnerEnabled: false });
    try {
      const finding = await atfRunnerEnabledPrecondition(h.probe).probe();
      assert.equal(finding.status, "not-ready");
      assert.match(finding.evidence, /execute nothing/);
      assert.deepEqual(finding.remedy.action, {
        kind: "update",
        table: "sys_properties",
        description: `${ATF_RUNNER_ENABLED_PROPERTY} must be true before ATF will execute anything (DR-3)`,
      });
    } finally {
      h.restore();
    }
  });

  it("words an unreadable row so it holds under both readings", async () => {
    // Unset and ACL-trimmed are the same bytes on the wire; the evidence has to
    // survive being wrong about which one it is.
    const h = withFake();
    try {
      const finding = await atfRunnerEnabledPrecondition(h.probe).probe();
      assert.equal(finding.status, "not-ready");
      assert.match(finding.evidence, /genuinely unset/);
      assert.match(finding.evidence, /ACL-trimmed/);
      assert.ok(finding.remedy);
    } finally {
      h.restore();
    }
  });

  it("cannot decide when the read is refused or the instance stalls", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      h.fake.faults.add({
        match: { table: "sys_properties", times: 1 },
        mode: { kind: "http-error", status: 403, message: "no read access" },
      });
      const denied = await atfRunnerEnabledPrecondition(h.probe).probe();
      assert.equal(denied.status, "unknown");
      assert.match(denied.evidence, /could not decide/);

      h.fake.faults.add({
        match: { table: "sys_properties", times: 1 },
        mode: { kind: "transport-error", message: "connection reset" },
      });
      const dropped = await atfRunnerEnabledPrecondition(h.probe).probe();
      assert.equal(dropped.status, "unknown");
      assert.match(dropped.evidence, /connection reset/);
    } finally {
      h.restore();
    }
  });

  it("is unknown without touching the wire once the signal is aborted", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      const before = h.fake.requests().length;
      const finding = await atfRunnerEnabledPrecondition(h.probe).probe(
        AbortSignal.abort(),
      );
      assert.equal(finding.status, "unknown");
      assert.match(finding.evidence, /aborted/);
      assert.equal(h.fake.requests().length, before);
    } finally {
      h.restore();
    }
  });
});

describe("sn-client probe — the CI/CD API (DR-2)", () => {
  it("reads a record-level 404 as proof the namespace is live", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      const finding = await cicdApiPrecondition(h.probe).probe();
      assert.equal(finding.status, "ready");
      assert.match(finding.evidence, /record-level 404/);
    } finally {
      h.restore();
    }
  });

  it("reads a namespace 404 as an inactive plugin", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      h.fake.faults.add({
        match: { path: CICD_PROBE_PATH },
        mode: {
          kind: "http-error",
          status: 404,
          message:
            "The requested URI does not represent any resource on the server",
        },
      });
      const finding = await cicdApiPrecondition(h.probe).probe();
      assert.equal(finding.status, "not-ready");
      assert.match(finding.evidence, /plugin is inactive/);
      // Nothing to remediate: activating a plugin is not a table write (ARCH-33).
      assert.equal(finding.remedy, undefined);
    } finally {
      h.restore();
    }
  });

  it("cannot decide on a 500", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      h.fake.faults.add({
        match: { path: CICD_PROBE_PATH },
        mode: { kind: "http-error", status: 500, message: "internal error" },
      });
      const finding = await cicdApiPrecondition(h.probe).probe();
      assert.equal(finding.status, "unknown");
    } finally {
      h.restore();
    }
  });
});

describe("sn-client probe — the ATF tables", () => {
  it("is ready but says what a read-only probe cannot prove", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      const finding = await atfTablesPrecondition(h.probe).probe();
      assert.equal(finding.status, "ready");
      assert.match(finding.evidence, /write authority is not provable/);
    } finally {
      h.restore();
    }
  });

  it("is not-ready when one table is refused", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      h.fake.faults.add({
        match: { table: "sys_atf_step" },
        mode: { kind: "http-error", status: 403, message: "denied" },
      });
      const finding = await atfTablesPrecondition(h.probe).probe();
      assert.equal(finding.status, "not-ready");
      assert.match(finding.evidence, /sys_atf_step: no read access/);
    } finally {
      h.restore();
    }
  });

  it("lets one undecided table outrank a decided refusal", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      h.fake.faults.add({
        match: { table: "sys_atf_step" },
        mode: { kind: "http-error", status: 403, message: "denied" },
      });
      h.fake.faults.add({
        match: { table: "sys_atf_test_result" },
        mode: { kind: "http-error", status: 500, message: "internal error" },
      });
      const finding = await atfTablesPrecondition(h.probe).probe();
      assert.equal(finding.status, "unknown");
      assert.match(finding.evidence, /could not decide for 1 of 5 table\(s\)/);
    } finally {
      h.restore();
    }
  });

  // The DEV-1 error boundary of `src/probe.ts`, stated as the claim rather
  // than the mechanism. `denied` above means the INSTANCE answered 403, and
  // that is only true because every probe calls `snRequest` directly:
  // `@tessera/sn-client` fabricates an identical 403 `ServiceNowError` in
  // `assertTableAllowed` when SN_TABLES_ALLOW/SN_TABLES_DENY refuses a table,
  // before anything is sent — but that guard lives in the `tableApi` layer,
  // which nothing in the probe touches. Move a probe onto `tableApi` (the
  // obvious tidy-up: it is the higher-level API) and the doctor would report
  // the operator's own environment as the instance's refusal, and hand them a
  // remedy for an ACL that is not the problem. This is what notices.
  it("never reports a client-side table-policy denial as the instance's refusal", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      process.env.SN_TABLES_DENY = "sys_atf_step";
      const before = h.fake.requests().length;

      const probed = await h.probe.readTable("sys_atf_step");
      // Not `denied`: nobody refused this read except, possibly, the caller's
      // own config — and this adapter has no way to say which, so it must not
      // be on a code path that can be handed the question.
      assert.notEqual(probed.outcome, "denied");
      assert.equal(probed.outcome, "readable");
      // The proof that the 403 could not have been local: it went to the wire.
      assert.ok(h.fake.requests().length > before);

      const finding = await atfTablesPrecondition(h.probe).probe();
      assert.equal(finding.status, "ready");
      assert.doesNotMatch(finding.evidence, /sys_atf_step: no read access/);
    } finally {
      h.restore();
    }
  });

  // A 404 on a table read is the one status where this adapter used to
  // disagree with its own second classifier and with the rest of the
  // monorepo: `classifyTable` read EVERY 404 as `absent` and reported
  // "<table> is not present on this instance". That is a claim about the
  // instance drawn from an answer computed for ONE session, and the body
  // ServiceNow sends when a 404 is about a row contradicts it in so many
  // words — "Record doesn't exist or ACL restricts the record retrieval".
  // The wording is the only discriminator there is, so the two tests below
  // hold the two readings apart at the finding level, which is where an
  // operator meets them.
  it("names both readings when the body says the table is no resource", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      h.fake.faults.add({
        match: { table: "sys_atf_step" },
        mode: {
          kind: "http-error",
          status: 404,
          body: namespace404Body("/api/now/table/sys_atf_step"),
        },
      });

      const probed = await h.probe.readTable("sys_atf_step");
      assert.equal(probed.outcome, "absent");
      // The instance answered, so the status is a fact about it.
      assert.equal(probed.status, 404);
      // Absent FOR THIS CALLER: a namespace 404 is still resolved against one
      // session's scope and roles, so the detail carries both ways it can be
      // true instead of the one it cannot prove — the same move the 403 line
      // makes by saying "for the connected user".
      assert.match(probed.detail, /for the connected user/);
      assert.match(probed.detail, /not there at all/);
      assert.match(probed.detail, /scope and roles/);
      assert.doesNotMatch(probed.detail, /is not present on this instance/);

      const finding = await atfTablesPrecondition(h.probe).probe();
      assert.equal(finding.status, "not-ready");
      assert.match(finding.evidence, /sys_atf_step is not a resource/);
      assert.doesNotMatch(finding.evidence, /is not present on this instance/);
      // Nothing to remediate either way: no table write creates a table or
      // grants a role, so there is no action to point `Provisioner.plan()` at
      // and none may be invented to fill the line.
      assert.equal(finding.remedy, undefined);
    } finally {
      h.restore();
    }
  });

  it("cannot decide a 404 whose body says nothing about the table", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      h.fake.faults.add({
        match: { table: "sys_atf_step" },
        mode: { kind: "http-error", status: 404, body: noRecordFoundBody() },
      });

      const probed = await h.probe.readTable("sys_atf_step");
      // `absent` is the STRONGER claim: it is what becomes a `not-ready`
      // finding, and from there the provisioner's "no write can fix this — it
      // needs an instance change outside the Table API (plugin activation,
      // roles, or a human)". A 404 that said nothing about the namespace does
      // not earn a sentence that sends an operator to activate a plugin.
      assert.notEqual(probed.outcome, "absent");
      assert.equal(probed.outcome, "undecidable");
      assert.equal(probed.status, 404);
      assert.match(probed.detail, /without the namespace wording/);
      assert.doesNotMatch(probed.detail, /is not present on this instance/);
      assert.doesNotMatch(probed.detail, /is not a resource/);
      // What the instance actually said survives; it is the only part of the
      // line that says where to look next.
      assert.match(probed.detail, /No Record found/);

      const finding = await atfTablesPrecondition(h.probe).probe();
      // Undecided, not refused — and `unknown` is fail-closed at the gate, so
      // nothing is waved through by declining to conclude.
      assert.equal(finding.status, "unknown");
      assert.match(finding.evidence, /could not decide for 1 of 5 table\(s\)/);
    } finally {
      h.restore();
    }
  });
});

// ── the two blocked populations ─────────────────────────────────────────────
//
// `denied` and `absent` are ONE verdict and TWO different problems, and the
// finding used to hand an operator one undifferentiated list of both. A 403
// came from an instance that RESOLVED the URI and then refused this caller:
// the table is demonstrably there and a role or ACL grant is what is missing.
// A namespace 404 resolved to no resource at all, and `classifyTable` words
// that under both of its own readings — not installed, or not resolvable from
// this caller's scope. Granting a read role on a table nothing exposes changes
// nothing, so the two send an operator to two unrelated places.
//
// What these tests hold is the SPLIT, not the sentences carrying it: every
// blocked table appears in the population its own outcome names and in no
// other; a population with no members is not reported at all; each population
// counts what it actually lists; and the verdict is the one the single merged
// list produced, for every mix. The one piece of wording they do depend on is
// the structure the finding publishes to make the split recoverable at all —
// `DoctorFinding.evidence` is a single flat string, so " | " between groups
// and ": " between a group's direction and its entries IS the contract, and a
// reader who cannot parse it cannot get the two populations apart.

const GROUP_SEPARATOR = " | ";

/** The evidence as its named groups: `<direction>: <entry>; <entry>`. */
function blockedGroups(evidence) {
  return evidence.split(GROUP_SEPARATOR).map((group) => {
    const at = group.indexOf(": ");
    assert.ok(
      at > 0,
      `a group must name its own population before listing it: ${group}`,
    );
    return {
      direction: group.slice(0, at),
      entries: group.slice(at + 2).split("; "),
    };
  });
}

/**
 * Which of the injected tables a group actually lists.
 *
 * The match is on a whole table name and not on a substring: the catalogue
 * holds `sys_atf_test`, `sys_atf_test_suite` and `sys_atf_test_suite_test`,
 * so a substring test would find the shortest of them inside every entry
 * naming a longer one and report a table as belonging to both populations.
 * `_` is a word character, so a `\b` on each side is exactly the boundary
 * that separates these three from one another.
 */
function tablesIn(group, candidates) {
  return candidates.filter((table) => {
    const named = new RegExp(`\\b${table}\\b`);
    return group.entries.some((entry) => named.test(entry));
  });
}

const denyRead = (table) => ({
  match: { table },
  mode: { kind: "http-error", status: 403, message: "denied" },
});

const notAResource = (table) => ({
  match: { table },
  mode: {
    kind: "http-error",
    status: 404,
    body: namespace404Body(`/api/now/table/${table}`),
  },
});

/**
 * Every shape of blocked population there is: one of each kind alone, both at
 * once, and several of each — the last because a group that counted the OTHER
 * population, or listed it, is only visible once the two sizes differ from one
 * another and from the total.
 */
/**
 * Which remedy direction belongs to which population, and which belongs to the
 * OTHER one.
 *
 * These are the only sentences in this file's assertions, and they are here
 * because the direction IS a sentence: naming a population apart is worth
 * nothing if the name and the remedy attached to it can be handed to the wrong
 * group, and nothing but the words distinguishes "the instance refused you" —
 * ask for a role — from "nothing resolved at that URI" — ask whether it is
 * installed and in scope. So each group is required to carry its own two marks
 * and NEITHER of the other's; how the rest of the clause is phrased is left
 * free.
 */
const DIRECTIONS = {
  denied: {
    own: [/read refused/, /role or ACL grant/],
    foreign: [/not a resource for/, /plugin or this caller's scope/],
  },
  absent: {
    own: [/not a resource for/, /plugin or this caller's scope/],
    foreign: [/read refused/, /role or ACL grant/],
  },
};

const BLOCKED_MIXES = [
  { label: "refused only", denied: ["sys_atf_step"], absent: [] },
  { label: "missing only", denied: [], absent: ["sys_atf_test_suite"] },
  {
    label: "one of each",
    denied: ["sys_atf_step"],
    absent: ["sys_atf_test_suite"],
  },
  {
    label: "several of each",
    denied: ["sys_atf_step", "sys_atf_test"],
    absent: ["sys_atf_test_suite", "sys_atf_test_suite_test"],
  },
];

describe("sn-client probe — the ATF tables, blocked two ways", () => {
  for (const mix of BLOCKED_MIXES) {
    it(`keeps each blocked table in its own population — ${mix.label}`, async () => {
      const h = withFake({ atfRunnerEnabled: true });
      try {
        for (const table of mix.denied) h.fake.faults.add(denyRead(table));
        for (const table of mix.absent) h.fake.faults.add(notAResource(table));

        const finding = await atfTablesPrecondition(h.probe).probe();
        const groups = blockedGroups(finding.evidence);

        // A population with nothing in it is not a finding, so it is not a
        // line: exactly as many groups as there are populations with members.
        const populated = [mix.denied, mix.absent].filter(
          (tables) => tables.length > 0,
        );
        assert.equal(
          groups.length,
          populated.length,
          `expected ${populated.length} group(s):\n${finding.evidence}`,
        );

        // The split itself. Each group lists one population WHOLE and the
        // other NOT AT ALL — which is precisely what one merged list could
        // not do, and what an operator needs before they know whether they
        // are looking at a role grant or an install.
        for (const tables of populated) {
          const other = tables === mix.denied ? mix.absent : mix.denied;
          const owner = groups.filter(
            (group) => tablesIn(group, tables).length > 0,
          );
          assert.equal(
            owner.length,
            1,
            `${tables.join(", ")} must live in exactly one group:\n${finding.evidence}`,
          );
          assert.deepEqual(
            tablesIn(owner[0], tables).sort(),
            [...tables].sort(),
            `a group must list its whole population:\n${finding.evidence}`,
          );
          assert.deepEqual(
            tablesIn(owner[0], other),
            [],
            `a group must not list the other population:\n${finding.evidence}`,
          );
        }

        // Two populations, two different directions — the whole point of
        // naming them apart is that they do not send an operator to the same
        // place, so identical directions would be a split in form only.
        if (groups.length === 2) {
          assert.notEqual(
            groups[0].direction,
            groups[1].direction,
            `two populations must not be given one direction:\n${finding.evidence}`,
          );
        }
      } finally {
        h.restore();
      }
    });

    it(`counts each population by what it lists — ${mix.label}`, async () => {
      const h = withFake({ atfRunnerEnabled: true });
      try {
        for (const table of mix.denied) h.fake.faults.add(denyRead(table));
        for (const table of mix.absent) h.fake.faults.add(notAResource(table));

        const finding = await atfTablesPrecondition(h.probe).probe();

        for (const group of blockedGroups(finding.evidence)) {
          const counted = /(\d+) of (\d+) table\(s\)/.exec(group.direction);
          assert.ok(counted, `a group must count itself: ${group.direction}`);
          assert.equal(
            Number(counted[1]),
            group.entries.length,
            `a group's count is a claim about its own list:\n${finding.evidence}`,
          );
          assert.equal(
            Number(counted[2]),
            ATF_AUTHORING_TABLES.length,
            `the denominator is the whole catalogue:\n${finding.evidence}`,
          );
        }

        // The mirror of omitting an empty group: no surviving group may report
        // a population of none. "0 of 5" is evidence about nothing.
        assert.doesNotMatch(finding.evidence, /\b0 of \d+ table\(s\)/);
      } finally {
        h.restore();
      }
    });

    it(`resolves the verdict the merged list resolved — ${mix.label}`, async () => {
      const h = withFake({ atfRunnerEnabled: true });
      try {
        for (const table of mix.denied) h.fake.faults.add(denyRead(table));
        for (const table of mix.absent) h.fake.faults.add(notAResource(table));

        const finding = await atfTablesPrecondition(h.probe).probe();

        // Splitting the EVIDENCE may not move the verdict: both outcomes were
        // `not-ready` when they shared a line and both are `not-ready` now.
        assert.equal(finding.status, "not-ready");
        // Nor may it invent a remedy. No table write creates a table or grants
        // a role, so there is still no action to point `Provisioner.plan()` at.
        assert.equal(finding.remedy, undefined);
      } finally {
        h.restore();
      }
    });

    it(`points each population at its own remedy — ${mix.label}`, async () => {
      const h = withFake({ atfRunnerEnabled: true });
      try {
        for (const table of mix.denied) h.fake.faults.add(denyRead(table));
        for (const table of mix.absent) h.fake.faults.add(notAResource(table));

        const finding = await atfTablesPrecondition(h.probe).probe();

        for (const group of blockedGroups(finding.evidence)) {
          // A group is identified by what it LISTS, never by what it says, so
          // a direction that has drifted onto the wrong population is caught
          // rather than assumed away.
          const outcome =
            tablesIn(group, mix.denied).length > 0 ? "denied" : "absent";
          for (const mark of DIRECTIONS[outcome].own) {
            assert.match(
              group.direction,
              mark,
              `the ${outcome} population must state its own remedy:\n${finding.evidence}`,
            );
          }
          for (const mark of DIRECTIONS[outcome].foreign) {
            assert.doesNotMatch(
              group.direction,
              mark,
              `the ${outcome} population must not state the other's remedy:\n${finding.evidence}`,
            );
          }
        }
      } finally {
        h.restore();
      }
    });
  }

  it("still lets an undecided probe outrank both blocked populations", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      h.fake.faults.add(denyRead("sys_atf_step"));
      h.fake.faults.add(notAResource("sys_atf_test_suite"));
      h.fake.faults.add({
        match: { table: "sys_atf_test_result" },
        mode: { kind: "http-error", status: 500, message: "internal error" },
      });

      const finding = await atfTablesPrecondition(h.probe).probe();

      // The precedence the split must not disturb: "some of these are
      // unreadable" is a claim you cannot make while part of the evidence is
      // missing, however neatly the readable part divides.
      assert.equal(finding.status, "unknown");
      assert.match(finding.evidence, /could not decide for 1 of 5 table\(s\)/);
      // And the undecided line is not a blocked group wearing its label.
      assert.doesNotMatch(finding.evidence, /read refused for/);
      assert.doesNotMatch(finding.evidence, /not a resource for \d+ of/);
    } finally {
      h.restore();
    }
  });

  it("reports no blocked population when every table is readable", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      const finding = await atfTablesPrecondition(h.probe).probe();

      assert.equal(finding.status, "ready");
      // An empty population is omitted, and `ready` is the case where BOTH
      // are empty — a green finding that named either of them would be
      // reporting a refusal nobody made.
      assert.doesNotMatch(finding.evidence, /read refused for/);
      assert.doesNotMatch(finding.evidence, /not a resource for \d+ of/);
      assert.equal(finding.evidence.includes(GROUP_SEPARATOR), false);
    } finally {
      h.restore();
    }
  });
});

// The two classifiers in `src/probe.ts` split this status on one
// discriminator, and `classifyApi` states the rule: "the same shape as
// `classifyTable`, and deliberately so: one question, and the two probes must
// not drift into answering it differently". They are exercised in one test for
// the same reason the status-less pair above is — split in two, one can be
// fixed and the other left, each still green on its own.
//
// What they share is a PROHIBITION, not a verdict: neither may read absence
// out of a 404 that does not carry the namespace wording. What each may
// conclude instead differs legitimately, because they ask different questions
// — a record-level 404 proves a REST namespace is live, while the same body on
// a list read says nothing whatever about the table — so the rounds below pin
// each answer as well as the property both must keep.
describe("sn-client probe — 404 is two answers, not one", () => {
  it("lets only the namespace wording mean absence, on both probes", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      // Rules are evaluated in insertion order and each fires once, so the
      // first read of each pair meets the namespace body and the second meets
      // a 404 that says nothing about the namespace.
      for (const body of [
        namespace404Body("/api/now/table/sys_atf_step"),
        noRecordFoundBody(),
      ]) {
        h.fake.faults.add({
          match: { table: "sys_atf_step", times: 1 },
          mode: { kind: "http-error", status: 404, body },
        });
      }
      for (const body of [
        namespace404Body(CICD_PROBE_PATH),
        noRecordFoundBody(),
      ]) {
        h.fake.faults.add({
          match: { path: CICD_PROBE_PATH, times: 1 },
          mode: { kind: "http-error", status: 404, body },
        });
      }

      const rounds = [
        [
          "namespace 404",
          [
            ["readTable", await h.probe.readTable("sys_atf_step"), "absent"],
            ["reachApi", await h.probe.reachApi(CICD_PROBE_PATH), "absent"],
          ],
        ],
        [
          "record 404",
          [
            [
              "readTable",
              await h.probe.readTable("sys_atf_step"),
              "undecidable",
            ],
            ["reachApi", await h.probe.reachApi(CICD_PROBE_PATH), "present"],
          ],
        ],
      ];

      let checked = 0;
      for (const [round, probes] of rounds) {
        for (const [label, probed, expected] of probes) {
          const where = `${round}/${label}`;
          assert.equal(probed.outcome, expected, where);
          // The status is identical in both rounds. That is the whole point:
          // it is a fact about the answer and not about the resource, so no
          // conclusion about the resource may be read off it.
          assert.equal(probed.status, 404, where);
          if (round === "record 404") {
            assert.notEqual(probed.outcome, "absent", where);
            assert.doesNotMatch(probed.detail, /not a resource/, where);
            assert.doesNotMatch(probed.detail, /not present/, where);
          }
          checked += 1;
        }
      }
      // The loops assert nothing at all if they never run.
      assert.equal(checked, 4);
      // Every answer above came from an injected fault at the wire, so none of
      // them is the fake's own routing agreeing by accident.
      assert.equal(h.fake.requests().filter((r) => r.fault).length, 4);
    } finally {
      h.restore();
    }
  });
});

describe("the default catalogue against the fake", () => {
  it("is ready for a unit run, declares the deferred rows, and writes nothing", async () => {
    const h = withFake({ atfRunnerEnabled: true, authoringChannel: "1.0.0" });
    try {
      const doctor = createEnvironmentDoctor(
        createDefaultPreconditions(h.probe),
      );
      const report = await doctor.diagnose({ kinds: ["unit"] });

      assert.equal(report.status, "ready");
      assert.equal(report.hardFailure, undefined);
      assert.equal(report.findings.length, 6);
      assert.deepEqual(
        report.findings
          .filter((f) => f.applicability === "deferred")
          .map((f) => f.precondition),
        [PRECONDITION_IDS.browserTestRunner, PRECONDITION_IDS.harnessScopedApp],
      );
      // ADR-007 C3 promoted (delegated decision 2026-09-23): the channel is a
      // required, probed row for `unit`, no longer a deferred one.
      const channel = report.findings.find(
        (f) => f.precondition === PRECONDITION_IDS.authoringChannel,
      );
      assert.equal(channel.applicability, "required");
      assert.equal(channel.status, "ready");
      // ARCH-8: read-only, so it is safe to point at any role including target.
      assert.deepEqual(methods(h.fake), ["GET"]);
    } finally {
      h.restore();
    }
  });

  it("is not ready for a unit run on an instance without the W2 channel (ADR-007 C3)", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      const report = await createEnvironmentDoctor(
        createDefaultPreconditions(h.probe),
      ).diagnose({ kinds: ["unit"] });
      assert.notEqual(report.status, "ready");
      const channel = report.findings.find(
        (f) => f.precondition === PRECONDITION_IDS.authoringChannel,
      );
      assert.equal(channel.status, "not-ready");
      assert.match(channel.evidence, /tessera-authoring-channel/);
      assert.deepEqual(methods(h.fake), ["GET"]);
    } finally {
      h.restore();
    }
  });

  it("refuses a ui run outright while no Test Runner probe exists (DEV-2)", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      const doctor = createEnvironmentDoctor(
        createDefaultPreconditions(h.probe),
      );
      const report = await doctor.diagnose({ kinds: ["ui"] });

      assert.equal(report.status, "unknown");
      assert.match(
        report.hardFailure,
        new RegExp(PRECONDITION_IDS.browserTestRunner),
      );
      assert.equal(
        findingFor(report, PRECONDITION_IDS.browserTestRunner).applicability,
        "required",
      );
      assert.match(
        findingFor(report, PRECONDITION_IDS.browserTestRunner).evidence,
        /arrives in Phase 8/,
      );
    } finally {
      h.restore();
    }
  });

  it("still reports a full findings list when the instance is unreachable", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      h.fake.faults.add({
        match: { path: "/api/" },
        mode: { kind: "transport-error", message: "host unreachable" },
      });
      const doctor = createEnvironmentDoctor(
        createDefaultPreconditions(h.probe),
      );
      const report = await doctor.diagnose();

      assert.equal(report.status, "unknown");
      assert.equal(report.findings.length, 6);
      for (const id of [
        PRECONDITION_IDS.atfRunnerEnabled,
        PRECONDITION_IDS.cicdApi,
        PRECONDITION_IDS.atfTables,
      ]) {
        assert.equal(findingFor(report, id).status, "unknown");
      }
    } finally {
      h.restore();
    }
  });
});

// A `ServiceNowError` has a SECOND way of not meaning "the instance answered",
// and it is quieter than the fabricated 403 above: no `status` at all. The
// transport raises that same type with `status` unset for a dropped
// connection, a timeout, and a request that never left this client (an
// unconfigured instance, missing credentials, host policy). None of those is
// the instance saying anything, so neither `AccessProbe.status` nor
// `ApiProbe.status` — both of which mean "what the instance answered with" —
// may be filled in from one, and no detail line may quote it.
//
// Both classifiers are exercised by one test on purpose. `src/probe.ts` says
// `classifyApi` has "the same shape as `classifyTable`, and deliberately so:
// one question, and the two probes must not drift into answering it
// differently". Two tests would let one be fixed and the other left, each
// still green on its own; this one fails the moment they disagree.
describe("sn-client probe — a rejection that carries no status", () => {
  it("never attributes a status to a probe the instance never answered", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      h.fake.faults.add({
        match: { table: "sys_atf_step" },
        mode: { kind: "transport-error", message: "socket hang up" },
      });
      h.fake.faults.add({
        match: { path: CICD_PROBE_PATH },
        mode: { kind: "transport-error", message: "socket hang up" },
      });

      const table = await h.probe.readTable("sys_atf_step");
      const api = await h.probe.reachApi(CICD_PROBE_PATH);

      for (const [label, probed] of [
        ["readTable", table],
        ["reachApi", api],
      ]) {
        // Not rounded up to an answer, and not down to a refusal either.
        assert.equal(probed.outcome, "undecidable", label);
        // The key's PRESENCE is itself the claim that a status was observed,
        // so `status: undefined` would not be good enough: a caller spreading
        // this object cannot tell that apart from one the instance answered.
        assert.ok(!("status" in probed), `${label} carries a status key`);
        assert.doesNotMatch(probed.detail, /undefined/, label);
        assert.doesNotMatch(probed.detail, /refused \(/, label);
        assert.doesNotMatch(probed.detail, /no read access/, label);
        // It states the one fact it has — nothing came back — and declines to
        // pick between the two readings it cannot separate.
        assert.match(probed.detail, /no answer was received/, label);
        assert.match(probed.detail, /never left this client/, label);
        assert.match(probed.detail, /never got a response/, label);
        // The transport's own message survives; it carries the host and the
        // cause, and it is the only part that says where to look.
        assert.match(probed.detail, /socket hang up/, label);
      }

      // Both faults fired at the wire, so each error under test really is a
      // status-less transport failure — not something the client fabricated
      // before a request was sent, which is the other half of this boundary
      // and has its own test above. Exactly two because the harness stages
      // SN_MAX_RETRIES=0; a retry would make this a test of the retry.
      assert.equal(h.fake.requests().filter((r) => r.fault).length, 2);
    } finally {
      h.restore();
    }
  });
});

// ── remedy claims ───────────────────────────────────────────────────────────
//
// The remedy is the one line an operator ACTS on, so it is held to a stricter
// standard than the evidence beside it: it may only name a change this run has
// grounds to name. Both properties below are stated over the probe's whole
// outcome union rather than over today's sentences — a suite that pins the
// sentence goes green again the moment somebody writes a different false one.

/** An `InstanceProbe` that answers every read with a fixed outcome. */
function probeAnswering({ property, access, api }) {
  const undecided = { outcome: "undecidable", detail: "stub said nothing" };
  return {
    readProperty: () => Promise.resolve(property ?? undecided),
    readTable: () => Promise.resolve(access ?? undecided),
    reachApi: () => Promise.resolve(api ?? undecided),
  };
}

describe("remedy claims — properties, not sentences", () => {
  it("never attaches a remedy to a finding this run could not decide", async () => {
    // A remedy for a state nobody observed sends the operator somewhere with no
    // basis: there is no reading of the instance behind it to be right about.
    const reads = [
      {
        label: "the instance never answered",
        property: { outcome: "undecidable", detail: "fetch failed" },
        access: { outcome: "undecidable", detail: "fetch failed" },
        api: { outcome: "undecidable", detail: "fetch failed" },
      },
      {
        label: "every read was refused",
        property: { outcome: "denied", detail: "refused (403)" },
        access: { outcome: "denied", status: 403, detail: "refused (403)" },
        api: { outcome: "denied", status: 403, detail: "refused (403)" },
      },
    ];

    let checked = 0;
    for (const read of reads) {
      const doctor = createEnvironmentDoctor(
        createDefaultPreconditions(probeAnswering(read)),
      );
      // `--kind ui` promotes the deferred Phase 8 precondition to required, so
      // undecided-because-nobody-built-the-probe is swept alongside
      // undecided-because-the-instance-said-nothing.
      const report = await doctor.diagnose({ kinds: ["ui"] });
      const undecided = report.findings.filter((f) => f.status === "unknown");
      assert.ok(
        undecided.length > 0,
        `${read.label}: nothing came back unknown, so this case proves nothing`,
      );
      for (const found of undecided) {
        assert.equal(
          found.remedy,
          undefined,
          `${read.label}: ${found.precondition} carries a remedy for a state nobody observed`,
        );
        checked += 1;
      }
    }
    assert.ok(checked > 0, "no undecided finding was examined");
  });

  it("never offers a write against a row the probe could not address", async () => {
    // `kind` commits to a write and `formatDoctorReport` prints it verbatim
    // ("remedy: update sys_properties — …"). That is only true when the probe
    // came back with the identity of a row to update. On every other reading
    // the line has to say so itself, because the operator never sees the probe
    // outcome that produced it — only this sentence.
    const reads = [
      {
        label: "row observed with an identity",
        addressable: true,
        property: {
          outcome: "found",
          value: "false",
          sysId: "1".repeat(32),
          detail: `${ATF_RUNNER_ENABLED_PROPERTY}=false`,
        },
      },
      {
        label: "row observed, sys_id trimmed off",
        addressable: false,
        property: {
          outcome: "found",
          value: "false",
          detail: `${ATF_RUNNER_ENABLED_PROPERTY}=false`,
        },
      },
      {
        label: "no row came back at all",
        addressable: false,
        property: {
          outcome: "absent",
          detail: `no readable sys_properties row named ${ATF_RUNNER_ENABLED_PROPERTY}`,
        },
      },
    ];

    let judged = 0;
    for (const read of reads) {
      const finding = await atfRunnerEnabledPrecondition(
        probeAnswering(read),
      ).probe();
      assert.ok(finding.remedy, `${read.label}: expected a remedy to judge`);
      judged += 1;
      const { kind, description } = finding.remedy.action;
      assert.equal(kind, "update", `${read.label}: the case under test`);
      if (read.addressable) {
        // The other half of the property, and the more expensive one to lose:
        // a remedy that IS a write must not be hedged into uselessness because
        // its neighbours had to be.
        assert.doesNotMatch(
          description,
          /not a write that will happen/,
          `${read.label}: a remedy backed by an observed row disclaimed itself`,
        );
        continue;
      }
      assert.match(
        description,
        /not a write that will happen/,
        `${read.label}: "${kind} sys_properties" is offered for a row this run cannot address`,
      );
    }
    assert.equal(judged, reads.length);
  });
});

// ── the namespace wording, wherever the body puts it ─────────────────────────
//
// The property: a namespace 404 is recognised as one no matter WHICH field of
// the error body carries the wording. Not "the classifier does what it does" —
// the two placements must be indistinguishable to it.
//
// Why the property can be violated at all: `extractErrorDetail`
// (`@tessera/sn-client`'s `core/http.ts`) PREFERS `error.message` and only
// falls back to `error.detail`, so a body that carries the wording in `detail`
// alone reaches the classifier with a `ServiceNowError.message` that says
// nothing about a namespace — while `ServiceNowError.detail`, the whole parsed
// body, still holds it. `api/plugin.ts` composes message plus body and catches
// those; these classifiers tested the message alone and did not. On
// `cicdApiPrecondition` that divergence was a false `ready`: the doctor cleared
// the run while the CI/CD plugin was inactive, and DR-2 leaves no other way to
// trigger a suite, so the run died later with the doctor's green behind it.
//
// The third body is the control. Without it every assertion below would still
// pass if the classifier simply called every 404 a namespace 404 — the failure
// mode on the other side, and the one that turns a live API into a false
// `not-ready`.
const NAMESPACE_PHRASE =
  "The requested URI does not represent any resource on the server";
const RECORD_PHRASE = "No Record found";
const RECORD_DETAIL =
  "Record doesn't exist or ACL restricts the record retrieval";

// NAMESPACE_404 has two alternatives and a real instance uses both. The two
// placements below therefore carry a different half each: the message carries
// "does not represent any resource", the detail carries "Invalid URI". Give
// both placements the same phrasing and half the pattern goes untested.
const NAMESPACE_DETAIL_PHRASE = "Invalid URI: /api/sn_cicd/testsuite/results/x";

/** The SN error body shape, with the namespace wording placed where asked. */
function bodyWithWordingIn(where) {
  return {
    error: {
      message: where === "message" ? NAMESPACE_PHRASE : RECORD_PHRASE,
      detail: where === "detail" ? NAMESPACE_DETAIL_PHRASE : RECORD_DETAIL,
    },
    status: "failure",
  };
}

/** Both placements, then the control — one fault each, in that order. */
const WORDING_PLACEMENTS = ["message", "detail", "nowhere"];

describe("sn-client probe — the namespace wording, in message or in detail", () => {
  it("classifies a table 404 the same whichever field carries the wording", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      for (const where of WORDING_PLACEMENTS) {
        h.fake.faults.add({
          match: { table: "sys_atf_step", times: 1 },
          mode: {
            kind: "http-error",
            status: 404,
            body: bodyWithWordingIn(where),
          },
        });
      }

      const fromMessage = await h.probe.readTable("sys_atf_step");
      const fromDetail = await h.probe.readTable("sys_atf_step");
      const control = await h.probe.readTable("sys_atf_step");

      // The property, stated as an equality: the placement is invisible to the
      // classifier. This is what fails if the match narrows back to
      // `error.message` — `fromDetail` becomes `undecidable` while
      // `fromMessage` stays `absent`.
      assert.deepEqual(
        fromDetail,
        fromMessage,
        "a namespace 404 was read differently depending on which field of the body carried the wording",
      );
      assert.equal(fromMessage.outcome, "absent");
      // Control: a body with the wording nowhere must NOT be read as absence,
      // or the equality above is satisfied by a classifier that says "absent"
      // to every 404.
      assert.equal(control.outcome, "undecidable");
      assert.notDeepEqual(control, fromMessage);
    } finally {
      h.restore();
    }
  });

  it("classifies an API 404 the same whichever field carries the wording", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      for (const where of WORDING_PLACEMENTS) {
        h.fake.faults.add({
          match: { path: CICD_PROBE_PATH, times: 1 },
          mode: {
            kind: "http-error",
            status: 404,
            body: bodyWithWordingIn(where),
          },
        });
      }

      const fromMessage = await h.probe.reachApi(CICD_PROBE_PATH);
      const fromDetail = await h.probe.reachApi(CICD_PROBE_PATH);
      const control = await h.probe.reachApi(CICD_PROBE_PATH);

      assert.deepEqual(
        fromDetail,
        fromMessage,
        "a namespace 404 was read differently depending on which field of the body carried the wording",
      );
      assert.equal(fromMessage.outcome, "absent");
      // A record-level 404 proves the namespace answered — the opposite
      // conclusion, and the one a wording-blind classifier would lose.
      assert.equal(control.outcome, "present");
    } finally {
      h.restore();
    }
  });

  // The divergence had one consequence an operator actually meets, and it is
  // this finding: `ready` means "Tessera can trigger a suite". A body carrying
  // the wording only in `detail` used to produce exactly that while the plugin
  // was inactive.
  it("never reports the CI/CD API ready on a 404 whose detail says the namespace is absent", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      h.fake.faults.add({
        match: { path: CICD_PROBE_PATH },
        mode: {
          kind: "http-error",
          status: 404,
          body: bodyWithWordingIn("detail"),
        },
      });

      const finding = await cicdApiPrecondition(h.probe).probe();
      // Stated as the prohibition first: whatever else this finding is, it is
      // not a green. `ready` here is the claim that a suite can be launched.
      assert.notEqual(
        finding.status,
        "ready",
        "the doctor cleared the run on a 404 that says the CI/CD namespace is not there",
      );
      assert.equal(finding.status, "not-ready");
      assert.match(finding.evidence, /plugin is inactive/);
      assert.match(finding.evidence, /no other way to trigger a suite/);
      // Activating a plugin is not a table write (ARCH-33).
      assert.equal(finding.remedy, undefined);
    } finally {
      h.restore();
    }
  });

  // Same wording, same placement, and the answer must be the one the canonical
  // transport gives. `api/plugin.ts` composes `message + JSON.stringify(detail)`
  // and this is that string's only other reader in the monorepo; if the two
  // ever answer differently, one of them is wrong and no test above would say
  // which.
  it("agrees with the vendored transport on the same body", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      for (const where of WORDING_PLACEMENTS) {
        const body = bodyWithWordingIn(where);
        // What `core/http.ts` hands the classifier: the message it derived
        // (message preferred, detail as fallback) and the whole parsed body.
        const derivedMessage = `ServiceNow API error (404): ${body.error.message}`;
        const transportSaysNamespace =
          /does not represent any resource|invalid uri/i.test(
            `${derivedMessage} ${JSON.stringify(body)}`,
          );

        h.fake.faults.add({
          match: { path: CICD_PROBE_PATH, times: 1 },
          mode: { kind: "http-error", status: 404, body },
        });
        const probed = await h.probe.reachApi(CICD_PROBE_PATH);
        assert.equal(
          probed.outcome === "absent",
          transportSaysNamespace,
          `wording in ${where}: the doctor and the vendored transport disagree about the same body`,
        );
      }
    } finally {
      h.restore();
    }
  });
});

// ── hardening, delegated decisions 2026-09-25 (fail closed) ─────────────────

/** A precondition whose probe resolves `answer` verbatim. */
function answering(id, answer) {
  return { id, probe: () => Promise.resolve(answer) };
}

describe("a green is earned positively, never by elimination", () => {
  for (const status of ["READY", "ok", undefined, "green", null, 1]) {
    it(`reads probe status ${JSON.stringify(status)} as unknown`, async () => {
      const doctor = createEnvironmentDoctor([
        answering("odd", { precondition: "odd", status, evidence: "garbage" }),
        stub("fine", "ready"),
      ]);
      const report = await doctor.diagnose();
      assert.equal(findingFor(report, "odd").status, "unknown");
      assert.match(findingFor(report, "odd").evidence, /not one of/);
      assert.equal(report.status, "unknown");
    });
  }

  for (const evidence of [undefined, 42, null, ""]) {
    it(`reads evidence ${JSON.stringify(evidence)} as unknown`, async () => {
      const doctor = createEnvironmentDoctor([
        answering("bare", { precondition: "bare", status: "ready", evidence }),
      ]);
      const report = await doctor.diagnose();
      assert.equal(report.status, "unknown");
      assert.match(findingFor(report, "bare").evidence, /no evidence/);
    });
  }

  for (const answer of [null, undefined, "ready"]) {
    it(`reads a non-object answer ${JSON.stringify(answer)} as unknown`, async () => {
      const report = await createEnvironmentDoctor([
        answering("junk", answer),
      ]).diagnose();
      assert.equal(report.status, "unknown");
      assert.match(findingFor(report, "junk").evidence, /instead of a finding/);
    });
  }

  it("rollUp itself never turns an unrecognised status into ready", () => {
    for (const status of ["READY", "ok", undefined, "green"]) {
      const odd = { precondition: "x", status, applicability: "required" };
      const ready = { precondition: "y", status: "ready" };
      const notReady = { precondition: "z", status: "not-ready" };
      assert.equal(rollUp([odd]), "unknown", String(status));
      assert.equal(rollUp([ready, odd]), "unknown", String(status));
      assert.equal(rollUp([notReady, odd]), "unknown", String(status));
    }
    assert.equal(rollUp([{ status: "ready" }, { status: "ready" }]), "ready");
    assert.equal(
      rollUp([{ status: "ready" }, { status: "not-ready" }]),
      "not-ready",
    );
  });
});

describe("a probe that ignores its signal cannot hang diagnose", () => {
  const hangs = (id) => ({ id, probe: () => new Promise(() => {}) });

  it("settles unknown (cancelled) once the caller aborts", async () => {
    const controller = new AbortController();
    const doctor = createEnvironmentDoctor([
      hangs("stuck"),
      stub("fine", "ready"),
    ]);
    const pending = doctor.diagnose({ signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const bound = new Promise((resolve) =>
      setTimeout(() => resolve("still pending"), 2000).unref(),
    );
    const report = await Promise.race([pending, bound]);
    assert.notEqual(report, "still pending", "diagnose hung after abort");
    assert.equal(report.status, "unknown");
    assert.equal(findingFor(report, "stuck").status, "unknown");
    assert.match(findingFor(report, "stuck").evidence, /^cancelled/);
    assert.equal(findingFor(report, "fine").status, "ready");
  });

  it("settles unknown (cancelled) for a signal aborted before diagnose", async () => {
    const report = await createEnvironmentDoctor([hangs("stuck")]).diagnose({
      signal: AbortSignal.abort(),
    });
    assert.equal(report.status, "unknown");
    assert.match(findingFor(report, "stuck").evidence, /^cancelled/);
  });

  it("settles unknown (timed out) without any signal", async () => {
    const started = Date.now();
    const report = await createEnvironmentDoctor([hangs("stuck")], {
      probeTimeoutMs: 20,
    }).diagnose();
    assert.equal(report.status, "unknown");
    assert.match(findingFor(report, "stuck").evidence, /timed out.*20 ms/);
    assert.ok(Date.now() - started < 2000);
  });

  it("removes its abort listener and timer once the probe answers", async () => {
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener: () => void (added += 1),
      removeEventListener: () => void (removed += 1),
    };
    const report = await createEnvironmentDoctor([
      stub("a", "ready"),
      stub("b", "not-ready"),
    ]).diagnose({ signal });
    assert.equal(report.status, "not-ready");
    assert.equal(added, 2);
    assert.equal(removed, 2);
  });

  it("defaults to a finite probe timeout", () => {
    assert.ok(Number.isFinite(DEFAULT_PROBE_TIMEOUT_MS));
    assert.ok(DEFAULT_PROBE_TIMEOUT_MS > 0);
  });

  for (const probeTimeoutMs of [0, -1, NaN, Infinity, "50", 2 ** 31]) {
    it(`refuses probeTimeoutMs ${String(probeTimeoutMs)} at construction`, () => {
      assert.throws(
        () => createEnvironmentDoctor([], { probeTimeoutMs }),
        (error) =>
          error instanceof DoctorContractError &&
          /probeTimeoutMs/.test(error.message),
      );
    });
  }
});

describe('sn_atf.runner.enabled — only "true" enables', () => {
  const cases = [
    ["true", "ready"],
    [" TRUE ", "ready"],
    ["false", "not-ready"],
    ["", "not-ready"],
    ["yes", "unknown"],
    ["1", "unknown"],
    ["on", "unknown"],
    ["enabled", "unknown"],
  ];
  for (const [value, expected] of cases) {
    it(`reads ${JSON.stringify(value)} as ${expected}`, async () => {
      const h = withFake({ atfRunnerEnabled: value });
      try {
        const finding = await atfRunnerEnabledPrecondition(h.probe).probe();
        assert.equal(finding.status, expected);
        if (expected === "not-ready") assert.ok(finding.remedy);
        if (expected === "unknown") {
          assert.equal(finding.remedy, undefined);
          assert.match(finding.evidence, /neither "true" nor "false"/);
        }
      } finally {
        h.restore();
      }
    });
  }
});

describe("readProperty — no encoded-query injection", () => {
  for (const name of [
    "no.such.prop^ORname=sn_atf.runner.enabled",
    "x^NQname=sn_atf.runner.enabled",
    "a=b",
    "",
    "sn atf",
    "prop\n",
  ]) {
    it(`refuses ${JSON.stringify(name)} without touching the wire`, async () => {
      const h = withFake({ atfRunnerEnabled: true });
      try {
        const before = h.fake.requests().length;
        const read = await h.probe.readProperty(name);
        assert.equal(read.outcome, "undecidable");
        assert.match(read.detail, /refused to query/);
        assert.equal(h.fake.requests().length, before);
      } finally {
        h.restore();
      }
    });
  }

  it("does not report a row that answers for a different name as found", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    const installed = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          result: [
            {
              sys_id: "a".repeat(32),
              name: "sn_atf.runner.enabled",
              value: "true",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    try {
      const read = await h.probe.readProperty("some.other.prop");
      assert.equal(read.outcome, "undecidable");
      assert.match(read.detail, /row named "sn_atf.runner.enabled"/);
    } finally {
      globalThis.fetch = installed;
      h.restore();
    }
  });

  it("still finds a plainly named property", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      const read = await h.probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY);
      assert.equal(read.outcome, "found");
      assert.equal(read.value, "true");
    } finally {
      h.restore();
    }
  });
});

// ── duplicate sys_properties rows ───────────────────────────────────────────

const ROW_A = "a".repeat(32);
const ROW_B = "b".repeat(32);
const PRODUCTION = "glide.installation.production";

/** Two rows for one property name, in the given order. */
function twoRows(name, first, second) {
  return [
    { sys_id: ROW_A, name, value: first },
    { sys_id: ROW_B, name, value: second },
  ];
}

describe("sn-client probe — duplicate sys_properties rows", () => {
  it("reads more than one row, so a duplicate is seen", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      await h.probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY);
      const [request] = h.fake
        .requests()
        .filter((r) => r.path.includes("sys_properties"));
      // Ten compared, plus the row that proves there are more (wave 14).
      assert.equal(request.params.sysparm_limit, "11");
    } finally {
      h.restore();
    }
  });

  for (const order of [
    ["true", "false"],
    ["false", "true"],
  ]) {
    it(`differing runner rows ${order.join("/")} are not-ready and named`, async () => {
      const h = withFake({
        properties: twoRows(ATF_RUNNER_ENABLED_PROPERTY, ...order),
      });
      try {
        const read = await h.probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY);
        assert.equal(read.outcome, "undecidable");
        assert.equal(read.duplicates, "differing");
        assert.deepEqual(
          read.rows.map((r) => r.sysId),
          [ROW_A, ROW_B],
        );
        const finding = await atfRunnerEnabledPrecondition(h.probe).probe();
        assert.equal(finding.status, "not-ready");
        assert.match(finding.evidence, /2 rows with differing values/);
        assert.ok(finding.evidence.includes(ROW_A));
        assert.ok(finding.evidence.includes(ROW_B));
        assert.match(finding.remedy.action.description, /duplicate/);
      } finally {
        h.restore();
      }
    });
  }

  it("identical runner duplicates read as one value", async () => {
    const h = withFake({
      properties: twoRows(ATF_RUNNER_ENABLED_PROPERTY, "true", " TRUE"),
    });
    try {
      const read = await h.probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY);
      assert.equal(read.outcome, "found");
      assert.equal(read.duplicates, "identical");
      assert.equal(read.rows.length, 2);
      const finding = await atfRunnerEnabledPrecondition(h.probe).probe();
      assert.equal(finding.status, "ready");
    } finally {
      h.restore();
    }
  });

  it("identical false duplicates are not-ready, and the remedy names the duplicates", async () => {
    const h = withFake({
      properties: twoRows(ATF_RUNNER_ENABLED_PROPERTY, "false", "false"),
    });
    try {
      const finding = await atfRunnerEnabledPrecondition(h.probe).probe();
      assert.equal(finding.status, "not-ready");
      assert.match(finding.remedy.action.description, /duplicate/);
    } finally {
      h.restore();
    }
  });

  for (const order of [
    ["false", "true"],
    ["true", "false"],
  ]) {
    it(`production rows ${order.join("/")}: any true means production`, async () => {
      const h = withFake({ properties: twoRows(PRODUCTION, ...order) });
      try {
        const read = await h.probe.readProperty(PRODUCTION);
        assert.equal(read.outcome, "found");
        assert.equal(read.value, "true");
        assert.equal(read.duplicates, "differing");
        assert.match(read.detail, /differing values/);
      } finally {
        h.restore();
      }
    });
  }

  it("production rows false/garbage: never reads as false", async () => {
    const h = withFake({ properties: twoRows(PRODUCTION, "false", "maybe") });
    try {
      const read = await h.probe.readProperty(PRODUCTION);
      assert.equal(read.outcome, "found");
      assert.notEqual(read.value.trim().toLowerCase(), "false");
    } finally {
      h.restore();
    }
  });

  it("production rows maybe/true: a row reading true is the one reported", async () => {
    const h = withFake({ properties: twoRows(PRODUCTION, "maybe", "true") });
    try {
      const read = await h.probe.readProperty(PRODUCTION);
      assert.equal(read.outcome, "found");
      assert.equal(read.value, "true");
      assert.equal(read.sysId, ROW_B);
    } finally {
      h.restore();
    }
  });

  it("identical production duplicates keep their reading", async () => {
    const h = withFake({ properties: twoRows(PRODUCTION, "false", "false") });
    try {
      const read = await h.probe.readProperty(PRODUCTION);
      assert.equal(read.outcome, "found");
      assert.equal(read.value, "false");
      assert.equal(read.duplicates, "identical");
    } finally {
      h.restore();
    }
  });

  it("a single row carries no duplicate marker", async () => {
    const h = withFake({ atfRunnerEnabled: true });
    try {
      const read = await h.probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY);
      assert.equal(read.outcome, "found");
      assert.equal(read.duplicates, undefined);
      assert.equal(read.rows, undefined);
    } finally {
      h.restore();
    }
  });

  it("differing authoring-channel version rows are not-ready and named", async () => {
    const h = withFake({
      properties: twoRows(AUTHORING_CHANNEL_VERSION_PROPERTY, "1.0.0", "2.0.0"),
    });
    try {
      const [channel] = createDefaultPreconditions(h.probe).filter(
        (p) => p.id === PRECONDITION_IDS.authoringChannel,
      );
      const finding = await channel.probe();
      assert.equal(finding.status, "not-ready");
      assert.match(finding.evidence, /differing values/);
      assert.ok(finding.evidence.includes(ROW_B));
    } finally {
      h.restore();
    }
  });
});

// ── the row limit: complete or fail-closed (wave 14) ────────────────────────

/** `count` rows for `name`; `values(i)` gives row i's value. */
function manyRows(name, count, values) {
  return Array.from({ length: count }, (_, i) => ({
    sys_id: String(i).padStart(32, "0"),
    name,
    value: values(i),
  }));
}

/**
 * Answer every request with `rows`, and an X-Total-Count only when `total` is
 * given — the fake always sends the header and counts after its read ACL, so
 * the no-header and short-page shapes need a hand-built response.
 */
async function withStubbedRows(rows, total, run) {
  const h = withFake({ atfRunnerEnabled: true });
  const installed = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ result: rows }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        ...(total === undefined ? {} : { "x-total-count": String(total) }),
      },
    });
  try {
    return await run(h.probe);
  } finally {
    globalThis.fetch = installed;
    h.restore();
  }
}

describe("sn-client probe — property row limit (wave 14)", () => {
  it("compares ten rows and reads one more", () => {
    assert.equal(PROPERTY_ROW_LIMIT, 10);
    assert.equal(PROPERTY_READ_LIMIT, 11);
  });

  it("ten agreeing rows are still one value (the boundary is not a refusal)", async () => {
    const h = withFake({
      properties: manyRows(ATF_RUNNER_ENABLED_PROPERTY, 10, () => "true"),
    });
    try {
      const read = await h.probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY);
      assert.equal(read.outcome, "found");
      assert.equal(read.duplicates, "identical");
      assert.equal(read.rows.length, 10);
      const finding = await atfRunnerEnabledPrecondition(h.probe).probe();
      assert.equal(finding.status, "ready");
    } finally {
      h.restore();
    }
  });

  it("an eleventh row that differs is seen, and the runner does NOT pass", async () => {
    const h = withFake({
      properties: manyRows(ATF_RUNNER_ENABLED_PROPERTY, 11, (i) =>
        i === 10 ? "false" : "true",
      ),
    });
    try {
      const read = await h.probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY);
      assert.equal(read.outcome, "undecidable");
      assert.equal(read.value, undefined);
      assert.match(
        read.detail,
        /read for sn_atf\.runner\.enabled matched more than 10 rows/,
      );
      assert.match(read.detail, /X-Total-Count reports 11/);
      assert.match(read.detail, /no value is read from an incomplete read/);
      const finding = await atfRunnerEnabledPrecondition(h.probe).probe();
      assert.notEqual(finding.status, "ready");
      assert.equal(finding.status, "unknown");
    } finally {
      h.restore();
    }
  });

  it("eleven AGREEING rows are still refused — the twelfth is out of sight", async () => {
    const h = withFake({
      properties: manyRows(ATF_RUNNER_ENABLED_PROPERTY, 12, (i) =>
        i === 11 ? "false" : "true",
      ),
    });
    try {
      const read = await h.probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY);
      assert.equal(read.outcome, "undecidable");
      assert.match(read.detail, /X-Total-Count reports 12/);
      const finding = await atfRunnerEnabledPrecondition(h.probe).probe();
      assert.notEqual(finding.status, "ready");
    } finally {
      h.restore();
    }
  });

  it("overflow without X-Total-Count is still refused (the extra row decides)", async () => {
    const rows = manyRows(ATF_RUNNER_ENABLED_PROPERTY, 11, () => "true");
    const read = await withStubbedRows(rows, undefined, (probe) =>
      probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY),
    );
    assert.equal(read.outcome, "undecidable");
    assert.match(read.detail, /the instance sent no X-Total-Count/);
  });

  it("ten rows under a larger X-Total-Count are refused as a short read", async () => {
    const rows = manyRows(ATF_RUNNER_ENABLED_PROPERTY, 10, () => "true");
    const read = await withStubbedRows(rows, 11, (probe) =>
      probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY),
    );
    assert.equal(read.outcome, "undecidable");
    assert.match(
      read.detail,
      /came back short: X-Total-Count reports 11 matching rows but only 10 were returned/,
    );
  });

  it("a single row under a larger X-Total-Count is refused", async () => {
    const rows = manyRows(ATF_RUNNER_ENABLED_PROPERTY, 1, () => "true");
    const read = await withStubbedRows(rows, 2, (probe) =>
      probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY),
    );
    assert.equal(read.outcome, "undecidable");
    assert.match(read.detail, /came back short/);
  });

  for (const [count, total] of [
    [10, 10],
    [10, undefined],
    [1, 1],
    [2, 1],
  ]) {
    it(`${count} rows with X-Total-Count ${String(total)} are complete`, async () => {
      const rows = manyRows(ATF_RUNNER_ENABLED_PROPERTY, count, () => "true");
      const read = await withStubbedRows(rows, total, (probe) =>
        probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY),
      );
      assert.equal(read.outcome, "found");
      assert.equal(read.value, "true");
    });
  }

  it("production: ten false rows and an eleventh true reads production", async () => {
    const h = withFake({
      properties: manyRows(PRODUCTION, 11, (i) =>
        i === 10 ? "true" : "false",
      ),
    });
    try {
      const read = await h.probe.readProperty(PRODUCTION);
      assert.equal(read.outcome, "found");
      assert.equal(read.value, "true");
      assert.equal(read.sysId, String(10).padStart(32, "0"));
      assert.match(read.detail, /more than 10 rows/);
      assert.match(read.detail, /the production direction/);
    } finally {
      h.restore();
    }
  });

  it("production: eleven false rows never read as false", async () => {
    const h = withFake({
      properties: manyRows(PRODUCTION, 12, (i) =>
        i === 11 ? "true" : "false",
      ),
    });
    try {
      const read = await h.probe.readProperty(PRODUCTION);
      assert.equal(read.outcome, "undecidable");
      assert.equal(read.value, undefined);
    } finally {
      h.restore();
    }
  });

  it("production: an odd seen value wins over false on an incomplete read", async () => {
    const h = withFake({
      properties: manyRows(PRODUCTION, 11, (i) =>
        i === 3 ? "maybe" : "false",
      ),
    });
    try {
      const read = await h.probe.readProperty(PRODUCTION);
      assert.equal(read.outcome, "found");
      assert.equal(read.value, "maybe");
    } finally {
      h.restore();
    }
  });

  it("production: a true row beats an earlier odd one on an incomplete read", async () => {
    const h = withFake({
      properties: manyRows(PRODUCTION, 11, (i) =>
        i === 2 ? "maybe" : i === 5 ? "TRUE" : "false",
      ),
    });
    try {
      const read = await h.probe.readProperty(PRODUCTION);
      assert.equal(read.outcome, "found");
      assert.equal(read.value, "TRUE");
    } finally {
      h.restore();
    }
  });

  it("a non-production property with a true row is still refused on overflow", async () => {
    const h = withFake({
      properties: manyRows(AUTHORING_CHANNEL_VERSION_PROPERTY, 11, (i) =>
        i === 0 ? "true" : "1.0.0",
      ),
    });
    try {
      const read = await h.probe.readProperty(
        AUTHORING_CHANNEL_VERSION_PROPERTY,
      );
      assert.equal(read.outcome, "undecidable");
    } finally {
      h.restore();
    }
  });

  // Wave 15: a read that returned NO rows used to be `absent` before the
  // completeness check ran, so rows the count saw but read ACLs hid were
  // reported as "the property is not there" — a claim about the instance the
  // read never earned.
  it("no rows under a larger X-Total-Count are unreadable, never absent", async () => {
    const { read, finding } = await withStubbedRows([], 3, async (probe) => ({
      read: await probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY),
      finding: await atfRunnerEnabledPrecondition(probe).probe(),
    }));
    assert.equal(read.outcome, "undecidable");
    assert.equal(read.value, undefined);
    assert.match(
      read.detail,
      /came back short: X-Total-Count reports 3 matching rows but only 0 were returned/,
    );
    assert.doesNotMatch(read.detail, /no readable/);
    assert.equal(finding.status, "unknown");
    assert.equal(finding.remedy, undefined);
  });

  it("production: no rows under a larger X-Total-Count read nothing", async () => {
    const read = await withStubbedRows([], 1, (probe) =>
      probe.readProperty(PRODUCTION),
    );
    assert.equal(read.outcome, "undecidable");
    assert.equal(read.value, undefined);
    assert.match(read.detail, /came back short/);
  });

  for (const total of [0, undefined]) {
    it(`no rows with X-Total-Count ${String(total)} are still absent`, async () => {
      const read = await withStubbedRows([], total, (probe) =>
        probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY),
      );
      assert.equal(read.outcome, "absent");
    });
  }

  it("the short-read wording is the transport's own", () => {
    // `incompleteRead` lives in `@tessera/types`, which cannot depend on
    // `@tessera/sn-client`; this pin keeps its copy of the short-page wording
    // equal to `tableApi.describeTruncation`.
    for (const [returned, total] of [
      [0, 3],
      [10, 11],
    ]) {
      assert.equal(
        incompleteRead(ATF_RUNNER_ENABLED_PROPERTY, returned, total),
        `${SYS_PROPERTIES_TABLE} read for ${ATF_RUNNER_ENABLED_PROPERTY} ` +
          tableApi.describeTruncation({
            records: new Array(returned),
            total,
            truncationReason: "short-page",
          }),
      );
    }
  });
});

// ── containment of hostile probe output ─────────────────────────────────────

describe("createEnvironmentDoctor — a probe cannot take diagnose down", () => {
  // `diagnose` never rejects. Every probe runs under `Promise.all`, so one
  // probe whose error cannot even be PRINTED used to reject the whole report —
  // every other finding lost with it.
  const unprintable = [
    ["a null-prototype object", () => Object.create(null)],
    [
      "an object whose toString throws",
      () => ({
        toString() {
          throw new Error("toString bomb");
        },
      }),
    ],
    [
      "an Error whose message getter throws",
      () => {
        const error = new Error();
        Object.defineProperty(error, "message", {
          get() {
            throw new Error("message bomb");
          },
        });
        return error;
      },
    ],
  ];
  for (const [label, make] of unprintable) {
    it(`reports unknown when the probe throws ${label}`, async () => {
      const doctor = createEnvironmentDoctor([
        {
          id: "hostile",
          probe: () => {
            throw make();
          },
        },
        stub("fine", "ready"),
      ]);
      const report = await doctor.diagnose();
      assert.equal(report.status, "unknown");
      const hostile = findingFor(report, "hostile");
      assert.equal(hostile.status, "unknown");
      assert.match(hostile.evidence, /<unprintable error>/);
      assert.equal(findingFor(report, "fine").status, "ready");
    });
  }

  it("reports what it validated, not what a getter says afterwards", async () => {
    let reads = 0;
    const doctor = createEnvironmentDoctor([
      {
        id: "flips",
        probe: () =>
          Promise.resolve({
            precondition: "flips",
            get status() {
              reads += 1;
              return reads === 1 ? "ready" : "READY";
            },
            evidence: "x",
          }),
      },
    ]);
    const report = await doctor.diagnose();
    const finding = findingFor(report, "flips");
    assert.equal(finding.status, "ready");
    assert.equal(report.status, "ready");
    // A fresh data property, not the probe's accessor.
    const descriptor = Object.getOwnPropertyDescriptor(finding, "status");
    assert.equal(descriptor.get, undefined);
    assert.equal(descriptor.value, "ready");
  });

  it("does not invoke the probe at all under an already-aborted signal", async () => {
    let called = 0;
    const controller = new AbortController();
    controller.abort();
    const doctor = createEnvironmentDoctor([
      {
        id: "never",
        probe: () => {
          called += 1;
          return Promise.resolve({
            precondition: "never",
            status: "ready",
            evidence: "x",
          });
        },
      },
    ]);
    const report = await doctor.diagnose({ signal: controller.signal });
    assert.equal(called, 0, "the probe ran under a signal already aborted");
    assert.equal(report.status, "unknown");
    assert.match(findingFor(report, "never").evidence, /cancelled/);
  });
});

describe("property read limits — one source (wave 16)", () => {
  it("re-exports @tessera/types' limits, table and bound rule", () => {
    assert.equal(PROPERTY_ROW_LIMIT, sharedTypes.PROPERTY_ROW_LIMIT);
    assert.equal(PROPERTY_READ_LIMIT, sharedTypes.PROPERTY_READ_LIMIT);
    assert.equal(SYS_PROPERTIES_TABLE, sharedTypes.SYS_PROPERTIES_TABLE);
    // A function is compared by reference: the SAME rule, not a copy of it.
    assert.equal(incompleteRead, sharedTypes.incompletePropertyRead);
  });

  it("declares no limit or table of its own", () => {
    // Numbers compare by value, so a reintroduced local `= 10` would pass the
    // equality pin above; the built module must not declare one at all.
    const built = readFileSync(
      new URL("../build/probe.js", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      built,
      /\b(?:const|let|var)\s+(?:PROPERTY_ROW_LIMIT|PROPERTY_READ_LIMIT|SYS_PROPERTIES_TABLE)\s*=/,
    );
  });
});

// Wave 16: the rule for several rows answering for one property name lives in
// `@tessera/types` (`decidePropertyRows`), shared with `@tessera/phase05`,
// whose copy used to read `false` + `garbage` as unknown where this one read
// production. The cases below are the ones that diverged, and each result
// must equal what the shared rule decides.
describe("duplicate/incomplete production rows — one shared rule (wave 16)", () => {
  /** `values` as rows for the production flag, sys_ids 0…n-1. */
  function productionRows(values) {
    return manyRows(PRODUCTION, values.length, (i) => values[i]);
  }

  async function readProduction(values) {
    const h = withFake({ properties: productionRows(values) });
    try {
      return await h.probe.readProperty(PRODUCTION);
    } finally {
      h.restore();
    }
  }

  for (const [values, winner] of [
    [["false", "garbage"], 1],
    [["false", ""], 1],
    [["", "false"], 0],
    [["false", "TRUE"], 1],
    [["garbage", "false", "true"], 2],
    [["TRUE", "true", "false"], 0],
  ]) {
    it(`complete ${JSON.stringify(values)}: production, reported from row ${winner}`, async () => {
      const read = await readProduction(values);
      assert.equal(read.outcome, "found");
      assert.equal(read.value, values[winner]);
      assert.equal(read.sysId, String(winner).padStart(32, "0"));
      assert.equal(read.duplicates, "differing");
      assert.match(read.detail, /the production direction/);
      assert.deepEqual(
        sharedTypes.decidePropertyRows(
          values.map(sharedTypes.normalisePropertyValue),
          true,
          sharedTypes.PRODUCTION_SAFE_DIRECTION,
        ),
        { kind: "safe", index: winner },
      );
    });
  }

  it("a single `TRUE` row is found as-is, no duplicate marker", async () => {
    const read = await readProduction(["TRUE"]);
    assert.equal(read.outcome, "found");
    assert.equal(read.value, "TRUE");
    assert.equal(read.duplicates, undefined);
  });

  for (const odd of ["garbage", ""]) {
    it(`incomplete read with a seen ${JSON.stringify(odd)} reads production`, async () => {
      const read = await readProduction([
        ...Array.from({ length: 10 }, () => "false"),
        odd,
      ]);
      assert.equal(read.outcome, "found");
      assert.equal(read.value, odd);
      assert.match(read.detail, /more than 10 rows/);
      assert.match(read.detail, /the production direction/);
    });
  }

  it("incomplete read of agreeing `true` rows: production, marked identical", async () => {
    const read = await readProduction(
      Array.from({ length: 11 }, (_, i) => (i === 4 ? " TRUE" : "true")),
    );
    assert.equal(read.outcome, "found");
    assert.equal(read.value, "true");
    assert.equal(read.duplicates, "identical");
    assert.match(read.detail, /more than 10 rows/);
  });

  it("incomplete read with only `false` rows stays undecidable", async () => {
    const read = await readProduction(
      Array.from({ length: 11 }, (_, i) => (i % 2 === 0 ? "false" : " FALSE")),
    );
    assert.equal(read.outcome, "undecidable");
    assert.equal(read.value, undefined);
    assert.match(read.detail, /no value is read from an incomplete read/);
  });

  it("the runner keeps no safe-direction resolution here: differing is undecidable", async () => {
    // Delegated decision 2026-09-30 (wave 16): the doctor's generic reader
    // resolves only the production flag. Its runner consumer already blocks
    // on every non-`true` reading (`not-ready` with a duplicate-row remedy
    // for differing rows) — resolving `true` + `garbage` to `garbage` here
    // would downgrade that to `unknown` and lose the remedy.
    const h = withFake({
      properties: twoRows(ATF_RUNNER_ENABLED_PROPERTY, "true", "garbage"),
    });
    try {
      const read = await h.probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY);
      assert.equal(read.outcome, "undecidable");
      assert.equal(read.duplicates, "differing");
      const finding = await atfRunnerEnabledPrecondition(h.probe).probe();
      assert.equal(finding.status, "not-ready");
      assert.match(finding.remedy.action.description, /duplicate/);
    } finally {
      h.restore();
    }
  });

  it("probe.js carries no copy of the rule", () => {
    const built = readFileSync(
      new URL("../build/probe.js", import.meta.url),
      "utf8",
    );
    assert.match(built, /\bdecidePropertyRows\(/);
    assert.match(built, /\bPRODUCTION_SAFE_DIRECTION\b/);
    assert.doesNotMatch(built, /function normalise\(/);
    assert.doesNotMatch(built, /normalise\(row\.value\) === "true"/);
  });
});

// Wave 17: an INCOMPLETE read used to come back `undecidable` with nothing but
// a detail line, so a consumer holding a safe direction of its own (the CLI's
// guard probe settles the runner in the "not enabled" direction) could not
// see that a row it DID read already settles it — a seen `garbage` runner row
// reached the guard as "no boolean" instead of the safe `false`. The rows
// travel now, marked `incomplete`; the doctor's own statuses do not move.
describe("incomplete reads carry the rows they saw (wave 17)", () => {
  const GARBAGE = "zz-instance-authored-zz";

  it("a single seen runner row under a larger count travels with the read", async () => {
    const rows = manyRows(ATF_RUNNER_ENABLED_PROPERTY, 1, () => GARBAGE);
    const { read, finding } = await withStubbedRows(rows, 2, async (probe) => ({
      read: await probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY),
      finding: await atfRunnerEnabledPrecondition(probe).probe(),
    }));
    assert.equal(read.outcome, "undecidable");
    assert.equal(read.value, undefined);
    assert.equal(read.sysId, undefined);
    assert.equal(read.incomplete, true);
    assert.equal(read.duplicates, undefined);
    assert.deepEqual(read.rows, [{ sysId: "0".repeat(32), value: GARBAGE }]);
    // The instance value is data on the read, never text in its notes.
    assert.doesNotMatch(read.detail, /zz-instance-authored-zz/);
    assert.match(read.detail, /no value is read from an incomplete read/);
    // Unchanged: an incomplete runner read is `unknown`, with no remedy.
    assert.equal(finding.status, "unknown");
    assert.equal(finding.remedy, undefined);
    assert.doesNotMatch(finding.evidence, /zz-instance-authored-zz/);
    // What a consumer with the runner's safe direction settles it to.
    assert.deepEqual(
      sharedTypes.decidePropertyRows(
        read.rows.map((row) => sharedTypes.normalisePropertyValue(row.value)),
        read.incomplete !== true,
        sharedTypes.ATF_RUNNER_SAFE_DIRECTION,
      ),
      { kind: "safe", index: 0 },
    );
  });

  it("an overflowing differing runner read carries every row, in order, and stays `unknown`", async () => {
    const h = withFake({
      properties: manyRows(ATF_RUNNER_ENABLED_PROPERTY, 11, (i) =>
        i === 10 ? "false" : "true",
      ),
    });
    try {
      const read = await h.probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY);
      assert.equal(read.outcome, "undecidable");
      assert.equal(read.incomplete, true);
      // Not `differing`: that marker routes the runner to its complete-read
      // duplicate remedy, which an incomplete read has not earned (wave 14).
      assert.equal(read.duplicates, undefined);
      assert.equal(read.rows.length, 11);
      assert.deepEqual(
        read.rows.map((row) => row.value),
        [...Array.from({ length: 10 }, () => "true"), "false"],
      );
      assert.equal(read.rows[10].sysId, "10".padStart(32, "0"));
      const finding = await atfRunnerEnabledPrecondition(h.probe).probe();
      assert.equal(finding.status, "unknown");
    } finally {
      h.restore();
    }
  });

  it("agreeing seen `true` runner rows travel too, and still decide nothing", async () => {
    const rows = manyRows(ATF_RUNNER_ENABLED_PROPERTY, 2, () => "true");
    const read = await withStubbedRows(rows, 3, (probe) =>
      probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY),
    );
    assert.equal(read.outcome, "undecidable");
    assert.equal(read.incomplete, true);
    assert.equal(read.duplicates, undefined);
    assert.equal(read.rows.length, 2);
    assert.deepEqual(
      sharedTypes.decidePropertyRows(
        read.rows.map((row) => sharedTypes.normalisePropertyValue(row.value)),
        false,
        sharedTypes.ATF_RUNNER_SAFE_DIRECTION,
      ),
      { kind: "undecidable", reason: "incomplete" },
    );
  });

  it("production: all-`false` seen rows travel with the undecidable read", async () => {
    const rows = manyRows(PRODUCTION_PROPERTY, 11, () => "false");
    const read = await withStubbedRows(rows, 11, (probe) =>
      probe.readProperty(PRODUCTION_PROPERTY),
    );
    assert.equal(read.outcome, "undecidable");
    assert.equal(read.incomplete, true);
    assert.equal(read.rows.length, 11);
  });

  it("production: an incomplete read settled in the production direction is marked incomplete", async () => {
    const rows = manyRows(PRODUCTION_PROPERTY, 1, () => GARBAGE);
    const read = await withStubbedRows(rows, 2, (probe) =>
      probe.readProperty(PRODUCTION_PROPERTY),
    );
    assert.equal(read.outcome, "found");
    assert.equal(read.value, GARBAGE);
    assert.equal(read.incomplete, true);
  });

  it("no rows under a larger count: incomplete, and no rows to carry", async () => {
    const read = await withStubbedRows([], 3, (probe) =>
      probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY),
    );
    assert.equal(read.outcome, "undecidable");
    assert.equal(read.incomplete, true);
    assert.equal(read.rows, undefined);
  });

  for (const [label, rows, total] of [
    ["one row", manyRows(ATF_RUNNER_ENABLED_PROPERTY, 1, () => "true"), 1],
    ["no rows", [], 0],
    [
      "differing rows",
      manyRows(ATF_RUNNER_ENABLED_PROPERTY, 2, (i) => (i ? "true" : "false")),
      2,
    ],
  ]) {
    it(`a complete read (${label}) is never marked incomplete`, async () => {
      const read = await withStubbedRows(rows, total, (probe) =>
        probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY),
      );
      assert.equal(Object.hasOwn(read, "incomplete"), false);
    });
  }

  it("a single complete row still carries no `rows` (shape unchanged)", async () => {
    const rows = manyRows(ATF_RUNNER_ENABLED_PROPERTY, 1, () => "true");
    const read = await withStubbedRows(rows, 1, (probe) =>
      probe.readProperty(ATF_RUNNER_ENABLED_PROPERTY),
    );
    assert.equal(read.outcome, "found");
    assert.equal(read.rows, undefined);
  });
});

describe("sys_properties names — one source (wave 17)", () => {
  it("re-exports @tessera/types' property names", () => {
    assert.equal(PRODUCTION_PROPERTY, sharedTypes.PRODUCTION_PROPERTY);
    assert.equal(
      ATF_RUNNER_ENABLED_PROPERTY,
      sharedTypes.ATF_RUNNER_ENABLED_PROPERTY,
    );
  });

  for (const file of ["probe.js", "preconditions.js"]) {
    it(`${file} declares and spells neither name itself`, () => {
      // Strings compare by value, so a reintroduced local copy would pass the
      // equality pin above; the built module must not hold one at all.
      const built = readFileSync(
        new URL(`../build/${file}`, import.meta.url),
        "utf8",
      );
      assert.doesNotMatch(
        built,
        /\b(?:const|let|var)\s+(?:PRODUCTION_PROPERTY|ATF_RUNNER_ENABLED_PROPERTY)\s*=/,
      );
      assert.doesNotMatch(built, /"glide\.installation\.production"/);
      assert.doesNotMatch(built, /"sn_atf\.runner\.enabled"/);
    });
  }
});
