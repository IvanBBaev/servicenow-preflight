// StoryResolver — ARCH-5's story source (PLAN Phase 2).
//
// Two halves, and the split is deliberate.
//
//  * The DECISION half runs against a stubbed RecordReader. What is under test
//    there is the chain of three reads and the honesty rules hung off it:
//    which read is issued with which projection, which failure is the user's
//    to fix and which is an infrastructure fault, and which silence has to be
//    said out loud. An instance in the picture would only add ways for those
//    assertions to pass for the wrong reason.
//
//  * The ADAPTER half drives the real `createSnRecordReader` through the real
//    `@tessera/sn-client` transport against a QA-18 stateful fake. Those
//    assertions are about HTTP: that the encoded queries this resolver builds
//    are ones a Table API actually answers, that the narrow projection really
//    is what goes over the wire (TM-1), and that nothing but GET is ever sent
//    (ARCH-8).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import {
  DEFAULT_UPDATE_SET_STORY_FIELD,
  ResolutionFaultError,
  ResolutionInputError,
  createSnRecordReader,
  createStoryResolver,
  isIncomplete,
  parseUpdateXmlName,
} from "../build/index.js";

/** A 32-character lowercase-hex sys_id that stays readable in a diff. */
const hex = (prefix) => prefix.padEnd(32, "0");

const STORY_ID = hex("57019");
const SET_A = hex("5e7a");
const SET_B = hex("5e7b");
const RULE_ID = hex("bad1");
const INCLUDE_ID = hex("ccc2");
const POLICY_ID = hex("ddd3");

const CTX = {
  runId: "run-story-test",
  lifecycle: "ephemeral",
  coverageSource: "atf",
  topology: { source: "source", runner: "runner", target: "target" },
  signal: new AbortController().signal,
};

// ── decision half ───────────────────────────────────────────────────────────

const STORY_ROW = { sys_id: STORY_ID, number: "STRY0042" };

function answered(records, extra = {}) {
  return {
    outcome: "answered",
    records,
    truncated: false,
    detail: `${records.length} row(s)`,
    ...extra,
  };
}

function undecidable(detail) {
  return { outcome: "undecidable", records: [], truncated: false, detail };
}

function member(over = {}) {
  return {
    sys_id: hex("e0"),
    name: `sys_script_${RULE_ID}`,
    type: "Business Rule",
    target_name: "Tessera demo rule",
    action: "INSERT_OR_UPDATE",
    update_set: SET_A,
    ...over,
  };
}

/** A reader that records every request and answers from one canned read per table. */
function readerFrom(responses) {
  const requests = [];
  return {
    profile: "source",
    requests,
    queryRecords(request) {
      requests.push({ ...request, fields: [...request.fields] });
      const canned = responses[request.table];
      if (canned === undefined) {
        return Promise.reject(new Error(`unexpected read of ${request.table}`));
      }
      return Promise.resolve(canned);
    },
  };
}

function resolverFor(responses = {}, options) {
  const reader = readerFrom({
    rm_story: answered([STORY_ROW]),
    sys_update_set: answered([
      { sys_id: SET_A, name: "Story work", story: STORY_ID },
    ]),
    sys_update_xml: answered([member()]),
    ...responses,
  });
  return { reader, resolver: createStoryResolver(reader, options) };
}

async function run(responses = {}, input = { story: "STRY0042" }, options) {
  const { reader, resolver } = resolverFor(responses, options);
  const report = await resolver.resolveWithReport(CTX, input);
  return { report, reader, resolver };
}

const requestFor = (reader, table) => {
  const found = reader.requests.find((request) => request.table === table);
  assert.ok(found, `expected a read of ${table}`);
  return found;
};

const warningsOf = (report) =>
  report.notes.filter((note) => note.level === "warning");

const textOf = (report) => report.notes.map((note) => note.message).join("\n");

