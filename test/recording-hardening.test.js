// RR-61 (CFG-5, CFG-6, CFG-18) + RR-30 (SEC-9): what a recording may hold,
// how it is written, and what replay accepts. Every credential below is an
// obviously fake placeholder.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRecorder } from "../build/fixtures/record.js";
import { replayTransport } from "../build/fixtures/replay.js";
import { keyFile, requestKey } from "../build/fixtures/key.js";
import { createRedactor, looksSecret } from "../build/fixtures/redact.js";

const ORIGIN = "https://acme-dev.service-now.com";
const FAKE = "Fak3Pass99";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "snpf-rr61-"));
}

/** A transport answering `status`/`body` with optional headers. */
const answer =
  (body, { status = 200, statusText = "", headers = {} } = {}) =>
  () =>
    Promise.resolve({
      status,
      statusText,
      headers: { "content-type": "application/json", ...headers },
      text: () => Promise.resolve(JSON.stringify(body)),
    });

test("CFG-5/SEC-9: free-text secrets are redacted, prose is not", () => {
  const r = createRedactor({ origin: ORIGIN });
  const leaks = {
    "URL userinfo": `https://svc_fake:${FAKE}@mid.acme.example/api`,
    "escaped JSON": `var cfg = "{\\"password\\":\\"${FAKE}\\"}";`,
    "spaced quoted": 'var password = "fake horse battery";',
    setBasicAuth: `r.setBasicAuth("svc_fake", "${FAKE}");`,
    backtick: "const token = `fakefake1234567890fake`;",
    "short Basic": "Authorization: Basic dTpwYXNz",
    "lowercase bearer": "authorization: bearer fakefake1234567890fake",
    "api key header": `request.setRequestHeader("x-sn-apikey", "${FAKE}");`,
    "pwd property": `gs.setProperty("glide.fake.pwd", "${FAKE}");`,
    client_secret: `var client_secret = "${FAKE}";`,
    camelCase: `var userPassword = "${FAKE}";`,
    "member camelCase": `this.dbPassword='${FAKE}';`,
    "query apikey": `GET /x?apikey=${FAKE}&limit=1`,
    "unquoted assign": `password=${FAKE}&user=x`,
    setter: `cfg.setPassword("${FAKE}");`,
  };
  for (const [name, input] of Object.entries(leaks)) {
    const out = r.text(input);
    assert.match(out, /<redacted>/, name);
    assert.doesNotMatch(out, /Fak3Pass99|fake horse|fakefake|dTpwYXNz/, name);
    assert.equal(
      looksSecret(out),
      false,
      `${name} reads clean after redaction`,
    );
    assert.equal(looksSecret(input), true, `${name} reads as a secret`);
  }
  for (const prose of [
    "Basic authentication is required",
    "bypass the cache",
    "Password reset is self-service",
    "The token endpoint is /oauth_token.do",
  ]) {
    assert.equal(r.text(prose), prose, prose);
  }
});

test("CFG-5: secret-looking field names are redacted in a body", () => {
  const r = createRedactor({ origin: ORIGIN });
  const out = r.body(
    {
      result: [
        {
          u_pwd: FAKE,
          u_pin: "4711",
          cookie: "JSESSIONID=FAKE",
          session_id: "FAKEsess",
          u_password_num: 12345678,
          password2: { display_value: FAKE, value: "enc" },
          short_description: "keep me",
        },
      ],
    },
    { table: "incident" },
  );
  const row = out.result[0];
  for (const field of [
    "u_pwd",
    "u_pin",
    "cookie",
    "session_id",
    "u_password_num",
  ]) {
    assert.equal(row[field], "<redacted>", field);
  }
  assert.deepEqual(row.password2, {
    display_value: "<redacted>",
    value: "<redacted>",
  });
  assert.equal(row.short_description, "keep me");
  const props = r.body(
    {
      result: [
        { name: "glide.smtp.pwd", value: FAKE },
        { name: "x.basic.auth.pass", value: FAKE },
        { name: "x.encryption.key", value: FAKE },
        { name: "glide.ui.title", value: "Fake Title" },
      ],
    },
    { table: "sys_properties" },
  );
  assert.deepEqual(
    props.result.map((p) => p.value),
    ["<redacted>", "<redacted>", "<redacted>", "Fake Title"],
  );
});

