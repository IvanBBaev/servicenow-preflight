import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeAtomic } from "../build/atomic-write.js";

/** Make a fresh temp dir; caller removes it. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), "snpf-atomic-"));
}

test("writeAtomic never writes through a symlink planted at a guessable temp path (CFG-2)", () => {
  const dir = tempDir();
  try {
    const target = join(dir, "out.json");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "untouched\n");
    // The old implementation wrote to `${path}.${pid}.tmp`.
    const planted = `${target}.${process.pid}.tmp`;
    symlinkSync(victim, planted);
    writeAtomic(target, "new\n");
    assert.equal(readFileSync(target, "utf8"), "new\n");
    assert.equal(readFileSync(victim, "utf8"), "untouched\n");
    assert.ok(lstatSync(planted).isSymbolicLink(), "the planted link stays");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAtomic keeps an existing file's permission bits (CFG-7)", () => {
  const dir = tempDir();
  try {
    const target = join(dir, "secret.json");
    writeFileSync(target, "old\n");
    chmodSync(target, 0o600);
    writeAtomic(target, "new\n");
    assert.equal(readFileSync(target, "utf8"), "new\n");
    assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAtomic replaces a symlink at the target and leaves its victim alone (CFG-2)", () => {
  const dir = tempDir();
  try {
    const target = join(dir, "out.json");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "untouched\n");
    chmodSync(victim, 0o644);
    symlinkSync(victim, target);
    writeAtomic(target, "new\n");
    assert.ok(lstatSync(target).isFile());
    assert.equal(readFileSync(target, "utf8"), "new\n");
    assert.equal(readFileSync(victim, "utf8"), "untouched\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAtomic leaves no temp file behind and creates parent dirs", () => {
  const dir = tempDir();
  try {
    const target = join(dir, "a", "b", "out.json");
    writeAtomic(target, "one\n");
    writeAtomic(target, "two\n");
    assert.equal(readFileSync(target, "utf8"), "two\n");
    assert.deepEqual(readdirSync(join(dir, "a", "b")), ["out.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
