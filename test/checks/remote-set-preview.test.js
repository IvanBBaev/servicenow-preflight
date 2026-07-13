import { test } from "node:test";
import assert from "node:assert/strict";

import { remoteSetPreview } from "../../build/checks/remote-set-preview.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const INSTANCE = "https://dev12345.service-now.com";
const AUTH = { kind: "basic", user: "admin", pass: "secret" };

/**
 * Route the fake's single global query filter by table name:
 * - `sys_remote_update_set` honours the check's static `state!=committed`
 *   filter, so committed history stays out of the read the way the real
 *   instance would keep it out;
 * - `sys_update_preview_problem` honours the batched
 *   `remote_update_setIN<id1>,<id2>,…` membership clause (SN-6), yielding every
 *   seeded problem whose set is in the batch.
 */
function queryFilter(table, rows, params) {
  const q = params?.sysparm_query ?? "";
  if (table === "sys_remote_update_set" && q.includes("state!=committed")) {
    return rows.filter((r) => r.state !== "committed");
  }
  if (table === "sys_update_preview_problem") {
    const inMatch = /remote_update_setIN([^^]+)/.exec(q);
    if (inMatch) {
      const ids = new Set(inMatch[1].split(","));
      return rows.filter((r) => ids.has(r.remote_update_set));
    }
  }
  return rows;
}

/** Assemble a fake client from remote-set / problem fixtures plus overrides. */
function makeHttp({ remoteSets = [], problems = [], fail, totalCounts } = {}) {
  return createFakeSnClient({
    tables: {
      sys_remote_update_set: remoteSets,
      sys_update_preview_problem: problems,
    },
    // The real Table API returns `remote_update_set` as a `{ link, value }`
    // reference object, never a bare string — force that shape so the check's
    // reference unwrapping is exercised, not bypassed.
    referenceFields: { sys_update_preview_problem: ["remote_update_set"] },
    queryFilter,
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return remoteSetPreview.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http,
    ...extra,
  });
}

test("remote-set-preview keeps its registered name", async () => {
  const result = await run(makeHttp());
  assert.equal(result.name, "remote-set-preview");
});

test("passes with 'nothing pending' when no remote sets exist and no focus is set", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing awaiting preview or commit/i);
});

test("ignores committed remote sets — commit is terminal, nothing to gate", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [
        { sys_id: "r1", name: "Old release", state: "committed" },
        { sys_id: "r2", name: "Older release", state: "committed" },
      ],
    }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing awaiting/i);
});

test("passes when every pending set is previewed with zero problems", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [
        { sys_id: "r1", name: "Sprint fixes", state: "previewed" },
        { sys_id: "r2", name: "Hotfix", state: "previewed" },
      ],
    }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /All 2 pending/);
  assert.match(result.message, /previewed cleanly/);
});

test("fails when a pending set is loaded but never previewed", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Sprint fixes", state: "loaded" }],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /preview has not been run/);
  assert.match(result.message, /Sprint fixes/);
});

test("labels a loaded set with no readable name or sys_id as (unnamed)", async () => {
  const result = await run(makeHttp({ remoteSets: [{ state: "loaded" }] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /\(unnamed\)/);
});

test("fails on unresolved preview errors with a count and bounded samples", async () => {
  const problems = [1, 2, 3, 4, 5].map((n) => ({
    sys_id: `p${n}`,
    remote_update_set: "r1",
    type: "error",
    status: "",
    description: `collision-detail-${n}`,
  }));
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Sprint fixes", state: "previewed" }],
      problems,
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /5 unresolved preview error\(s\)/);
  // Samples are bounded to 3 — the first three appear, the last does not.
  assert.match(result.message, /collision-detail-1/);
  assert.match(result.message, /collision-detail-3/);
  assert.doesNotMatch(result.message, /collision-detail-5/);
});

test("truncates an over-long problem description in the sample", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Big", state: "previewed" }],
      problems: [
        {
          sys_id: "p1",
          remote_update_set: "r1",
          type: "error",
          status: "",
          description: "x".repeat(400),
        },
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /x{50,120}…/);
  assert.doesNotMatch(result.message, /x{200}/);
});

test("counts an unresolved problem with an unknown type as an error (fail-closed)", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Sprint fixes", state: "previewed" }],
      problems: [
        // Empty type and a bogus custom type — neither may soften the verdict.
        { sys_id: "p1", remote_update_set: "r1", type: "", status: "" },
        {
          sys_id: "p2",
          remote_update_set: "r1",
          type: "informational",
          status: "",
        },
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /2 unresolved preview error\(s\)/);
  assert.match(result.message, /\(no description\)/);
});