describe("what the resolver was asked", () => {
  it("reads nothing at all when no story was named", async () => {
    const { report, reader } = await run({}, {});

    assert.deepEqual(report.artifacts, []);
    assert.equal(reader.requests.length, 0);
    assert.equal(report.notes.length, 1);
    assert.equal(report.notes[0].level, "info");
    assert.equal(report.notes[0].source, "story");
    // Nothing was asked, so nothing is missing: an unaddressed source must not
    // make the composite's union look incomplete.
    assert.equal(isIncomplete(report), false);
  });

  it("refuses a story argument that is blank", async () => {
    const { resolver, reader } = resolverFor();

    await assert.rejects(
      () => resolver.resolveWithReport(CTX, { story: "   " }),
      ResolutionInputError,
    );
    assert.equal(reader.requests.length, 0);
  });

  it("reads the story by number, and never reads its prose (TM-1)", async () => {
    const { reader } = await run();
    const read = requestFor(reader, "rm_story");

    assert.equal(read.query, "number=STRY0042");
    // The regression test for the threat-model rule: resolution ingests
    // IDENTITY only. `short_description` is untrusted free text that must not
    // enter the pipeline before the stage that brands it.
    assert.deepEqual(read.fields, ["sys_id", "number"]);
    assert.equal(read.fields.includes("short_description"), false);
    assert.equal(
      read.fields.some((field) => /descr|script|comment/i.test(field)),
      false,
    );
    // Two, not one: "exactly one story" has to be provable, and a limit of 1
    // would render an ambiguous number as a confident answer.
    assert.equal(read.limit, 2);
  });

  it("reads the story by sys_id when the argument is 32 hex", async () => {
    const { reader } = await run({}, { story: STORY_ID });

    assert.equal(requestFor(reader, "rm_story").query, `sys_id=${STORY_ID}`);
  });

  it("treats a story read that did not happen as a fault", async () => {
    const { resolver } = resolverFor({
      rm_story: undecidable("rm_story on source: read refused (403)"),
    });

    await assert.rejects(
      () => resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      (error) => {
        assert.ok(error instanceof ResolutionFaultError);
        assert.match(error.message, /read refused \(403\)/);
        return true;
      },
    );
  });

  it("treats a story that is not there as the caller's mistake", async () => {
    const { resolver } = resolverFor({ rm_story: answered([]) });

    await assert.rejects(
      () => resolver.resolveWithReport(CTX, { story: "STRY9999" }),
      (error) => {
        assert.ok(error instanceof ResolutionInputError);
        assert.match(error.message, /no rm_story matches/);
        return true;
      },
    );
  });

  it("refuses to guess when the number matches two stories", async () => {
    const { resolver } = resolverFor({
      rm_story: answered([
        STORY_ROW,
        { sys_id: hex("57020"), number: "STRY0042" },
      ]),
    });

    await assert.rejects(
      () => resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      (error) => {
        assert.ok(error instanceof ResolutionInputError);
        assert.match(error.message, /more than one rm_story/);
        return true;
      },
    );
  });
});

