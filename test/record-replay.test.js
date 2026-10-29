import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSnClient, TRANSPORT_WRAP } from "../build/http/client.js";
import {
  createReplayClient,
  readRecording,
  RecordingError,
} from "../build/api/testing.js";
import { runPreflight } from "../build/index.js";
import { createRecorder } from "../build/fixtures/record.js";
import { replayTransport } from "../build/fixtures/replay.js";
import { looksSecret, createRedactor } from "../build/fixtures/redact.js";

/** A synthetic JWT-shaped token, built at runtime (not a real credential). */
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const JWT = [
  b64({ alg: "HS256" }),
  b64({ sub: "admin" }),
  Buffer.from("signature-signature").toString("base64url"),
].join(".");
const NOW = () => new Date("2026-10-27T00:00:00.000Z");

/** A loopback instance with a few tables full of things to redact. */
async function startInstance() {
  const hits = [];
  let host = "";
  const tables = {
    sys_user: () => [
      {
        sys_id: "u1",
        name: "Alice Admin",
        email: "alice@acme.example",
        user_name: "alice",
        user_password: "hunter2",
      },
      {
        sys_id: "u2",
        name: "Bob Boss",
        email: "bob@acme.example",
        user_name: "bob",
        user_password: "hunter3",
      },
    ],
    sys_properties: () => [
      { sys_id: "p1", name: "x_acme.api.password", value: "p@ss-in-prop" },
      { sys_id: "p2", name: "glide.ui.title", value: "Acme" },
      {
        sys_id: "p3",
        name: "x_acme.endpoint",
        value: `https://${host}/api/x_acme/hook`,
      },
    ],
    sys_script: () => [
      {
        sys_id: "s1",
        script: `var h = { Authorization: "Bearer ${JWT}" }; var other = "Bearer 9f8e7d6c5b4a39281706";`,
      },
    ],
  };
  const server = createServer((req, res) => {
    hits.push(req.url);
    const url = new URL(req.url, "http://x");
    const match = /^\/api\/now\/table\/([^/]+)/.exec(url.pathname);
    const rows = match && tables[match[1]] ? tables[match[1]]() : [];
    res.writeHead(200, {
      "content-type": "application/json",
      "x-total-count": String(rows.length),
      "set-cookie": "JSESSIONID=abc123; Path=/",
    });
    res.end(JSON.stringify({ result: rows }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  host = `127.0.0.1:${server.address().port}`;
  return {
    url: `http://${host}`,
    host,
    hits,
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Checks reading the stub's tables; they report what they saw. */
const CHECKS = [
  {
    name: "users",
    description: "users",
    async run(ctx) {
      const records = await ctx.http.table("sys_user").query({
        sysparm_fields: "sys_id,name,email,user_name",
      });
      return {
        name: "users",
        status: records.length === 2 ? "pass" : "fail",
        message: `${records.length} users`,
      };
    },
  },
  {
    name: "props",
    description: "props",
    async run(ctx) {
      const records = await ctx.http.table("sys_properties").query();
      return {
        name: "props",
        status: records.length === 3 ? "pass" : "fail",
        message: `${records.length} properties`,
      };
    },
  },
  {
    name: "scripts",
    description: "scripts",
    async run(ctx) {
      const records = await ctx.http
        .table("sys_script")
        .query({ sysparm_query: "active=true" });
      return {
        name: "scripts",
        status: "pass",
        message: `${records.length} scripts`,
      };
    },
  },
];

async function record(instance, { raw = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "snpf-rec-"));
  const recorder = createRecorder({
    dir,
    origin: instance.url,
    raw,
    now: NOW,
  });
  const http = createSnClient({
    instanceUrl: instance.url,
    auth: { kind: "basic", user: "rec-user", pass: "rec-pass-XYZ" },
    [TRANSPORT_WRAP]: (inner) => recorder.wrap(inner),
  });
  const report = await runPreflight(
    { instanceUrl: instance.url, http, auth: { user: "rec-user" } },
    CHECKS,
    { concurrency: 1 },
  );
  recorder.finish({ version: "9.9.9", checks: CHECKS.map((c) => c.name) });
  return { dir, report };
}

function files(dir) {
  return readdirSync(dir).map((name) => ({
    name,
    text: readFileSync(join(dir, name), "utf8"),
  }));
}

test("a recorded run replays to the same results without a socket", async () => {
  const instance = await startInstance();
  let recorded;
  try {
    recorded = await record(instance);
  } finally {
    instance.stop();
  }
  const before = instance.hits.length;
  const index = readRecording(recorded.dir);
  assert.equal(index.format, 1);
  assert.equal(index.recordedAt, "2026-10-27T00:00:00.000Z");
  assert.deepEqual(index.checks, ["users", "props", "scripts"]);
  assert.equal(index.raw, false);
  assert.match(index.instanceHostSha256, /^[0-9a-f]{16}$/);

  const report = await runPreflight(
    {
      instanceUrl: "https://instance.invalid",
      http: createReplayClient(recorded.dir),
      replay: { dir: recorded.dir, recordedAt: index.recordedAt },
    },
    CHECKS,
    { concurrency: 1 },
  );
  const strip = (r) =>
    r.results.map(({ name, status, message }) => [name, status, message]);
  assert.deepEqual(strip(report), strip(recorded.report));
  assert.equal(report.ok, true);
  assert.equal(instance.hits.length, before);
});

test("a request that was not recorded fails its check with a re-record hint", async () => {
  const instance = await startInstance();
  let recorded;
  try {
    recorded = await record(instance);
  } finally {
    instance.stop();
  }
  const report = await runPreflight(
    { http: createReplayClient(recorded.dir) },
    [
      {
        name: "new-read",
        description: "new-read",
        async run(ctx) {
          await ctx.http
            .table("sys_user")
            .query({ sysparm_query: "active=false" });
          return { name: "new-read", status: "pass", message: "ok" };
        },
      },
    ],
  );
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, "fail");
  assert.match(
    report.results[0].message,
    /No recorded response for GET \/api\/now\/table\/sys_user\?.*re-record with --record/,
  );
});

test("recordings hold no secrets, no host and no real names", async () => {
  const instance = await startInstance();
  let recorded;
  try {
    recorded = await record(instance);
  } finally {
    instance.stop();
  }
  const all = files(recorded.dir);
  const text = all.map((f) => f.text).join("\n");
  for (const leak of [
    "hunter2",
    "hunter3",
    "p@ss-in-prop",
    JWT,
    "9f8e7d6c5b4a39281706",
    "rec-user",
    "rec-pass-XYZ",
    "alice",
    "Alice Admin",
    "bob@acme.example",
    "JSESSIONID",
    instance.host,
    "127.0.0.1",
  ]) {
    assert.ok(!text.includes(leak), `recording leaks ${leak}`);
  }
  for (const file of all) {
    assert.equal(looksSecret(file.text), false, `${file.name} looks secret`);
  }
  assert.match(text, /https:\/\/instance\.invalid\/api\/x_acme\/hook/);
  assert.match(text, /Acme/);

  const users = all
    .map((f) => JSON.parse(f.text))
    .find((e) => e.key?.path === "/api/now/table/sys_user");
  const [alice, bob] = users.body.result;
  // The fields filter drops what the request did not ask for.
  assert.equal(alice.user_password, undefined);
  assert.equal(alice.name, "user-0001");
  assert.equal(alice.email, "user-0002@example.invalid");
  assert.equal(bob.name, "user-0004");
  assert.equal(users.headers["set-cookie"], undefined);
  assert.equal(users.headers["x-total-count"], "2");

  const index = JSON.parse(
    readFileSync(join(recorded.dir, "index.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(index).sort(), [
    "checks",
    "format",
    "instanceHostSha256",
    "raw",
    "recordedAt",
    "tool",
  ]);
});

test("raw recordings keep names but still strip secrets", async () => {
  const instance = await startInstance();
  let recorded;
  try {
    recorded = await record(instance, { raw: true });
  } finally {
    instance.stop();
  }
  const text = files(recorded.dir)
    .map((f) => f.text)
    .join("\n");
  assert.match(text, /Alice Admin/);
  assert.match(text, /alice@acme\.example/);
  for (const leak of ["hunter2", "p@ss-in-prop", JWT, instance.host]) {
    assert.ok(!text.includes(leak), `raw recording leaks ${leak}`);
  }
  assert.equal(readRecording(recorded.dir).raw, true);
});

test("readRecording and replayTransport reject what is not a recording", () => {
  const empty = mkdtempSync(join(tmpdir(), "snpf-norec-"));
  assert.throws(
    () => readRecording(empty),
    (err) => {
      assert.ok(err instanceof RecordingError);
      assert.match(err.message, /is not a recording.*--record/);
      return true;
    },
  );
  assert.throws(() => replayTransport(empty), RecordingError);
  writeFileSync(join(empty, "index.json"), "{ nope");
  assert.throws(() => readRecording(empty), RecordingError);
  writeFileSync(join(empty, "index.json"), JSON.stringify({ format: 99 }));
  assert.throws(() => readRecording(empty), RecordingError);
});

test("a corrupt recorded response rejects with its file name", async () => {
  const instance = await startInstance();
  let recorded;
  try {
    recorded = await record(instance);
  } finally {
    instance.stop();
  }
  for (const f of files(recorded.dir)) {
    if (f.name !== "index.json") writeFileSync(join(recorded.dir, f.name), "{");
  }
  const http = createReplayClient(recorded.dir);
  await assert.rejects(
    http.table("sys_properties").query(),
    /is not valid JSON/,
  );
});

test("the redactor leaves ordinary prose alone", () => {
  const r = createRedactor({
    origin: "https://dev1.service-now.com",
    raw: false,
  });
  assert.equal(
    r.text("Basic authentication is required"),
    "Basic authentication is required",
  );
  assert.equal(r.text("bypass the cache"), "bypass the cache");
  assert.equal(
    r.text(
      "see https://dev1.service-now.com/nav_to.do and dev1.service-now.com",
    ),
    "see https://instance.invalid/nav_to.do and instance.invalid",
  );
  assert.deepEqual(r.body({ result: [{ token: "abc", label: "ok" }] }, {}), {
    result: [{ token: "<redacted>", label: "ok" }],
  });
});
