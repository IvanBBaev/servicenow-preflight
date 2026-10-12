// The on-disk record decoders are the reader's half of every writer check: a
// record with any one field missing or mis-typed must decode to null (and so
// surface as `corrupt`), never as a thinner record a caller would trust.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decodeAuditRecord,
  decodeInfraLogLine,
  decodeLogLine,
  decodePersistedRunResult,
  decodeRunEvent,
  decodeRunStateRecord,
} from "../build/records.js";

/** `base` with `patch` applied; a patch value of `undefined` removes the key. */
function variant(base, patch) {
  const out = { ...base, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete out[key];
    }
  }
  return out;
}

/** Assert `decode(base)` succeeds and every listed one-field break is refused. */
function refusesEachBreak(decode, base, breaks) {
  assert.notEqual(decode(base), null, "the base record must decode");
  for (const [label, patch] of breaks) {
    assert.equal(decode(variant(base, patch)), null, label);
  }
}

const NOT_OBJECTS = [null, undefined, "x", 1, [], [{}]];

const WRITE = {
  kind: "write",
  seq: 1,
  runId: "run-1",
  instance: "dev",
  intent: "create-user",
  idempotencyKey: "k1",
  target: { table: "sys_user", sysId: "abc" },
  compensation: { op: "delete", table: "sys_user", sysId: "abc" },
  state: "intended",
  probe: {
    table: "sys_user",
    query: "user_nameSTARTSWITHrun-1",
    key: "run-id-prefix",
  },
};

/** One-field breaks shared by run writes and infra writes. */
const ENTRY_BREAKS = [
  ["seq 0", { seq: 0 }],
  ["fractional seq", { seq: 1.5 }],
  ["string seq", { seq: "1" }],
  ["empty intent", { intent: "" }],
  ["missing idempotency key", { idempotencyKey: undefined }],
  ["target not an object", { target: "sys_user" }],
  ["target without table", { target: { sysId: "abc" } }],
  ["target with an empty sysId", { target: { table: "sys_user", sysId: "" } }],
  ["missing compensation", { compensation: undefined }],
  ["unknown compensation op", { compensation: { op: "drop", table: "t" } }],
  ["delete without table", { compensation: { op: "delete", sysId: "abc" } }],
  [
    "delete with a numeric sysId",
    { compensation: { op: "delete", table: "t", sysId: 7 } },
  ],
  [
    "restore without sysId",
    { compensation: { op: "restore", table: "t", fields: {} } },
  ],
  [
    "restore without fields",
    { compensation: { op: "restore", table: "t", sysId: "a" } },
  ],
  [
    "restore with array fields",
    { compensation: { op: "restore", table: "t", sysId: "a", fields: [] } },
  ],
  ["none without reason", { compensation: { op: "none" } }],
  ["unknown state", { state: "pending" }],
  ["probe not an object", { probe: "x" }],
  [
    "probe with unknown key",
    { probe: { table: "t", query: "q", key: "guess" } },
  ],
  ["probe without query", { probe: { table: "t", key: "natural-key" } }],
];

describe("decodeLogLine", () => {
  it("refuses non-objects and unknown kinds", () => {
    for (const value of NOT_OBJECTS) {
      assert.equal(decodeLogLine(value), null);
    }
    assert.equal(decodeLogLine(variant(WRITE, { kind: "infra-write" })), null);
    assert.equal(decodeLogLine(variant(WRITE, { kind: undefined })), null);
  });

  it("decodes a full write and keeps an absent probe absent", () => {
    assert.deepEqual(decodeLogLine(WRITE), WRITE);
    const bare = decodeLogLine(variant(WRITE, { probe: undefined }));
    assert.equal(bare.probe, undefined);
  });

  it("accepts every compensation shape the writer emits", () => {
    for (const compensation of [
      { op: "delete", table: "t", sysId: undefined },
      { op: "restore", table: "t", sysId: "a", fields: { name: "old" } },
      { op: "none", reason: "read-only" },
    ]) {
      assert.deepEqual(
        decodeLogLine(variant(WRITE, { compensation })).compensation,
        compensation,
      );
    }
  });

  it("refuses a write with any one field broken", () => {
    refusesEachBreak(decodeLogLine, WRITE, [
      ...ENTRY_BREAKS,
      ["missing runId", { runId: undefined }],
      ["numeric instance", { instance: 1 }],
    ]);
  });

  it("decodes a state flip and refuses a broken one", () => {
    const flip = { kind: "state", seq: 2, state: "applied", sysId: "abc" };
    assert.deepEqual(decodeLogLine(flip), flip);
    refusesEachBreak(decodeLogLine, flip, [
      ["seq 0", { seq: 0 }],
      ["flip back to intended", { state: "intended" }],
      ["empty sysId", { sysId: "" }],
    ]);
  });
});

