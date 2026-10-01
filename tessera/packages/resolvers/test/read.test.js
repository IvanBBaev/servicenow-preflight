// RecordReader adapter — the DEV-1 error boundary of `src/read.ts`.
//
// The 2026-08-26 ruling (`runner-atf/src/client.ts`) normalised that package's
// transport faults into one owned type. It does not extend to this adapter,
// and the header of `src/read.ts` says why: the runner rejects, so a
// `ServiceNowError` escaping it reached a domain caller, while this adapter
// converts every fault into a member of the closed `TableRead` union and lets
// nothing out. Reading the vendored type on the far side of the port is what
// an adapter is for.
//
// What that ruling leaves for a test to hold is the consequence, and it is the
// reason these cases exist rather than a comment: a `ServiceNowError` is NOT
// proof that the instance said anything. `assertTableAllowed` inside
// `@tessera/sn-client` raises the identical type with an identical 403 status
// when SN_TABLES_ALLOW/SN_TABLES_DENY refuses a table — before a request is
// sent, from a policy the operator configured locally. Two things must survive
// that: the verdict stays `undecidable` (a refusal is never a clean empty
// answer), and the evidence line does not pin the refusal on the instance's
// ACLs when the instance was never asked.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import { createSnRecordReader } from "../build/index.js";

const HOST = "dev-resolvers-read.service-now.com";

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
  "SN_MAX_RECORDS",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
  "SN_PROFILE_SOURCE_INSTANCE",
  "SN_PROFILE_SOURCE_USER",
  "SN_PROFILE_SOURCE_PASSWORD",
];

const QUERY = {
  table: "sys_script",
  query: "active=true",
  fields: ["sys_id", "script"],
  limit: 1,
};

/**
 * Credentials for the `source` profile and nothing ambient, matching the other
 * adapter suites. `policy` seeds the client-side table policy under test.
 */
function withEnv(policy = {}) {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(os.tmpdir(), "tessera-resolvers-docs");
  // One shot per read: an idempotent GET is retried by default, which would
  // let a single-fire injected fault be papered over by the retry.
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_PROFILE_SOURCE_INSTANCE = HOST;
  process.env.SN_PROFILE_SOURCE_USER = "tessera";
  process.env.SN_PROFILE_SOURCE_PASSWORD = "tessera";
  if (policy.allow !== undefined) process.env.SN_TABLES_ALLOW = policy.allow;
  if (policy.deny !== undefined) process.env.SN_TABLES_DENY = policy.deny;
  if (policy.maxRecords !== undefined) {
    process.env.SN_MAX_RECORDS = String(policy.maxRecords);
  }
  reloadCredentialsFromEnv();

  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadCredentialsFromEnv();
  };
}

/**
 * No instance at all, and a `fetch` that counts. A client-side policy denial
 * must never reach the wire, and the counter is what proves the 403 under test
 * was fabricated locally rather than answered by anyone.
 */
function countingFetch() {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error("the read reached the wire");
  };
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