describe("the update sets linked to the story", () => {
  it("queries the documented field, ordered for stable paging", async () => {
    const { reader } = await run();
    const read = requestFor(reader, "sys_update_set");

    assert.equal(DEFAULT_UPDATE_SET_STORY_FIELD, "story");
    assert.equal(read.query, `story=${STORY_ID}^ORDERBYsys_id`);
    // The link field is read back so every row can be checked against it (M2).
    assert.deepEqual(read.fields, ["sys_id", "name", "story"]);
    assert.equal(read.fetchAll, true);
  });

  it("uses a non-default link field when one is configured", async () => {
    const { reader } = await run(
      {
        sys_update_set: answered([
          { sys_id: SET_A, name: "Story work", u_story: STORY_ID },
        ]),
      },
      { story: "STRY0042" },
      {
        updateSetStoryField: "u_story",
      },
    );

    assert.equal(
      requestFor(reader, "sys_update_set").query,
      `u_story=${STORY_ID}^ORDERBYsys_id`,
    );
    assert.deepEqual(requestFor(reader, "sys_update_set").fields, [
      "sys_id",
      "name",
      "u_story",
    ]);
  });

  it("never turns a refused link query into an empty answer (OPP-1b)", async () => {
    // The whole point: an instance that links stories through another field
    // rejects this query with a 400. "The question was refused" and "the story
    // has no update sets" render identically as zero rows, so the refusal has
    // to surface as a fault that names the knob which fixes it.
    const { resolver } = resolverFor({
      sys_update_set: undecidable(
        "sys_update_set on source: query `story=x` rejected (400) — Invalid field",
      ),
    });

    await assert.rejects(
      () => resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      (error) => {
        assert.ok(error instanceof ResolutionFaultError);
        assert.match(error.message, /rejected \(400\)/);
        assert.match(error.message, /sys_update_set\.story/);
        assert.match(error.message, /updateSetStoryField/);
        assert.match(error.message, /NOT the same as/);
        return true;
      },
    );
  });

  it("says the field it actually used when that field is the override", async () => {
    const { resolver } = resolverFor(
      { sys_update_set: undecidable("sys_update_set on source: 400") },
      { updateSetStoryField: "u_story" },
    );

    await assert.rejects(
      () => resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      (error) => {
        assert.match(error.message, /sys_update_set\.u_story/);
        return true;
      },
    );
  });

  it("warns loudly when nothing is linked to the story", async () => {
    const { report, reader } = await run({ sys_update_set: answered([]) });

    assert.deepEqual(report.artifacts, []);
    // A legitimate state, and still not a green answer — the caller asked
    // "what changed?" and the reply is "nothing is linked to this story".
    assert.equal(warningsOf(report).length, 1);
    assert.equal(isIncomplete(report), true);
    assert.match(textOf(report), /no update sets linked/);
    // Nothing left to enumerate, so the member read is never issued.
    assert.equal(
      reader.requests.some((request) => request.table === "sys_update_xml"),
      false,
    );
  });

  it("flags a truncated list of update sets", async () => {
    const { report } = await run({
      sys_update_set: answered(
        [{ sys_id: SET_A, name: "Story work", story: STORY_ID }],
        {
          truncated: true,
          truncationReason: "cap",
          total: 5,
          detail: "sys_update_set on source: 1 row(s), capped",
        },
      ),
    });

    assert.match(textOf(report), /hit the SN_MAX_RECORDS cap \(1 of 5/);
    assert.equal(isIncomplete(report), true);
  });

  // Delegated decision 2026-09-26: a short page is partial for a reason the
  // cap cannot fix, and the warning must say that rather than "the read cap".
  it("names a short page as a short page, not as the cap", async () => {
    const { report } = await run({
      sys_update_set: answered(
        [{ sys_id: SET_A, name: "Story work", story: STORY_ID }],
        { truncated: true, truncationReason: "short-page", total: 3 },
      ),
      sys_update_xml: answered([member()], {
        truncated: true,
        truncationReason: "no-total",
      }),
    });

    const text = textOf(report);
    assert.match(text, /update sets linked to .* came back short/);
    assert.match(text, /3 matching rows but only 1 were returned/);
    assert.doesNotMatch(text, /read cap/);
    assert.match(text, /member list .* sent no X-Total-Count/);
    assert.equal(isIncomplete(report), true);
  });
});

describe("every row is checked against the filter that asked for it (M2)", () => {
  it("faults on an update-set row linked to a different story", async () => {
    const { resolver } = resolverFor({
      sys_update_set: answered([
        { sys_id: SET_A, name: "Story work", story: STORY_ID },
        { sys_id: SET_B, name: "Someone else's", story: hex("57021") },
      ]),
    });
    await assert.rejects(
      resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      ResolutionFaultError,
    );
  });

  it("faults on an update-set row that does not carry the link field", async () => {
    const { resolver } = resolverFor({
      sys_update_set: answered([{ sys_id: SET_A, name: "Story work" }]),
    });
    await assert.rejects(
      resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      ResolutionFaultError,
    );
  });

  it("checks the configured link field, not the default one", async () => {
    const { resolver } = resolverFor(
      {
        sys_update_set: answered([
          {
            sys_id: SET_A,
            name: "Story work",
            story: STORY_ID,
            u_story: hex("57021"),
          },
        ]),
      },
      { updateSetStoryField: "u_story" },
    );
    await assert.rejects(
      resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      ResolutionFaultError,
    );
  });

  it("faults on a member row from an update set that was not asked for", async () => {
    const { resolver } = resolverFor({
      sys_update_xml: answered([
        member(),
        member({ sys_id: hex("e9"), update_set: hex("5e7c") }),
      ]),
    });
    await assert.rejects(
      resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      ResolutionFaultError,
    );
  });

  it("faults on a foreign member row even when it is a deletion", async () => {
    const { resolver } = resolverFor({
      sys_update_xml: answered([
        member(),
        member({
          sys_id: hex("e9"),
          action: "DELETE",
          update_set: hex("5e7c"),
        }),
      ]),
    });
    await assert.rejects(
      resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      ResolutionFaultError,
    );
  });

  it("faults on a member row that does not carry update_set", async () => {
    const { resolver } = resolverFor({
      sys_update_xml: answered([member({ update_set: undefined })]),
    });
    await assert.rejects(
      resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      ResolutionFaultError,
    );
  });
});

describe("the update-set members", () => {
  const twoSets = {
    sys_update_set: answered([
      { sys_id: SET_A, name: "Story work 1", story: STORY_ID },
      { sys_id: SET_B, name: "Story work 2", story: STORY_ID },
    ]),
  };

  it("enumerates every set in a single read", async () => {
    const { reader } = await run(twoSets);
    const read = requestFor(reader, "sys_update_xml");

    assert.equal(
      reader.requests.filter((r) => r.table === "sys_update_xml").length,
      1,
    );
    assert.equal(read.query, `update_setIN${SET_A},${SET_B}^ORDERBYsys_id`);
    assert.deepEqual(read.fields, [
      "sys_id",
      "name",
      "type",
      "target_name",
      "action",
      "update_set",
    ]);
    assert.equal(read.fetchAll, true);
  });

  it("turns a member name into the record it changed", async () => {
    const { report } = await run();

    assert.deepEqual(report.artifacts, [
      {
        ref: {
          table: "sys_script",
          sysId: RULE_ID,
          name: "Tessera demo rule",
        },
        resolvedBy: "story",
      },
    ]);
  });

  it("labels a member with no target_name by table/sys_id", async () => {
    const { report } = await run({
      sys_update_xml: answered([member({ target_name: "" })]),
    });

    assert.equal(report.artifacts[0].ref.name, `sys_script/${RULE_ID}`);
  });

  it("skips deletions and counts them, whatever their case", async () => {
    const { report } = await run({
      sys_update_xml: answered([
        member(),
        member({
          sys_id: hex("e1"),
          name: `sys_ui_policy_${POLICY_ID}`,
          action: "DELETE",
        }),
        member({
          sys_id: hex("e2"),
          name: `sys_script_include_${INCLUDE_ID}`,
          action: "delete",
        }),
      ]),
    });

    // An artifact the update set removes cannot be tested — but it must not
    // vanish from the account of what the story did.
    assert.equal(report.artifacts.length, 1);
    assert.match(textOf(report), /2 member\(s\) delete a record/);
  });

  it("warns about a member nobody can address", async () => {
    const { report } = await run({
      sys_update_xml: answered([
        member(),
        member({
          sys_id: hex("e5"),
          name: "sys_dictionary_incident_u_thing",
          type: "Dictionary",
          target_name: "",
        }),
      ]),
    });

    assert.equal(report.artifacts.length, 1);
    const [warning] = warningsOf(report);
    assert.ok(warning, "an unaddressable member must be surfaced");
    assert.match(warning.message, /sys_dictionary_incident_u_thing/);
    assert.match(warning.message, /Dictionary/);
    assert.match(warning.message, /sys_update_xml\/e5/);
    assert.equal(isIncomplete(report), true);
  });

  it("collapses the same record appearing in two update sets", async () => {
    const { report } = await run({
      ...twoSets,
      sys_update_xml: answered([
        member(),
        member({ sys_id: hex("e3"), update_set: SET_B }),
        member({
          sys_id: hex("e4"),
          name: `sys_script_include_${INCLUDE_ID}`,
          target_name: "TesseraUtil",
          update_set: SET_B,
        }),
      ]),
    });

    assert.deepEqual(
      report.artifacts.map((artifact) => artifact.ref.sysId),
      [RULE_ID, INCLUDE_ID],
    );
    assert.match(textOf(report), /1 duplicate member\(s\) collapsed/);
    // De-duplication is not incompleteness: nothing was lost.
    assert.equal(isIncomplete(report), false);
  });

  it("flags a truncated member list", async () => {
    const { report } = await run({
      sys_update_xml: answered([member()], {
        truncated: true,
        detail: "sys_update_xml on source: 1 row(s), capped",
      }),
    });

    assert.match(textOf(report), /partial picture of what this story changed/);
    assert.equal(isIncomplete(report), true);
  });

  it("summarises what it read, and labels every artifact with its source", async () => {
    const { report } = await run(twoSets);

    assert.match(
      textOf(report),
      /STRY0042: 2 update set\(s\) linked \(1 contributed members\), 1 member\(s\) read, 1 artifact\(s\)/,
    );
    for (const note of report.notes) assert.equal(note.source, "story");
    for (const artifact of report.artifacts) {
      assert.equal(artifact.resolvedBy, "story");
    }
  });
});

describe("parseUpdateXmlName", () => {
  it("splits a table name that itself contains underscores", () => {
    assert.deepEqual(parseUpdateXmlName(`sys_script_include_${INCLUDE_ID}`), {
      table: "sys_script_include",
      sysId: INCLUDE_ID,
    });
    assert.deepEqual(parseUpdateXmlName(`sys_script_${RULE_ID}`), {
      table: "sys_script",
      sysId: RULE_ID,
    });
    assert.deepEqual(parseUpdateXmlName(`x_snc_app_thing_${RULE_ID}`), {
      table: "x_snc_app_thing",
      sysId: RULE_ID,
    });
  });

  it("returns undefined for every name that is not <table>_<sys_id>", () => {
    assert.equal(
      parseUpdateXmlName("sys_dictionary_incident_u_thing"),
      undefined,
    );
    assert.equal(parseUpdateXmlName(""), undefined);
    assert.equal(parseUpdateXmlName(RULE_ID), undefined);
    // 31 hex, 33 hex, and uppercase hex are all not a sys_id as the Table API
    // renders one.
    assert.equal(parseUpdateXmlName(`sys_script_${"a".repeat(31)}`), undefined);
    assert.equal(parseUpdateXmlName(`sys_script_${"a".repeat(33)}`), undefined);
    assert.equal(
      parseUpdateXmlName(`sys_script_${RULE_ID.toUpperCase()}`),
      undefined,
    );
  });

  it("refuses a table part that is not a plain table name (L4)", () => {
    for (const table of [
      "Sys_Script",
      "a.b",
      "x^NQactive=true",
      "sys script",
      "sys-script",
    ]) {
      assert.equal(parseUpdateXmlName(`${table}_${RULE_ID}`), undefined, table);
    }
  });
});

describe("the port and the wider method agree", () => {
  it("resolve() returns exactly the report's artifacts", async () => {
    const { resolver } = resolverFor();
    const artifacts = await resolver.resolve(CTX, { story: "STRY0042" });
    const { report } = await run();

    assert.deepEqual(artifacts, [...report.artifacts]);
    assert.equal(resolver.source, "story");
  });

  it("resolve() refuses to hand back a partial resolution (H1)", async () => {
    // The truncated set list is a warning: the report says it is incomplete,
    // and the narrow port has no notes channel to carry that — so it throws.
    const { resolver } = resolverFor({
      sys_update_set: answered(
        [{ sys_id: SET_A, name: "Story work", story: STORY_ID }],
        { truncated: true },
      ),
    });
    await assert.rejects(
      resolver.resolve(CTX, { story: "STRY0042" }),
      (error) =>
        error instanceof ResolutionFaultError &&
        /incomplete/.test(error.message),
    );
  });
});

// ── adapter half ────────────────────────────────────────────────────────────

const HOST = "dev-resolvers-source.service-now.com";
const PROSE = "SECRET-PROSE-DO-NOT-INGEST";

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
  "SN_PROFILE_SOURCE_INSTANCE",
  "SN_PROFILE_SOURCE_USER",
  "SN_PROFILE_SOURCE_PASSWORD",
];