describe("decodeInfraLogLine", () => {
  const INFRA = variant(WRITE, {
    kind: "infra-write",
    runId: undefined,
    instance: undefined,
    planHash: "h1",
    host: "dev.service-now.com",
    intendedAt: "2026-10-13T00:00:00.000Z",
  });

  it("refuses non-objects and kinds other than infra-write and state", () => {
    for (const value of NOT_OBJECTS) {
      assert.equal(decodeInfraLogLine(value), null);
    }
    assert.equal(decodeInfraLogLine(WRITE), null, "a run write is not infra");
    for (const kind of ["write", "audit", undefined]) {
      assert.equal(
        decodeInfraLogLine(variant(INFRA, { kind })),
        null,
        `an infra-shaped record of kind ${kind}`,
      );
    }
  });

  it("refuses an infra write with any one field broken", () => {
    refusesEachBreak(decodeInfraLogLine, INFRA, [
      ...ENTRY_BREAKS,
      ["missing planHash", { planHash: undefined }],
      ["empty host", { host: "" }],
      ["missing intendedAt", { intendedAt: undefined }],
    ]);
  });

  it("passes a valid state flip through and refuses a broken one", () => {
    const flip = { kind: "state", seq: 1, state: "compensated" };
    assert.deepEqual(decodeInfraLogLine(flip), { ...flip, sysId: undefined });
    assert.equal(decodeInfraLogLine({ ...flip, state: "intended" }), null);
  });
});

describe("decodeAuditRecord", () => {
  const ACK = {
    kind: "acknowledge-prod",
    runId: "run-1",
    at: "2026-10-13T00:00:00.000Z",
    reason: "hotfix",
    actor: "qa-lead",
    instance: { name: "prod", host: "prod.service-now.com" },
    role: "prod",
    cls: "production",
    evidence: [{ kind: "name", effect: "prod", detail: "named prod" }],
    surface: "cli",
  };

  it("refuses non-objects and kinds outside the closed vocabulary", () => {
    for (const value of NOT_OBJECTS) {
      assert.equal(decodeAuditRecord(value), null);
    }
    assert.equal(decodeAuditRecord(variant(ACK, { kind: "override" })), null);
  });

  it("decodes a full acknowledge-prod record; an empty evidence list is legal", () => {
    assert.deepEqual(decodeAuditRecord(ACK), ACK);
    assert.deepEqual(
      decodeAuditRecord(variant(ACK, { evidence: [] })).evidence,
      [],
    );
  });

  it("refuses an acknowledge-prod record with any one field broken", () => {
    refusesEachBreak(decodeAuditRecord, ACK, [
      ["missing runId", { runId: undefined }],
      ["empty at", { at: "" }],
      ["missing reason", { reason: undefined }],
      ["missing actor", { actor: undefined }],
      ["instance not an object", { instance: "prod" }],
      ["instance without host", { instance: { name: "prod" } }],
      ["missing role", { role: undefined }],
      ["missing cls", { cls: undefined }],
      ["evidence not an array", { evidence: {} }],
      ["evidence element not an object", { evidence: ["name"] }],
      [
        "evidence element without detail",
        { evidence: [{ kind: "name", effect: "prod" }] },
      ],
      ["missing surface", { surface: undefined }],
    ]);
  });

  it("refuses the old reason+actor-only split as a thinner record", () => {
    assert.equal(
      decodeAuditRecord({
        kind: "acknowledge-prod",
        runId: "run-1",
        at: "2026-10-13T00:00:00.000Z",
        reason: "hotfix",
        actor: "qa-lead",
      }),
      null,
    );
  });

  it("decodes token-consumed only with a verdict hash", () => {
    const token = {
      kind: "token-consumed",
      runId: "run-1",
      verdictHash: "sha256:x",
      at: "2026-10-13T00:00:00.000Z",
    };
    assert.deepEqual(decodeAuditRecord(token), token);
    assert.equal(decodeAuditRecord(variant(token, { verdictHash: "" })), null);
  });

  it("refuses an allow-skipped record whose specs are malformed", () => {
    const skipped = {
      kind: "allow-skipped",
      runId: "run-1",
      actor: "qa-lead",
      surface: "cli",
      affectedRows: 1,
      specs: [{ id: "s1", path: "tests/s1.yaml" }],
      verdictStatus: "skipped",
      at: "2026-10-13T00:00:00.000Z",
    };
    refusesEachBreak(decodeAuditRecord, skipped, [
      ["specs not an array", { specs: "s1" }],
      ["spec element not an object", { specs: [null], affectedRows: 1 }],
      ["spec without path", { specs: [{ id: "s1" }] }],
      ["negative count", { affectedRows: -1 }],
    ]);
  });
});