test("treats an unrecognised resolution status as unresolved (fail-closed)", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Sprint fixes", state: "previewed" }],
      problems: [
        {
          sys_id: "p1",
          remote_update_set: "r1",
          type: "error",
          status: "wontfix",
          description: "left dangling",
        },
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /1 unresolved preview error/);
});

test("warns when a previewed set carries only unresolved warnings", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Sprint fixes", state: "previewed" }],
      problems: [
        { sys_id: "p1", remote_update_set: "r1", type: "warning", status: "" },
        { sys_id: "p2", remote_update_set: "r1", type: "warning", status: "" },
      ],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /2 unresolved preview warning\(s\)/);
});

test("warns (listing counts) when problems were explicitly accepted or skipped", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Sprint fixes", state: "previewed" }],
      problems: [
        {
          sys_id: "p1",
          remote_update_set: "r1",
          type: "error",
          status: "accepted",
        },
        {
          sys_id: "p2",
          remote_update_set: "r1",
          type: "warning",
          status: "Skipped",
        },
      ],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /2 preview problem\(s\) explicitly resolved as accepted\/skipped/,
  );
});

test("treats 'ignored' as resolved — the platform's raw 'Accept remote update' value", async () => {
  // "Accept remote update" records status `ignored`, not `accepted`. It must be
  // read as an explicitly-resolved problem (warn, reviewable), never counted as
  // an unresolved error that fails the gate.
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Sprint fixes", state: "previewed" }],
      problems: [
        {
          sys_id: "p1",
          remote_update_set: "r1",
          type: "error",
          status: "ignored",
        },
      ],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /1 preview problem\(s\) explicitly resolved/);
  assert.doesNotMatch(result.message, /unresolved preview error/);
});

test("warns on a pending set in an unrecognised state (never passes it)", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Mid-commit", state: "committing" }],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /does not recognise/);
  assert.match(result.message, /committing/);
});

test("warns on a previewed set whose sys_id is unreadable (problems unverifiable)", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [
        { sys_id: "r1", name: "Fine", state: "previewed" },
        { name: "Ghost", state: "previewed" },
      ],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /Ghost/);
  assert.match(result.message, /cannot be verified/);
});

test("aggregates every failing set into one fail message", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [
        { sys_id: "r1", name: "Never previewed", state: "loaded" },
        { sys_id: "r2", name: "Dirty preview", state: "previewed" },
      ],
      problems: [
        {
          sys_id: "p1",
          remote_update_set: "r2",
          type: "error",
          status: "",
          description: "collision",
        },
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /2 of 2 pending/);
  assert.match(result.message, /Never previewed/);
  assert.match(result.message, /Dirty preview/);
});

test("appends advisories to a fail message rather than dropping them", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [
        { sys_id: "r1", name: "Never previewed", state: "loaded" },
        { sys_id: "r2", name: "Mid-commit", state: "committing" },
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /Also:/);
  assert.match(result.message, /does not recognise/);
});

// ---------------------------------------------------------------------------
// Named-set focus (reuses the update-set-state `updateSetId` config — OPP-4)
// ---------------------------------------------------------------------------

test("focus by remote_sys_id gates only the matching set", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [
        {
          sys_id: "r1",
          name: "Target set",
          state: "previewed",
          remote_sys_id: "abc123",
        },
        // An unrelated loaded set would fail an unfocused run — it must be
        // ignored when a focus is configured.
        { sys_id: "r2", name: "Unrelated", state: "loaded" },
      ],
    }),
    { updateSetId: "abc123" },
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /matching "abc123"/);
  assert.match(result.message, /1 set\(s\)/);
});

test("focus matches the retrieved set's name, case-insensitively", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "My_Set", state: "loaded" }],
    }),
    { updateSetId: "my_set" },
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /My_Set/);
  assert.match(result.message, /preview has not been run/);
});

test("focus matches the remote row's own sys_id", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r9", name: "Direct", state: "previewed" }],
    }),
    { updateSetId: "r9" },
  );
  assert.equal(result.status, "pass");
});

test("warns (never silently passes) when the focused set has no pending retrieved copy", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Other set", state: "previewed" }],
    }),
    { updateSetId: "abc123" },
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /not have been retrieved yet/);
  assert.match(result.message, /abc123/);
});