/** The story, two update sets linked to it, and the rows they carry. */
const SEED = {
  rm_story: [
    // The prose is seeded on purpose: TM-1 holds only if the projection keeps
    // it on the instance, and a field nobody stores cannot prove that.
    { sys_id: STORY_ID, number: "STRY0042", short_description: PROSE },
    { sys_id: hex("57021"), number: "STRY0043" },
  ],
  sys_update_set: [
    { sys_id: SET_A, name: "STRY0042 part 1", story: STORY_ID },
    { sys_id: SET_B, name: "STRY0042 part 2", story: STORY_ID },
    { sys_id: hex("5e7c"), name: "someone else's work", story: hex("57021") },
  ],
  sys_update_xml: [
    {
      sys_id: hex("e1"),
      name: `sys_script_${RULE_ID}`,
      type: "Business Rule",
      target_name: "Tessera demo rule",
      action: "INSERT_OR_UPDATE",
      update_set: SET_A,
    },
    {
      sys_id: hex("e2"),
      name: `sys_script_include_${INCLUDE_ID}`,
      type: "Script Include",
      target_name: "TesseraUtil",
      action: "INSERT_OR_UPDATE",
      update_set: SET_A,
    },
    // The same rule again, from the second update set.
    {
      sys_id: hex("e3"),
      name: `sys_script_${RULE_ID}`,
      type: "Business Rule",
      target_name: "Tessera demo rule",
      action: "INSERT_OR_UPDATE",
      update_set: SET_B,
    },
    {
      sys_id: hex("e4"),
      name: `sys_ui_policy_${POLICY_ID}`,
      type: "UI Policy",
      target_name: "Retired policy",
      action: "DELETE",
      update_set: SET_B,
    },
    {
      sys_id: hex("e5"),
      name: "sys_dictionary_incident_u_thing",
      type: "Dictionary",
      target_name: "",
      action: "INSERT_OR_UPDATE",
      update_set: SET_B,
    },
    // A member of an update set that belongs to another story — proof the
    // `IN` filter is doing the work rather than the seed being convenient.
    {
      sys_id: hex("e6"),
      name: `sys_script_${hex("f00d")}`,
      type: "Business Rule",
      target_name: "Not this story",
      action: "INSERT_OR_UPDATE",
      update_set: hex("5e7c"),
    },
  ],
};