describe("createSnRecordReader — a denial the client itself fabricated", () => {
  for (const [label, policy] of [
    ["a denylist naming the table", { deny: "sys_script" }],
    ["an allowlist that omits it", { allow: "sys_user,sys_scope" }],
    [
      "a denylist that wins over an allowlist",
      {
        allow: "sys_script",
        deny: "sys_script",
      },
    ],
  ]) {
    it(`is undecidable, never a clean empty answer, under ${label}`, async () => {
      const restoreEnv = withEnv(policy);
      const wire = countingFetch();
      try {
        const read = await createSnRecordReader("source").queryRecords(QUERY);

        // The whole DEV-1 point: zero rows because nothing was asked, which
        // must not render as "nothing matched".
        assert.equal(read.outcome, "undecidable");
        assert.deepEqual(read.records, []);
        assert.equal(read.truncated, false);
        // The 403 was manufactured inside the client; no one was consulted.
        assert.deepEqual(wire.calls, []);
      } finally {
        wire.restore();
        restoreEnv();
      }
    });
  }

  it("reports it without claiming the instance refused", async () => {
    const restoreEnv = withEnv({ deny: "sys_script" });
    const wire = countingFetch();
    try {
      const read = await createSnRecordReader("source").queryRecords(QUERY);

      // The evidence line is the product for an infrastructure fault — it is
      // the only thing that tells an operator where to look. Naming only the
      // instance's ACLs sends them to a ServiceNow role they cannot change,
      // for a refusal that lives in their own environment.
      assert.match(read.detail, /SN_TABLES_ALLOW\/SN_TABLES_DENY/);
      assert.match(read.detail, /before a request was sent/);
      assert.deepEqual(wire.calls, []);
    } finally {
      wire.restore();
      restoreEnv();
    }
  });

  it("words a real 403 from the instance the same way, because the adapter cannot tell them apart", async () => {
    // The other half of the claim. If this branch ever learns to discriminate,
    // these two details must stop being identical — and this test is what
    // notices, rather than the two wordings silently drifting.
    const fake = createFakeInstance({ host: HOST, state: { sys_script: [] } });
    const restoreFetch = fake.install();
    const restoreEnv = withEnv();
    try {
      fake.faults.add({
        match: { table: "sys_script" },
        mode: { kind: "http-error", status: 403, message: "no read access" },
      });
      const read = await createSnRecordReader("source").queryRecords(QUERY);

      assert.equal(read.outcome, "undecidable");
      assert.match(read.detail, /SN_TABLES_ALLOW\/SN_TABLES_DENY/);
      // This time the instance really was asked — which is exactly why the
      // adapter has no basis for saying so in the other case.
      assert.equal(fake.requests().length, 1);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });
});

// A `ServiceNowError` has a SECOND way of not meaning "the instance answered",
// and it is quieter than the fabricated 403 above: no `status` at all. The
// transport raises that same type with `status` unset for a dropped
// connection, a timeout, and a request that never left the client at all
// (unconfigured instance, missing credentials, host policy). None of those is
// the instance saying anything, so no branch that quotes a status may be
// reachable from one — and the branch here quotes it into the operator's line.
//
// This is what the whole suite could not see. Removing the single conjunct
// that kept that branch unreachable left resolvers, doctor, parity and cli all
// green while a real `fetch` failure rendered as `rejected (undefined)`: a
// status that does not exist, printed in the grammar of one the instance sent.
// An operator reading it cannot tell "look this status up" from "nothing ever
// arrived", which on a DEV-1 boundary is the entire product of the row.
describe("createSnRecordReader — a rejection that carries no status", () => {
  it("never dresses a read that got no answer as a query the instance rejected", async () => {
    const restoreEnv = withEnv();
    // Same helper, opposite purpose: above, the count proving ZERO requests is
    // what shows the 403 was local. Here the throw is the point and the count
    // proves the read did reach the wire — so the error under test is a
    // genuinely status-less transport fault, not the fabricated 403 again.
    const wire = countingFetch();
    try {
      const read = await createSnRecordReader("source").queryRecords(QUERY);

      // Not rounded up to an answer, not down to a refusal.
      assert.equal(read.outcome, "undecidable");
      assert.deepEqual(read.records, []);
      assert.equal(read.truncated, false);
      assert.equal(wire.calls.length, 1);

      // The claim: the evidence quotes no status, because there is none to
      // quote. `rejected (undefined)` was the shape the defect took; the
      // property is that the word never reaches an operator-facing line at all.
      assert.doesNotMatch(read.detail, /undefined/);
      assert.doesNotMatch(read.detail, /rejected \(/);
      assert.doesNotMatch(read.detail, /refused \(/);

      // And it states the fact it does have — nothing came back — while
      // declining to pick between the two readings it cannot separate, the
      // same way the 403 line above declines to pick between its two.
      assert.match(read.detail, /no answer was received/);
      assert.match(read.detail, /never left this client/);
      assert.match(read.detail, /never got a response/);
      // The transport's own message survives; it carries the URL and the cause,
      // and it is the only part that tells the operator where to look.
      assert.match(read.detail, /the read reached the wire/);
    } finally {
      wire.restore();
      restoreEnv();
    }
  });
});

// A third way a `ServiceNowError` does not mean what the line says. The status
// IS real here — the instance sent it — but the sentence built around it was
// "query `...` rejected", which claims the instance evaluated the query and
// refused it. A 500 never got that far, and a 401 refused the caller before
// any query was read. An operator handed the query back goes hunting a field
// name that was never the problem.
describe("createSnRecordReader — a status that is not a verdict on the query", () => {
  for (const [label, status] of [
    ["a server fault", 500],
    ["an unauthenticated read", 401],
  ]) {
    it(`never calls the query rejected on ${label}`, async () => {
      const fake = createFakeInstance({
        host: HOST,
        state: { sys_script: [] },
      });
      const restoreFetch = fake.install();
      const restoreEnv = withEnv();
      try {
        fake.faults.add({
          match: { table: "sys_script" },
          mode: { kind: "http-error", status, message: "upstream trouble" },
        });
        const read = await createSnRecordReader("source").queryRecords(QUERY);

        assert.equal(read.outcome, "undecidable");
        assert.doesNotMatch(read.detail, /rejected/);
        assert.doesNotMatch(read.detail, new RegExp(QUERY.query));
        // What it does have: the status, and the fact that it decided nothing.
        assert.match(read.detail, new RegExp(String(status)));
        assert.match(read.detail, /nothing was said about the rows/);
      } finally {
        restoreEnv();
        restoreFetch();
      }
    });
  }

  it("still hands back the query on a 400, where the instance did judge it", async () => {
    // The other half of the claim, and the reason the branch was not simply
    // deleted: a 400 IS a verdict on the question, and quoting it back is the
    // only thing that tells an operator which field to fix.
    const fake = createFakeInstance({ host: HOST, state: { sys_script: [] } });
    const restoreFetch = fake.install();
    const restoreEnv = withEnv();
    try {
      fake.faults.add({
        match: { table: "sys_script" },
        mode: { kind: "http-error", status: 400, message: "Invalid field" },
      });
      const read = await createSnRecordReader("source").queryRecords(QUERY);

      assert.equal(read.outcome, "undecidable");
      assert.match(read.detail, /rejected \(400\)/);
      assert.match(read.detail, new RegExp(QUERY.query));
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });
});

// The mutation that closed this gap: reverting the namespace-404 line to "the
// table is not a resource on this instance" reddened NOTHING in this package
// (M7, 2026-09-03) while its exact counterpart in `@tessera/parity` was caught.
// The fix was real and the sentence was the only thing holding it, so the
// property is asserted here rather than left to the next reader to rediscover.
describe("createSnRecordReader — a 404 that names a table, not a row", () => {
  it("says nothing about the rows, and does not claim the table is absent instance-wide", async () => {
    const fake = createFakeInstance({ host: HOST, state: { sys_script: [] } });
    const restoreFetch = fake.install();
    const restoreEnv = withEnv();
    try {
      fake.faults.add({
        match: { table: "sys_script" },
        mode: {
          kind: "http-error",
          status: 404,
          message: "Requested URI does not represent any resource",
        },
      });
      const read = await createSnRecordReader("source").queryRecords(QUERY);

      // A namespace 404 is a fact about what THIS session could resolve: a
      // table outside the caller's scope, or one whose plugin is inactive for
      // them, answers identically to one that was never installed.
      assert.equal(read.outcome, "undecidable");
      assert.match(read.detail, /for the connected user|this caller/i);
      assert.match(read.detail, /scope|roles|cannot resolve/i);
      // And the row-level half is still said: no rows were spoken about.
      assert.match(read.detail, /nothing was said about its rows/);
      // The query was never evaluated, so it must not be handed back in the
      // grammar of a rejected question.
      assert.doesNotMatch(read.detail, /rejected/);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });
});

// ── the namespace wording, wherever the body puts it ─────────────────────────
//
// The property: a namespace 404 is recognised as one no matter WHICH field of
// the error body carries the wording. The two placements must be
// indistinguishable to `undecidable()`.
//
// Why it can be violated: `extractErrorDetail` (`@tessera/sn-client`'s
// `core/http.ts`) PREFERS `error.message` and only falls back to
// `error.detail`, so a body carrying the wording in `detail` alone arrives with
// a `ServiceNowError.message` that says nothing about a namespace — while
// `ServiceNowError.detail`, the whole parsed body, still holds it.
// `api/plugin.ts` composes message plus body and catches those; this adapter
// tested the message alone and did not.
//
// The verdict is `undecidable` either way here, so what the widening buys is
// the EVIDENCE line — and on an undecidable read the evidence line is the
// entire product. "the read failed with status 404" sends an operator hunting a
// transport fault; "the table is not a resource for the connected user" sends
// them to the scope and the plugin, which is where the answer is.
//
// The third body is the control: without it the equality below would hold for
// an adapter that gave every 404 the namespace sentence, which would state a
// fact about the table on a 404 that said nothing about it.
const NAMESPACE_PHRASE_404 =
  "The requested URI does not represent any resource on the server";
const RECORD_PHRASE_404 = "No Record found";
const RECORD_DETAIL_404 =
  "Record doesn't exist or ACL restricts the record retrieval";

// NAMESPACE_404 has two alternatives and a real instance uses both. The two
// placements below therefore carry a different half each: the message carries
// "does not represent any resource", the detail carries "Invalid URI". Give
// both placements the same phrasing and half the pattern goes untested.
const NAMESPACE_DETAIL_PHRASE = "Invalid URI: /api/now/table/sys_script";

/** The SN error body shape, with the namespace wording placed where asked. */
function bodyWithWordingIn(where) {
  return {
    error: {
      message: where === "message" ? NAMESPACE_PHRASE_404 : RECORD_PHRASE_404,
      detail: where === "detail" ? NAMESPACE_DETAIL_PHRASE : RECORD_DETAIL_404,
    },
    status: "failure",
  };
}

const WORDING_PLACEMENTS = ["message", "detail", "nowhere"];

describe("createSnRecordReader — the namespace wording, in message or in detail", () => {
  it("reads a 404 the same whichever field of the body carries the wording", async () => {
    const fake = createFakeInstance({ host: HOST, state: { sys_script: [] } });
    const restoreFetch = fake.install();
    const restoreEnv = withEnv();
    try {
      for (const where of WORDING_PLACEMENTS) {
        fake.faults.add({
          match: { table: "sys_script", times: 1 },
          mode: {
            kind: "http-error",
            status: 404,
            body: bodyWithWordingIn(where),
          },
        });
      }

      const reader = createSnRecordReader("source");
      const fromMessage = await reader.queryRecords(QUERY);
      const fromDetail = await reader.queryRecords(QUERY);
      const control = await reader.queryRecords(QUERY);

      // The property, as an equality: the placement is invisible to the
      // adapter. This fails the moment the match narrows back to
      // `error.message` — `fromDetail` falls through to the generic
      // status-404 line and stops naming the table.
      assert.deepEqual(
        fromDetail,
        fromMessage,
        "a namespace 404 was read differently depending on which field of the body carried the wording",
      );
      assert.equal(fromMessage.outcome, "undecidable");
      assert.match(fromMessage.detail, /not a resource on this instance/);
      assert.match(fromMessage.detail, /nothing was said about its rows/);
      // Control: a 404 without the wording said nothing about the table, so
      // the line may not make a claim about the table.
      assert.equal(control.outcome, "undecidable");
      assert.doesNotMatch(control.detail, /not a resource on this instance/);
      assert.match(control.detail, /the read failed with status 404/);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  // The same body, judged by the canonical transport's own composition. If
  // this adapter and `api/plugin.ts` ever answer differently about one body,
  // one of them is wrong and no equality above would say which.
  it("agrees with the vendored transport on the same body", async () => {
    const fake = createFakeInstance({ host: HOST, state: { sys_script: [] } });
    const restoreFetch = fake.install();
    const restoreEnv = withEnv();
    try {
      const reader = createSnRecordReader("source");
      for (const where of WORDING_PLACEMENTS) {
        const body = bodyWithWordingIn(where);
        // What `core/http.ts` hands the adapter: the message it derived
        // (message preferred, detail as fallback) and the whole parsed body.
        const derived = `ServiceNow API error (404): ${body.error.message}`;
        const transportSaysNamespace =
          /does not represent any resource|invalid uri/i.test(
            `${derived} ${JSON.stringify(body)}`,
          );

        fake.faults.add({
          match: { table: "sys_script", times: 1 },
          mode: { kind: "http-error", status: 404, body },
        });
        const read = await reader.queryRecords(QUERY);
        assert.equal(
          /not a resource on this instance/.test(read.detail),
          transportSaysNamespace,
          `wording in ${where}: the adapter and the vendored transport disagree about the same body`,
        );
      }
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });
});

// ── why a fetchAll read is partial ───────────────────────────────────────────
//
// Delegated decision 2026-09-26: `TableRead.truncated` used to be documented
// as "stopped at the SN_MAX_RECORDS cap", and every caller worded it that way.
// The transport now names three partial cases, and the adapter passes the
// reason (and the X-Total-Count it is measured against) through untouched.
// Each case is driven through the real transport: the cap by a small
// SN_MAX_RECORDS, a short page by the fake's row read-ACL (hidden rows shorten
// the page while X-Total-Count keeps counting them), and no-total by a fetch
// stub that strips the header from the fake's answer.

const ALL = {
  table: "sys_script",
  query: "active=true",
  fields: ["sys_id", "name"],
  fetchAll: true,
};

const THREE_SCRIPTS = [
  { name: "one", active: "true" },
  { name: "two", active: "true" },
  { name: "hidden", active: "true" },
];

/** The fake's fetch with X-Total-Count removed — `sysparm_no_count`'s wire. */
function withoutTotalCount(fake) {
  const host = {};
  fake.install(host);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await host.fetch(...args);
    const headers = new Headers(response.headers);
    headers.delete("x-total-count");
    return new Response(await response.text(), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe("createSnRecordReader — the reason a read is partial", () => {
  it("reports a complete read as untruncated, with no reason", async () => {
    const fake = createFakeInstance({
      host: HOST,
      state: { sys_script: THREE_SCRIPTS },
    });
    const restoreFetch = fake.install();
    const restoreEnv = withEnv();
    try {
      const read = await createSnRecordReader("source").queryRecords(ALL);

      assert.equal(read.outcome, "answered");
      assert.equal(read.records.length, 3);
      assert.equal(read.truncated, false);
      assert.equal(read.truncationReason, undefined);
      assert.equal("truncationReason" in read, false);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("passes the cap through as the cap", async () => {
    const fake = createFakeInstance({
      host: HOST,
      state: { sys_script: THREE_SCRIPTS },
    });
    const restoreFetch = fake.install();
    const restoreEnv = withEnv({ maxRecords: 2 });
    try {
      const read = await createSnRecordReader("source").queryRecords(ALL);

      assert.equal(read.outcome, "answered");
      assert.equal(read.records.length, 2);
      assert.equal(read.truncated, true);
      assert.equal(read.truncationReason, "cap");
      assert.equal(read.total, 3);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("passes a page the read ACLs shortened through as a short page", async () => {
    const fake = createFakeInstance({
      host: HOST,
      state: { sys_script: THREE_SCRIPTS },
      readAcl: {
        rules: [{ table: "sys_script", when: (row) => row.name === "hidden" }],
      },
    });
    const restoreFetch = fake.install();
    const restoreEnv = withEnv();
    try {
      const read = await createSnRecordReader("source").queryRecords(ALL);

      assert.equal(read.outcome, "answered");
      assert.equal(read.records.length, 2);
      assert.equal(read.truncated, true);
      assert.equal(read.truncationReason, "short-page");
      assert.equal(read.total, 3);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("passes a capped read with no X-Total-Count through as no-total", async () => {
    const fake = createFakeInstance({
      host: HOST,
      state: { sys_script: THREE_SCRIPTS },
    });
    const restoreFetch = withoutTotalCount(fake);
    const restoreEnv = withEnv({ maxRecords: 2 });
    try {
      const read = await createSnRecordReader("source").queryRecords(ALL);

      assert.equal(read.outcome, "answered");
      assert.equal(read.records.length, 2);
      assert.equal(read.truncated, true);
      assert.equal(read.truncationReason, "no-total");
      assert.equal(read.total, undefined);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });
});

// ── wave 17: the Stats API cross-check through the port ──────────────────────
//
// `crossCheckCount` on a request reaches the transport, and what the
// transport learnt — the reason AND the Stats count it is measured against —
// comes back on the `TableRead`, so `describeReadTruncation` can quote it.
// The hidden row sorts LAST (explicit sys_ids, `ORDERBYsys_id`), which is the
// trimmed-last-window case the probe alone cannot see.

const ORDERED_SCRIPTS = [
  { sys_id: "a".repeat(32), name: "one", active: "true" },
  { sys_id: "b".repeat(32), name: "two", active: "true" },
  { sys_id: "c".repeat(32), name: "hidden", active: "true" },
];

function crossCheckFake(options = {}) {
  const fake = createFakeInstance({
    host: HOST,
    state: { sys_script: ORDERED_SCRIPTS },
    omitTotalCount: true,
    ...options,
  });
  return { fake, restoreFetch: fake.install() };
}

const HIDE_LAST = {
  rules: [{ table: "sys_script", when: (row) => row.name === "hidden" }],
};

const statsRequests = (fake) =>
  fake.requests().filter((r) => r.path.startsWith("/api/now/stats/"));

describe("createSnRecordReader — the Stats API cross-check", () => {
  it("forwards crossCheckCount and carries the mismatch and its count back", async () => {
    const { fake, restoreFetch } = crossCheckFake({ readAcl: HIDE_LAST });
    const restoreEnv = withEnv();
    try {
      const read = await createSnRecordReader("source").queryRecords({
        ...ALL,
        crossCheckCount: true,
      });

      assert.equal(read.outcome, "answered");
      assert.equal(read.records.length, 2);
      assert.equal(read.truncated, true);
      assert.equal(read.truncationReason, "count-mismatch");
      assert.equal(read.count, 3);
      assert.equal(read.total, undefined);
      assert.equal(statsRequests(fake).length, 1);
      assert.equal(statsRequests(fake)[0].params.sysparm_query, "active=true");
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("carries a matching count on a complete read, untruncated", async () => {
    const { fake, restoreFetch } = crossCheckFake();
    const restoreEnv = withEnv();
    try {
      const read = await createSnRecordReader("source").queryRecords({
        ...ALL,
        crossCheckCount: true,
      });

      assert.equal(read.truncated, false);
      assert.equal("truncationReason" in read, false);
      assert.equal(read.count, 3);
      assert.equal(statsRequests(fake).length, 1);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("passes a failed count through as count-unavailable", async () => {
    const { fake, restoreFetch } = crossCheckFake();
    const restoreEnv = withEnv();
    try {
      fake.faults.add({
        match: { path: "/api/now/stats/" },
        mode: { kind: "http-error", status: 404, message: "No such API" },
      });
      const read = await createSnRecordReader("source").queryRecords({
        ...ALL,
        crossCheckCount: true,
      });

      assert.equal(read.outcome, "answered");
      assert.equal(read.records.length, 3);
      assert.equal(read.truncated, true);
      assert.equal(read.truncationReason, "count-unavailable");
      assert.equal("count" in read, false);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });

  it("sends no count when the request does not ask for one (opt-in)", async () => {
    const { fake, restoreFetch } = crossCheckFake({ readAcl: HIDE_LAST });
    const restoreEnv = withEnv();
    try {
      const read = await createSnRecordReader("source").queryRecords(ALL);

      // The pre-wave-17 blind spot, kept visible: without the cross-check
      // the trimmed last window reads as complete.
      assert.equal(read.truncated, false);
      assert.equal(statsRequests(fake).length, 0);
      assert.equal("count" in read, false);
    } finally {
      restoreEnv();
      restoreFetch();
    }
  });
});
