import { test } from "node:test";
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { createServer } from "node:http";
import { once } from "node:events";

import { createSnClient } from "../build/http/client.js";
import { runPreflight } from "../build/index.js";
import {
  collectTimings,
  createTracer,
  formatTimings,
  requestTarget,
  TRACE_CHANNELS,
} from "../build/trace.js";

const NOW = () => new Date("2026-10-27T00:00:00.000Z");

/** Capture the lines a tracer writes; `close()` it when done. */
function capture() {
  const lines = [];
  const tracer = createTracer((line) => lines.push(line), NOW);
  return {
    tracer,
    events: () => lines.map((line) => JSON.parse(line)),
    raw: () => lines.join(""),
  };
}

/** A loopback instance answering every table read with `rows`. */
async function startInstance(rows = []) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, {
      "content-type": "application/json",
      "x-total-count": String(rows.length),
    });
    res.end(JSON.stringify({ result: rows }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    async stop() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

test("requestTarget keeps the table and templates record-identifying segments", () => {
  assert.deepEqual(
    requestTarget("/api/now/table/sys_user/0123456789abcdef0123456789abcdef"),
    { table: "sys_user" },
  );
  assert.deepEqual(requestTarget("/api/now/table/sys_user?sysparm_query=x"), {
    table: "sys_user",
  });
  assert.deepEqual(
    requestTarget(
      "/api/sn_cicd/progress/0123456789ABCDEF0123456789abcdef?x=secret",
    ),
    { path: "/api/sn_cicd/progress/:id" },
  );
  assert.deepEqual(requestTarget("/api/now/x/hello%20world"), {
    path: "/api/now/x/:value",
  });
  assert.deepEqual(requestTarget("/api/now/table/a%2Fb%20c"), {
    path: ":table",
  });
});

test("the tracer writes only allowlisted fields", () => {
  const { tracer, events, raw } = capture();
  try {
    channel(TRACE_CHANNELS.http).publish({
      method: "GET",
      path: "/api/now/table/sys_user/abc123?sysparm_query=user_name=secret",
      status: 200,
      ms: 12,
      attempt: 1,
      cache: "off",
      check: "acl-role-sanity",
      headers: { authorization: "Basic secret" },
      query: { sysparm_query: "user_name=secret" },
      rows: [{ user_name: "secret" }],
      user: "admin",
    });
    channel(TRACE_CHANNELS.http).publish({
      method: "get; rm -rf",
      path: "/x",
      ms: "slow",
      cache: "sometimes",
      check: "bad name with spaces",
      error: "ECONNRESET secret",
    });
  } finally {
    tracer.close();
  }
  const [first, second] = events();
  assert.deepEqual(first, {
    type: "http",
    ts: "2026-10-27T00:00:00.000Z",
    check: "acl-role-sanity",
    method: "GET",
    table: "sys_user",
    status: 200,
    ms: 12,
    attempt: 1,
    cache: "off",
  });
  assert.deepEqual(second, {
    type: "http",
    ts: "2026-10-27T00:00:00.000Z",
    path: "/x",
  });
  assert.doesNotMatch(raw(), /secret|abc123|admin|Basic|rm -rf/);
});

test("close() stops the tracer", () => {
  const { tracer, events } = capture();
  tracer.close();
  tracer.close();
  channel(TRACE_CHANNELS.check).publish({ phase: "start", check: "a" });
  assert.deepEqual(events(), []);
});

test("a traced run emits run, check and http events with cache marks", async () => {
  const instance = await startInstance([{ sys_id: "a" }]);
  const http = createSnClient({
    instanceUrl: instance.url,
    auth: { kind: "basic", user: "u", pass: "secret" },
    cache: true,
  });
  const read = (name) => ({
    name,
    description: name,
    async run(ctx) {
      await ctx.http.table("sys_user").query({ sysparm_query: "name=secret" });
      return { name, status: "pass", message: "ok" };
    },
  });
  const { tracer, events, raw } = capture();
  tracer.setRun({ version: "9.9.9", instanceHost: "127.0.0.1" });
  const timings = collectTimings();
  let report;
  let seen;
  try {
    report = await runPreflight(
      { instanceUrl: instance.url, http },
      [read("first"), read("second")],
      { concurrency: 1 },
    );
  } finally {
    seen = timings.stop(["first", "second"]);
    tracer.close();
    await instance.stop();
  }
  assert.equal(report.ok, true);
  const list = events();
  assert.deepEqual(list[0], {
    type: "run.start",
    ts: "2026-10-27T00:00:00.000Z",
    version: "9.9.9",
    instanceHost: "127.0.0.1",
    checks: 2,
    concurrency: 1,
  });
  assert.equal(list.at(-1).type, "run.end");
  assert.deepEqual(list.at(-1).summary, { pass: 2, warn: 0, fail: 0 });
  assert.deepEqual(
    list.map((e) => `${e.type}:${e.check ?? ""}:${e.cache ?? ""}`),
    [
      "run.start::",
      "check.start:first:",
      "http:first:miss",
      "check.end:first:",
      "check.start:second:",
      "http:second:hit",
      "check.end:second:",
      "run.end::",
    ],
  );
  assert.equal(list[3].status, "pass");
  assert.equal(list[2].status, 200);
  assert.equal(list[2].table, "sys_user");
  assert.doesNotMatch(raw(), /secret|name=/);
  assert.equal(instance.seen.length, 1);

  assert.equal(seen.requests, 1);
  assert.equal(seen.cacheHits, 1);
  assert.equal(seen.retries, 0);
  assert.deepEqual(
    seen.checks.map((c) => [c.check, c.requests, c.cacheHits]),
    [
      ["first", 1, 0],
      ["second", 0, 1],
    ],
  );
  assert.ok(seen.ms >= 0);
});

test("a 429 retry counts as a retry and carries its Retry-After", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { "retry-after": "0" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const http = createSnClient({
    instanceUrl: url,
    auth: { kind: "basic", user: "u", pass: "p" },
  });
  const { tracer, events } = capture();
  const timings = collectTimings();
  let seen;
  try {
    await runPreflight({ instanceUrl: url, http }, [
      {
        name: "reader",
        description: "reader",
        async run(ctx) {
          await ctx.http.table("sys_user").query();
          return { name: "reader", status: "pass", message: "ok" };
        },
      },
    ]);
  } finally {
    seen = timings.stop();
    tracer.close();
    server.closeAllConnections();
    server.close();
  }
  const http429 = events().filter((e) => e.type === "http");
  assert.deepEqual(
    http429.map((e) => [e.status, e.attempt, e.cache, e.retryAfterMs]),
    [
      [429, 1, "off", 0],
      [200, 2, "off", undefined],
    ],
  );
  assert.equal(seen.requests, 2);
  assert.equal(seen.retries, 1);
  assert.deepEqual(seen.checks[0], {
    check: "reader",
    ms: seen.checks[0].ms,
    requests: 2,
    retries: 1,
    cacheHits: 0,
  });
});

test("a network failure is traced as an error with no status", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  server.close();
  await once(server, "close");
  const http = createSnClient({
    instanceUrl: url,
    auth: { kind: "basic", user: "u", pass: "p" },
  });
  const { tracer, events } = capture();
  try {
    await assert.rejects(http.table("sys_user").query());
  } finally {
    tracer.close();
  }
  const [event] = events();
  assert.equal(event.error, "network");
  assert.equal(event.status, undefined);
  assert.equal(event.check, undefined);
});

test("formatTimings renders a right-aligned table with a total row", () => {
  const text = formatTimings(
    {
      ms: 1234.4,
      requests: 12,
      retries: 1,
      cacheHits: 3,
      checks: [
        {
          check: "connectivity-auth",
          ms: 80.6,
          requests: 1,
          retries: 0,
          cacheHits: 0,
        },
        { check: "acl", ms: 1100, requests: 11, retries: 1, cacheHits: 3 },
      ],
    },
    "dev",
  );
  assert.equal(
    text,
    [
      "Timings (dev):",
      "check                ms  requests  retries  cache hits",
      "connectivity-auth    81         1        0           0",
      "acl                1100        11        1           3",
      "total              1234        12        1           3",
      "",
    ].join("\n"),
  );
  assert.match(
    formatTimings({ ms: 0, requests: 0, retries: 0, cacheHits: 0, checks: [] }),
    /^Timings:\n/,
  );
});

test("with no subscriber, publishing is a no-op", async () => {
  // Nothing listens here: a run must still work and build no events.
  const report = await runPreflight({}, [
    {
      name: "solo",
      description: "solo",
      async run() {
        return { name: "solo", status: "pass", message: "ok" };
      },
    },
  ]);
  assert.equal(report.ok, true);
  assert.equal(channel(TRACE_CHANNELS.http).hasSubscribers, false);
});