function withFake() {
  const fake = createFakeInstance({ host: HOST, state: SEED });
  const restoreFetch = fake.install();

  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(os.tmpdir(), "tessera-resolvers-docs");
  // One shot per read: the transport retries idempotent GETs by default, which
  // would let a single-fire fault be papered over by the retry.
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_PROFILE_SOURCE_INSTANCE = HOST;
  process.env.SN_PROFILE_SOURCE_USER = "tessera";
  process.env.SN_PROFILE_SOURCE_PASSWORD = "tessera";
  // No ambient profile: if the per-request profile plumbing ever stopped
  // working, the read has to fail loudly rather than answer from somewhere.
  delete process.env.SN_INSTANCE;
  delete process.env.SN_USER;
  delete process.env.SN_PASSWORD;
  delete process.env.SN_READONLY;
  delete process.env.SN_ACTIVE_PROFILE;
  delete process.env.SN_TABLES_ALLOW;
  delete process.env.SN_TABLES_DENY;
  reloadCredentialsFromEnv();

  return {
    fake,
    resolver: createStoryResolver(createSnRecordReader("source")),
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

const methods = (fake) =>
  [...new Set(fake.requests().map((request) => request.method))].sort();

describe("against a live fake instance", () => {
  it("resolves a story to the records its update sets changed, and only GETs", async () => {
    const h = withFake();
    try {
      const report = await h.resolver.resolveWithReport(CTX, {
        story: "STRY0042",
      });

      assert.deepEqual(
        report.artifacts.map((artifact) => [
          artifact.ref.table,
          artifact.ref.sysId,
          artifact.ref.name,
          artifact.resolvedBy,
        ]),
        [
          ["sys_script", RULE_ID, "Tessera demo rule", "story"],
          ["sys_script_include", INCLUDE_ID, "TesseraUtil", "story"],
        ],
      );
      // The deletion, the unaddressable dictionary row and the duplicate are
      // all accounted for rather than quietly absent.
      assert.match(textOf(report), /1 member\(s\) delete a record/);
      assert.match(textOf(report), /1 duplicate member\(s\) collapsed/);
      assert.match(textOf(report), /sys_dictionary_incident_u_thing/);
      assert.equal(isIncomplete(report), true);

      // Three reads and no more: story, its update sets, their members.
      assert.equal(h.fake.requests().length, 3);
      // ARCH-8: this stage has no write path, on any instance it is pointed at.
      assert.deepEqual(methods(h.fake), ["GET"]);

      // TM-1 end to end: the prose is on the instance and never crossed the
      // wire, because the projection never asked for it.
      const storyRequest = h.fake.requests()[0];
      assert.equal(storyRequest.path, "/api/now/table/rm_story");
      assert.equal(storyRequest.params.sysparm_fields, "sys_id,number");
      assert.equal(JSON.stringify(report).includes(PROSE), false);
    } finally {
      h.restore();
    }
  });

  it("faults instead of reporting an empty story when the link query is refused", async () => {
    const h = withFake();
    try {
      // Exactly what an instance whose stories link through another field
      // does: it rejects the question. The wrong answer available here is a
      // clean, empty, green one.
      h.fake.faults.add({
        match: { table: "sys_update_set" },
        mode: {
          kind: "http-error",
          status: 400,
          message: "Invalid field name story",
        },
      });

      await assert.rejects(
        () => h.resolver.resolveWithReport(CTX, { story: "STRY0042" }),
        (error) => {
          assert.ok(error instanceof ResolutionFaultError);
          assert.match(error.message, /updateSetStoryField/);
          return true;
        },
      );
    } finally {
      h.restore();
    }
  });

  it("reports a story the instance does not have as an input error", async () => {
    const h = withFake();
    try {
      await assert.rejects(
        () => h.resolver.resolveWithReport(CTX, { story: "STRY9999" }),
        ResolutionInputError,
      );
    } finally {
      h.restore();
    }
  });
});

// ── silences this resolver is not allowed to keep ───────────────────────────
//
// One defect class, four shapes: a row dropped by a filter, a count that
// describes what survived the filter, an empty answer read as an absence, and
// an address printed for a row that never carried one. Each case asserts the
// property — what the report may not imply — rather than the sentence that
// currently carries it.

describe("what the reads could not see is never left unsaid", () => {
  it("never drops an update set with no readable sys_id in silence", async () => {
    // Field-level ACL trimming renders as a row with `sys_id` simply absent.
    // Such a set cannot be queried for members, so everything it changed is
    // missing from the artifacts below — and the filter that removes it used
    // to be the only place that knew.
    const { report, reader } = await run({
      sys_update_set: answered([
        { sys_id: SET_A, name: "Story work", story: STORY_ID },
        { name: "Trimmed by an ACL", story: STORY_ID },
      ]),
    });

    // The drop is real: only the addressable set is enumerated.
    const members = requestFor(reader, "sys_update_xml");
    assert.match(members.query, new RegExp(SET_A));
    // ...and it is on the record, loudly enough to hold the exit code.
    assert.match(textOf(report), /without a readable sys_id/);
    assert.equal(isIncomplete(report), true);
  });

  it("does not report an empty story when every linked set was unreadable", async () => {
    const { report, reader } = await run({
      sys_update_set: answered([
        { name: "Trimmed", story: STORY_ID },
        { name: "Also trimmed", story: STORY_ID },
      ]),
    });

    assert.deepEqual(report.artifacts, []);
    assert.equal(isIncomplete(report), true);
    // "Two sets are linked and neither is readable" is a different fact from
    // "no sets are linked", and only the second one tells a reader to go and
    // put the work in an update set.
    assert.doesNotMatch(textOf(report), /has no update sets linked/);
    assert.match(textOf(report), /without a readable sys_id/);
    // Nothing addressable, so no member read is issued.
    assert.equal(
      reader.requests.some((request) => request.table === "sys_update_xml"),
      false,
    );
  });

  it("names the reading an empty set list cannot rule out", async () => {
    const { report } = await run({ sys_update_set: answered([]) });

    // The Table API renders "nothing is linked" and "the links are trimmed
    // from this caller" identically (OPP-1b), so the note that sends an
    // operator to `updateSetStoryField` must not stop at the readings that
    // assume they can see everything.
    assert.match(textOf(report), /trimmed from this profile|ACL/i);
  });

  it("never prints an address for a member row that carried none", async () => {
    const { report } = await run({
      sys_update_xml: answered([
        member({ sys_id: "", name: "not-a-parseable-payload-name" }),
      ]),
    });

    assert.deepEqual(report.artifacts, []);
    // `sys_update_xml/` with nothing after it reads as a path and sends a
    // human looking up a row nobody named.
    assert.doesNotMatch(textOf(report), /sys_update_xml\/[,)\s]/);
    assert.doesNotMatch(textOf(report), /sys_update_xml\/$/m);
    assert.match(textOf(report), /no readable sys_update_xml sys_id/);
  });

  it("names both readings of a story number that matched nothing", async () => {
    const { resolver } = resolverFor({ rm_story: answered([]) });

    await assert.rejects(
      () => resolver.resolveWithReport(CTX, { story: "STRY9999" }),
      (error) => {
        assert.ok(error instanceof ResolutionInputError);
        // The instance answered — that much is provable, and the existing case
        // above pins it. What an empty answer does NOT prove is that no such
        // story exists: a story this caller is not shown answers identically.
        assert.match(error.message, /ACL|cannot read|can read/i);
        return true;
      },
    );
  });
});

// ── review 2026-09-25: encoded-query injection ──────────────────────────────

describe("a story argument is a value, never a query fragment", () => {
  for (const bad of [
    "STRY0001^NQnumber=STRY0999",
    "STRY0001^ORnumber=STRY0999",
    "STRY=1",
    "STRY0001,STRY0999",
    "STRY0001@x",
    "STRY0001\rX",
    "STRY0001\nX",
  ]) {
    it(`refuses ${JSON.stringify(bad)} without sending a query`, async () => {
      const { resolver, reader } = resolverFor();
      await assert.rejects(
        () => resolver.resolveWithReport(CTX, { story: bad }),
        (error) => {
          assert.ok(error instanceof ResolutionInputError);
          assert.match(error.message, /encoded-query syntax/);
          return true;
        },
      );
      assert.equal(reader.requests.length, 0);
    });
  }

  it("refuses a row whose number is not the one that was named", async () => {
    const { resolver, reader } = resolverFor({
      rm_story: answered([{ sys_id: STORY_ID, number: "STRY0999" }]),
    });
    await assert.rejects(
      () => resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      (error) => {
        assert.ok(error instanceof ResolutionInputError);
        assert.match(error.message, /not the story that was named/);
        return true;
      },
    );
    assert.equal(reader.requests.length, 1);
  });

  it("refuses a row whose sys_id is not the one that was named", async () => {
    const { resolver } = resolverFor({
      rm_story: answered([{ sys_id: hex("57020"), number: "STRY0042" }]),
    });
    await assert.rejects(
      () => resolver.resolveWithReport(CTX, { story: STORY_ID }),
      ResolutionInputError,
    );
  });

  it("faults on a story sys_id that is not shaped like one", async () => {
    const { resolver, reader } = resolverFor({
      rm_story: answered([{ sys_id: "x^NQsys_id=y", number: "STRY0042" }]),
    });
    await assert.rejects(
      () => resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      ResolutionFaultError,
    );
    assert.equal(reader.requests.length, 1);
  });

  it("refuses an updateSetStoryField that is not a field name", async () => {
    const { resolver, reader } = resolverFor(
      {},
      {
        updateSetStoryField: "story^NQactive=true",
      },
    );
    await assert.rejects(
      () => resolver.resolveWithReport(CTX, { story: "STRY0042" }),
      ResolutionInputError,
    );
    assert.equal(reader.requests.length, 0);
  });

  it("never splices a malformed update-set id into the IN list", async () => {
    const { report, reader } = await run({
      sys_update_set: answered([
        { sys_id: SET_A, name: "ok", story: STORY_ID },
        {
          sys_id: `${SET_B},${hex("ffff")}`,
          name: "widened",
          story: STORY_ID,
        },
      ]),
    });
    const query = requestFor(reader, "sys_update_xml").query;
    assert.equal(query, `update_setIN${SET_A}^ORDERBYsys_id`);
    assert.match(textOf(report), /1 of the 2 update set\(s\)/);
  });
});
