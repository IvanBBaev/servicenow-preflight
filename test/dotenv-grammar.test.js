// CFG-4: the `.env` reader follows the dotenv grammar, and a line it cannot
// read fails loudly (without echoing the value) instead of being skipped or
// silently truncated. Every value here is an obviously fake placeholder.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDotEnv, readDotEnv, UsageError } from "../build/config.js";

const fails = (text, message) =>
  assert.throws(
    () => parseDotEnv(text),
    (err) => err instanceof UsageError && message.test(err.message),
  );

test("CFG-4: a quoted value keeps a # and the escaped quote inside it", () => {
  assert.deepEqual(parseDotEnv('SNPF_PASS="fa#ke pw"\n'), {
    SNPF_PASS: "fa#ke pw",
  });
  assert.deepEqual(parseDotEnv('SNPF_PASS="fa\\"ke"\n'), {
    SNPF_PASS: 'fa"ke',
  });
  assert.deepEqual(parseDotEnv("SNPF_PASS='fa\"ke#1'  # comment\n"), {
    SNPF_PASS: 'fa"ke#1',
  });
});

test("CFG-4: an unquoted value is cut only at a # that follows whitespace", () => {
  assert.deepEqual(parseDotEnv("SNPF_PASS=fa#ke\nSNPF_USER=fake user # c\n"), {
    SNPF_PASS: "fa#ke",
    SNPF_USER: "fake user",
  });
});

test("CFG-4: a double-quoted value spans lines and expands escapes", () => {
  const text = [
    'SNPF_MTLS_KEY="-----BEGIN FAKE BLOCK-----',
    "FAKEFAKEFAKE=",
    '-----END FAKE BLOCK-----"',
    'SNPF_X="a\\nb\\tc"',
    "SNPF_Y='a\\nb'",
    "SNPF_USER=fake",
    "",
  ].join("\n");
  assert.deepEqual(parseDotEnv(text), {
    SNPF_MTLS_KEY:
      "-----BEGIN FAKE BLOCK-----\nFAKEFAKEFAKE=\n-----END FAKE BLOCK-----",
    SNPF_X: "a\nb\tc",
    SNPF_Y: "a\\nb",
    SNPF_USER: "fake",
  });
});

test("CFG-4: export, CRLF, blank values and spaces around = are read", () => {
  assert.deepEqual(
    parseDotEnv("export A=1\r\nB =  x \r\nC=\r\nD=''\r\n# only a comment\r\n"),
    { A: "1", B: "x", C: "", D: "" },
  );
});

test("CFG-4: a malformed line fails with its line number, never its value", () => {
  fails("A=1\nfake-secret-line\n", /^\.env:2: expected KEY=value$/);
  fails('SNPF_PASS="fake-unterminated\n', /\.env:1: unterminated " quote/);
  fails(
    'SNPF_PASS="fa"ke"\n',
    /\.env:1: unexpected text after the closing quote/,
  );
  fails("1BAD=x\n", /\.env:1:/);
  for (const text of [
    'SNPF_PASS="fake-unterminated\n',
    'SNPF_PASS="fa"ke-tail"\n',
    "fake-secret-line\n",
  ]) {
    assert.throws(
      () => parseDotEnv(text),
      (err) => err instanceof UsageError && !/fake-/.test(err.message),
    );
  }
});

test("CFG-4: the error names the file it read", () => {
  fails("bad\n", /^\.env:1:/);
  assert.throws(
    () => parseDotEnv("bad\n", "/x/.env"),
    (err) => err instanceof UsageError && /^\/x\/\.env:1:/.test(err.message),
  );
});

test("CFG-4: readDotEnv ignores a UTF-8 BOM and reports the file path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-dotenv-"));
  try {
    writeFileSync(join(dir, ".env"), "\uFEFFSNPF_USER=fake\n");
    assert.deepEqual(await readDotEnv(dir), { SNPF_USER: "fake" });
    writeFileSync(join(dir, ".env"), "SNPF_USER=fake\nbad\n");
    await assert.rejects(readDotEnv(dir), (err) => {
      assert.ok(err instanceof UsageError);
      assert.match(err.message, /\.env:2: expected KEY=value$/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
