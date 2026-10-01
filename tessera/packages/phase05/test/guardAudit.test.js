// The §11.4 acknowledge-prod audit sink.
//
// THE PROPERTY UNDER TEST, in the module's own words: the record is written
// "as ONE record", every field explicit, and the in-memory echo happens "only
// after the append" because "an in-memory echo of a record that was never
// journalled is a second account of the event that can disagree with the
// durable one".
//
// The historical defect this file guards is exactly the campaign's class: the
// ledger's copy carried `kind`, `runId`, `at`, `reason`, `actor` — "a plausible
// whole audit record, so nothing told a reader that instance, role, class,
// evidence and surface were somewhere else". A reader could not notice the
// absence. So the tests below assert the FULL field set reached the ledger,
// not merely that something did.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLedgerGuardAuditSink } from "../build/guardAudit.js";

/** A record carrying a distinct value in every §11.4 field. */
function record(overrides = {}) {
  return {
    runId: "run-audit-0001",
    at: "2026-09-01T12:00:00.000Z",
    instance: { name: "prod-target", host: "acme.service-now.com" },
    role: "target",
    cls: "prod",
    evidence: [
      {
        kind: "allowlist",
        effect: "classified",
        detail: "host is not in SN_ALLOWED_HOSTS",
      },
      {
        kind: "probe",
        effect: "confirmed",
        detail: "glide.installation.production=true",
      },
    ],
    reason: "hotfix verification approved by change 0012345",
    actor: "ivan",
    surface: "cli",
    ...overrides,
  };
}

/** Minimal `IntentLedger` stub: only `appendAuditSync` is exercised. */
function ledgerStub(onAppend) {
  const appended = [];
  return {
    appended,
    appendAuditSync(input) {
      if (onAppend) onAppend(input);
      appended.push(input);
    },
  };
}

describe("createLedgerGuardAuditSink", () => {
  it("carries every §11.4 field into the ledger, not a plausible subset", () => {
    const ledger = ledgerStub();
    const sink = createLedgerGuardAuditSink(ledger);
    const entry = record();

    sink.record(entry);

    assert.equal(ledger.appended.length, 1);
    const written = ledger.appended[0];
    // Field-by-field rather than deepEqual against the source object: this is
    // the assertion that reddens when a field is dropped from the explicit
    // argument list, and it names which one.
    assert.equal(written.kind, "acknowledge-prod");
    assert.equal(written.runId, entry.runId);
    assert.equal(written.at, entry.at);
    assert.equal(written.instance.name, entry.instance.name);
    assert.equal(written.instance.host, entry.instance.host);
    assert.equal(written.role, entry.role);
    assert.equal(written.cls, entry.cls);
    assert.equal(written.reason, entry.reason);
    assert.equal(written.actor, entry.actor);
    assert.equal(written.surface, entry.surface);
    assert.deepEqual(written.evidence, entry.evidence);
  });

  it("writes one record per override, never a merged or repeated one", () => {
    const ledger = ledgerStub();
    const sink = createLedgerGuardAuditSink(ledger);
    sink.record(record({ runId: "run-a", reason: "first" }));
    sink.record(record({ runId: "run-b", reason: "second" }));

    assert.deepEqual(
      ledger.appended.map((a) => [a.runId, a.reason]),
      [
        ["run-a", "first"],
        ["run-b", "second"],
      ],
    );
    assert.equal(sink.records().length, 2);
  });

  it("copies each evidence signal's three fields, keeping the list's order", () => {
    const ledger = ledgerStub();
    createLedgerGuardAuditSink(ledger).record(record());

    const evidence = ledger.appended[0].evidence;
    assert.equal(evidence.length, 2);
    assert.equal(evidence[0].kind, "allowlist");
    assert.equal(evidence[0].effect, "classified");
    assert.equal(evidence[0].detail, "host is not in SN_ALLOWED_HOSTS");
    assert.equal(evidence[1].kind, "probe");
    assert.equal(evidence[1].effect, "confirmed");
    assert.equal(evidence[1].detail, "glide.installation.production=true");
  });

  it("writes an empty evidence list as empty rather than losing the field", () => {
    const ledger = ledgerStub();
    createLedgerGuardAuditSink(ledger).record(record({ evidence: [] }));
    assert.deepEqual(ledger.appended[0].evidence, []);
  });

  it("a failed append propagates and leaves NO in-memory account of the event", () => {
    // The ordering property. If `journalled.push` ran before the append, this
    // sink would answer `records()` with an override that is nowhere on disk —
    // a confident second account of an event that never got journalled, and
    // precisely what a caller cannot notice is missing.
    const boom = new Error("disk full");
    const ledger = ledgerStub(() => {
      throw boom;
    });
    const sink = createLedgerGuardAuditSink(ledger);

    assert.throws(() => sink.record(record()), boom);
    assert.deepEqual(
      sink.records(),
      [],
      "a record that could not be journalled must not be remembered",
    );
  });

  it("remembers only the appends that survived", () => {
    let calls = 0;
    const ledger = ledgerStub(() => {
      calls += 1;
      if (calls === 2) throw new Error("transient");
    });
    const sink = createLedgerGuardAuditSink(ledger);

    sink.record(record({ runId: "kept-1" }));
    assert.throws(() => sink.record(record({ runId: "lost" })));
    sink.record(record({ runId: "kept-2" }));

    assert.deepEqual(
      sink.records().map((entry) => entry.runId),
      ["kept-1", "kept-2"],
    );
  });

  it("opens no file of its own — the ledger is the only writer", () => {
    // The module's closing warning: "If you find yourself adding one back, the
    // record has split again." A sink built on a ledger that records nothing
    // must therefore produce nothing durable anywhere, which shows up here as
    // the sink having no surface beyond `record`/`records`.
    const sink = createLedgerGuardAuditSink(ledgerStub());
    assert.deepEqual(Object.keys(sink).sort(), ["record", "records"]);
  });
});