test("CFG-5: the request key and link header carry pseudonyms, not people", async () => {
  const dir = join(tempDir(), "rec");
  try {
    const rec = createRecorder({ dir, origin: ORIGIN });
    const url =
      `${ORIGIN}/api/now/table/sys_user` +
      "?sysparm_query=email%3Dfake.person%40acme.example%5Euser_name%3Dfake.person" +
      `&sysparm_fields=sys_id&api_key=${FAKE}`;
    await rec.wrap(
      answer(
        { result: [{ sys_id: "a".repeat(32) }] },
        {
          headers: {
            Link: `<${ORIGIN}/api/now/table/sys_user?sysparm_query=user_name%3Dfake.person&sysparm_offset=10>;rel="next"`,
          },
        },
      ),
    )(url, { method: "GET" });
    rec.finish({ version: "0", checks: [] });
    const [file] = readdirSync(dir).filter((f) => f !== "index.json");
    const text = readFileSync(join(dir, file), "utf8");
    assert.doesNotMatch(text, /fake\.person|acme\.example|acme-dev|Fak3Pass99/);
    const entry = JSON.parse(text);
    assert.equal(entry.key.query.api_key, "<redacted>");
    assert.match(
      entry.key.query.sysparm_query,
      /email=user-\d{4}@example\.invalid/,
    );
    assert.match(entry.key.query.sysparm_query, /user_name=user-\d{4}/);
    assert.match(entry.headers.link, /user_name%3Duser-\d{4}/);
    assert.match(entry.headers.link, /^<https:\/\/instance\.invalid\//);
    // Replay still finds the exchange by the live (unredacted) request.
    const res = await replayTransport(dir)(
      url.replace(ORIGIN, "https://instance.invalid"),
      {
        method: "GET",
      },
    );
    assert.equal(res.status, 200);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

test("SEC-9: the recorder refuses to write a file that still looks secret", async () => {
  const dir = join(tempDir(), "rec");
  try {
    const rec = createRecorder({ dir, origin: ORIGIN });
    await assert.rejects(
      rec.wrap(
        answer({ result: [] }, { status: 400, statusText: `password=${FAKE}` }),
      )(`${ORIGIN}/api/now/table/incident`, { method: "GET" }),
      /Refusing to write .*still looks like it holds a secret/,
    );
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

test(
  "CFG-6: a recording is 0700 / 0600",
  { skip: process.platform === "win32" && "POSIX modes" },
  async () => {
    const root = tempDir();
    const dir = join(root, "rec");
    try {
      const rec = createRecorder({ dir, origin: ORIGIN });
      await rec.wrap(answer({ result: [] }))(
        `${ORIGIN}/api/now/table/incident`,
        {
          method: "GET",
        },
      );
      rec.finish({ version: "0", checks: [] });
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      const files = readdirSync(dir);
      assert.equal(files.length, 2);
      for (const f of files) {
        assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("CFG-6: a re-record clears the old exchanges and keeps other files", async () => {
  const root = tempDir();
  const dir = join(root, "rec");
  try {
    const first = createRecorder({ dir, origin: ORIGIN });
    const stale = `${ORIGIN}/api/now/table/old_table?x=1`;
    await first.wrap(answer({ result: [{ stale: "yes" }] }))(stale, {
      method: "GET",
    });
    first.finish({ version: "0", checks: [] });
    writeFileSync(join(dir, "README.md"), "kept\n");
    writeFileSync(join(dir, "notes.json"), "{}\n");

    const second = createRecorder({ dir, origin: ORIGIN });
    second.finish({ version: "0", checks: [] });
    assert.deepEqual(readdirSync(dir).sort(), [
      "README.md",
      "index.json",
      "notes.json",
    ]);
    await assert.rejects(
      replayTransport(dir)(
        "https://instance.invalid/api/now/table/old_table?x=1",
        {
          method: "GET",
        },
      ),
      /No recorded response/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CFG-18: a malformed escape in the table segment is recorded, not a URIError", async () => {
  const root = tempDir();
  const dir = join(root, "rec");
  try {
    const rec = createRecorder({ dir, origin: ORIGIN });
    const res = await rec.wrap(answer({ result: [] }))(
      `${ORIGIN}/api/now/table/%E0%A4%A/1`,
      { method: "GET" },
    );
    assert.equal(res.status, 200);
    assert.equal(readdirSync(dir).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CFG-18: a __proto__ query parameter is part of the key", () => {
  const plain = requestKey("GET", "https://h/api/x?a=1");
  const proto = requestKey("GET", "https://h/api/x?a=1&__proto__=evil");
  assert.equal(Object.hasOwn(proto.query, "__proto__"), true);
  assert.equal(proto.query.__proto__, "evil");
  assert.notEqual(keyFile(plain), keyFile(proto));
  // An ordinary key hashes as before, so existing recordings still match.
  assert.equal(JSON.stringify(plain.query), '{"a":"1"}');
});

test("CFG-18: replay rejects an entry that is not a valid exchange", async () => {
  const root = tempDir();
  const dir = join(root, "rec");
  try {
    const rec = createRecorder({ dir, origin: ORIGIN });
    rec.finish({ version: "0", checks: [] });
    const replay = replayTransport(dir);
    const url = "https://instance.invalid/api/now/table/zzz";
    const file = join(dir, keyFile(requestKey("GET", url)));
    const bad = [
      [[], /not an object/],
      [{ key: { method: "GET" } }, /status is not an HTTP status code/],
      [{ status: 99 }, /status is not an HTTP status code/],
      [{ status: 200.5 }, /status is not an HTTP status code/],
      [{ status: 200, statusText: 1 }, /statusText is not a string/],
      [{ status: 200, headers: [] }, /headers is not an object/],
      [{ status: 200, headers: { a: 1 } }, /a header value is not a string/],
      [{ status: 200, text: {} }, /text is not a string/],
      [{ status: 200, key: { method: "POST" } }, /recorded for POST/],
    ];
    for (const [entry, message] of bad) {
      writeFileSync(file, JSON.stringify(entry));
      await assert.rejects(replay(url, { method: "GET" }), message);
    }
    writeFileSync(
      file,
      JSON.stringify({ status: 204, key: { method: "GET" } }),
    );
    const res = await replay(url, { method: "GET" });
    assert.equal(res.status, 204);
    assert.equal(existsSync(file), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