describe("decodeRunEvent", () => {
  const EVENT = {
    cursor: 1,
    runId: "run-1",
    type: "state",
    at: "2026-10-13T00:00:00.000Z",
  };

  it("decodes an event and carries data only when present", () => {
    assert.deepEqual(decodeRunEvent(EVENT), EVENT);
    assert.equal("data" in decodeRunEvent(EVENT), false);
    assert.deepEqual(decodeRunEvent({ ...EVENT, data: { n: 1 } }).data, {
      n: 1,
    });
  });

  it("refuses non-objects and an event with any one field broken", () => {
    for (const value of NOT_OBJECTS) {
      assert.equal(decodeRunEvent(value), null);
    }
    refusesEachBreak(decodeRunEvent, EVENT, [
      ["cursor 0", { cursor: 0 }],
      ["missing runId", { runId: undefined }],
      ["empty type", { type: "" }],
      ["missing at", { at: undefined }],
    ]);
  });
});

describe("decodePersistedRunResult", () => {
  const RESULT = {
    runId: "run-1",
    at: "2026-10-13T00:00:00.000Z",
    result: { ok: true },
  };

  it("decodes a result, including an explicit null one", () => {
    assert.deepEqual(decodePersistedRunResult(RESULT), RESULT);
    assert.deepEqual(
      decodePersistedRunResult({ ...RESULT, result: null }).result,
      null,
    );
  });

  it("refuses a record without a result key or with a broken header", () => {
    for (const value of NOT_OBJECTS) {
      assert.equal(decodePersistedRunResult(value), null);
    }
    refusesEachBreak(decodePersistedRunResult, RESULT, [
      ["no result key", { result: undefined }],
      ["missing runId", { runId: undefined }],
      ["empty at", { at: "" }],
    ]);
  });
});

describe("decodeRunStateRecord", () => {
  const RUN = {
    runId: "run-1",
    state: "running",
    scope: "x_app",
    runner: "atf",
    lifecycle: "ephemeral",
    startedAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:01:00.000Z",
    pid: 4242,
    runningAt: "2026-10-13T00:00:30.000Z",
    tracksRunning: true,
  };

  it("decodes a full record and an older one without the tracking pair", () => {
    assert.deepEqual(decodeRunStateRecord(RUN), RUN);
    const older = variant(RUN, {
      runningAt: undefined,
      tracksRunning: undefined,
      pid: undefined,
    });
    assert.deepEqual(decodeRunStateRecord(older), { ...older, pid: undefined });
  });

  it("refuses non-objects and a record with any one field broken", () => {
    for (const value of NOT_OBJECTS) {
      assert.equal(decodeRunStateRecord(value), null);
    }
    refusesEachBreak(decodeRunStateRecord, RUN, [
      ["missing runId", { runId: undefined }],
      ["missing scope", { scope: undefined }],
      ["missing runner", { runner: undefined }],
      ["missing startedAt", { startedAt: undefined }],
      ["empty updatedAt", { updatedAt: "" }],
      ["unknown state", { state: "paused" }],
      ["unknown lifecycle", { lifecycle: "forever" }],
      ["fractional pid", { pid: 1.5 }],
      ["string pid", { pid: "4242" }],
      ["unparsable runningAt", { runningAt: "yesterday" }],
      ["empty runningAt", { runningAt: "" }],
      ["tracksRunning not literally true", { tracksRunning: "yes" }],
      ["tracksRunning false", { tracksRunning: false }],
    ]);
  });

  it("refuses a tracking record that claims never-running while in running or collecting", () => {
    for (const state of ["running", "collecting"]) {
      assert.equal(
        decodeRunStateRecord(variant(RUN, { state, runningAt: undefined })),
        null,
        state,
      );
    }
    for (const state of ["tearing-down", "failed", "done"]) {
      assert.notEqual(
        decodeRunStateRecord(variant(RUN, { state, runningAt: undefined })),
        null,
        state,
      );
    }
  });
});