test("warns 'not retrieved yet (or already committed)' when only a committed copy matches", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [
        {
          sys_id: "r1",
          name: "Target set",
          state: "committed",
          remote_sys_id: "abc123",
        },
      ],
    }),
    { updateSetId: "abc123" },
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /already committed/);
});

test("warns on a malformed updateSetId instead of gating everything", async () => {
  const result = await run(makeHttp(), { updateSetId: 42 });
  assert.equal(result.status, "warn");
  assert.match(result.message, /Malformed updateSetId/);
  assert.match(result.message, /got number/);
  assert.match(result.message, /unverified/);
});

test("treats a blank updateSetId as unset — gates all pending sets", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Loaded set", state: "loaded" }],
    }),
    { updateSetId: "   " },
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /preview has not been run/);
});

test("treats a null updateSetId as unset", async () => {
  const result = await run(makeHttp(), { updateSetId: null });
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing awaiting/i);
});

// ---------------------------------------------------------------------------
// ACL security-trimming (SN-1) — zero visible rows are a signal, not truth
// ---------------------------------------------------------------------------

test("warns 'unverified' on a security-trimmed zero-row remote-set read", async () => {
  const result = await run(
    makeHttp({ remoteSets: [], totalCounts: { sys_remote_update_set: 3 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /security-trimmed/);
  assert.match(result.message, /unverified/);
  assert.match(result.message, /3 pending row\(s\)/);
});

test("downgrades a clean verdict to warn when remote-set rows are hidden by ACLs", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Visible", state: "previewed" }],
      totalCounts: { sys_remote_update_set: 4 },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /3 retrieved-set row\(s\) are hidden/);
  assert.match(result.message, /unverified/);
});

test("reports 'some' hidden rows when the pre-trim count is unavailable", async () => {
  // A transport whose meta says "trimmed" without a usable total — the check
  // must still degrade to unverified rather than trust the visible rows.
  const http = {
    table(name) {
      assert.equal(name, "sys_remote_update_set");
      return {
        queryWithMeta: () =>
          Promise.resolve({
            rows: [],
            totalCount: undefined,
            securityTrimmed: true,
          }),
      };
    },
  };
  const result = await run(http);
  assert.equal(result.status, "warn");
  assert.match(result.message, /some pending row\(s\)/);
});

test("warns 'unverified' when preview-problem rows are security-trimmed", async () => {
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Sprint fixes", state: "previewed" }],
      problems: [],
      totalCounts: { sys_update_preview_problem: 2 },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /sys_update_preview_problem rows are hidden/);
  assert.match(result.message, /unverified/);
});

// ---------------------------------------------------------------------------
// Transport error mapping (never throws)
// ---------------------------------------------------------------------------

test("maps SnAuthError to fail", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /Authentication failed/);
});

test("maps SnNetworkError to fail", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /Could not reach/);
});

test("maps SnHttpError to warn (gate unverified)", async () => {
  const result = await run(makeHttp({ fail: { http: 503 } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 503/);
  assert.match(result.message, /unverified/);
});

test("maps an unexpected error to warn with unverified wording", async () => {
  const http = {
    table() {
      return {
        queryWithMeta: () => Promise.reject(new Error("boom")),
      };
    },
  };
  const result = await run(http);
  assert.equal(result.status, "warn");
  assert.match(result.message, /Unexpected error/);
  assert.match(result.message, /unverified/);
  assert.match(result.message, /boom/);
});

test("a failing problems read is mapped, not thrown", async () => {
  // The remote-set read succeeds; only the problems table errors — the catch
  // block must still map it (auth -> fail).
  const result = await run(
    makeHttp({
      remoteSets: [{ sys_id: "r1", name: "Sprint fixes", state: "previewed" }],
      fail: { table: { sys_update_preview_problem: { auth: true } } },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /Authentication failed/);
});

test("warns and skips when no credentials are configured", async () => {
  // An unconfigured run must warn-skip (connectivity-auth already names the
  // fix), never turn the default check set into a hard fail. The fake would
  // throw a network error if the check reached it — proving the guard
  // short-circuits before any read.
  const result = await remoteSetPreview.run({
    instanceUrl: INSTANCE,
    http: makeHttp({ fail: { network: true } }),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No credentials configured/);
});

test("runs with a client certificate alone (mTLS identifies the caller)", async () => {
  // tls without auth is a legitimate identity — the guard must not skip it.
  const result = await remoteSetPreview.run({
    instanceUrl: INSTANCE,
    tls: { cert: "CERT", key: "KEY" },
    http: makeHttp(),
  });
  assert.equal(result.status, "pass");
});
