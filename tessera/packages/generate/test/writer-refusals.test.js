// DEV-4 — the writer's refusals that `writer.test.js` does not reach.
//
// That suite pins the envelope's main claims. These are the edges under them:
// a target field the manifest would carry verbatim, a pre-existing tree that is
// shaped wrong one level down, a filesystem that will not let the pre-check
// look, and the one fault that arrives AFTER the new batch is already in place.
// Each refusal is checked on disk as well as by message, for the same reason
// the main suite gives: a writer that refused and wrote anyway would pass a
// message-only assertion.
//
// The mode-bit tests skip under root, which ignores the bits they rely on.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { untrusted } from "@tessera/types";

import {
  PROPOSED_DIRNAME,
  PROPOSED_MANIFEST_FILENAME,
  inspectGeneratedSource,
  writeProposedSpecs,
} from "../build/index.js";

// ── fixtures (the minimal subset of writer.test.js) ─────────────────────────

const roots = [];
/** Directories a test locked; reopened before the sandbox is removed. */
const locked = [];

after(async () => {
  for (const dir of locked) await chmod(dir, 0o755).catch(() => undefined);
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

const isRoot = process.getuid?.() === 0;

async function sandbox() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "tessera-writer-ref-"));
  roots.push(parent);
  const testsRoot = path.join(parent, "tests");
  await mkdir(testsRoot);
  return { parent, testsRoot };
}

const SOURCE = [
  "// PROPOSED spec — generated, not armed.",
  "export function run(step) {",
  "  var record = step.getRecord();",
  '  assertNotEqual("the target record was not loaded", null, record);',
  "}",
  "",
].join("\n");

const PROVENANCE = {
  runId: "run-2026-08-21-000042",
  generator: "template",
  modelId: "template://tessera-generate/1",
  promptHash: "e".repeat(64),
  promptVersion: "generate/1",
};

const TARGET = {
  table: "incident",
  sysId: "0123456789abcdef0123456789abcdef",
  // AIS-4: the parser hands the writer a branded name; a bare string is refused.
  name: untrusted("Incident business rule"),
};

function proposed(overrides = {}) {
  const branded = untrusted(overrides.source ?? SOURCE);
  const verdict = inspectGeneratedSource(branded);
  assert.ok(verdict.ok, "fixture source did not clear the gate");
  return {
    candidate: {
      id: overrides.id ?? "incident.unit.1",
      kind: "unit",
      filename: overrides.filename ?? "incident.unit.ts",
      targets: "targets" in overrides ? overrides.targets : [TARGET],
      source: branded,
    },
    cleared: verdict.cleared,
  };
}

function write(testsRoot, specs) {
  return writeProposedSpecs({ testsRoot, specs, provenance: PROVENANCE });
}

async function tree(dir, prefix = "") {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...(await tree(path.join(dir, entry.name), relative)));
    } else {
      found.push(relative);
    }
  }
  return found.sort();
}

async function refusal(promise, name, expected) {
  let caught;
  await assert.rejects(promise, (error) => {
    caught = error;
    return true;
  });
  assert.equal(caught.name, name, `${caught.name}: ${caught.message}`);
  assert.match(caught.message, expected);
  return caught;
}

/** Seed a previous batch, so every refusal can be checked against it. */
async function seedPrevious(testsRoot, filename = "kept.unit.ts") {
  await write(testsRoot, [
    proposed({ id: "kept", filename, source: "// old\n" }),
  ]);
  return readFile(path.join(testsRoot, PROPOSED_MANIFEST_FILENAME), "utf8");
}

async function assertPreviousKept(testsRoot, manifest, files) {
  assert.deepEqual(await tree(testsRoot), [
    PROPOSED_MANIFEST_FILENAME,
    ...files.map((file) => `${PROPOSED_DIRNAME}/${file}`),
  ]);
  assert.equal(
    await readFile(path.join(testsRoot, PROPOSED_MANIFEST_FILENAME), "utf8"),
    manifest,
  );
}

// ── the target triples the manifest carries verbatim ────────────────────────

describe("a target field is bounded before it reaches the manifest (W7b L3)", () => {
  const unsafe = [
    ["a bidi override in the table", { table: "inci\u202edent" }],
    ["an escape in the name", { name: "Rule\u001b[2J" }],
    ["a zero-width space in the sys_id", { sysId: "0123\u200b4567" }],
    ["an over-long sys_id", { sysId: "a".repeat(65) }],
    ["an over-long table", { table: "t".repeat(81) }],
    ["an over-long name", { name: "n".repeat(257) }],
  ];

  for (const [label, override] of unsafe) {
    it(`refuses ${label}, writing nothing`, async () => {
      const { testsRoot } = await sandbox();
      const error = await refusal(
        write(testsRoot, [
          proposed({
            targets: [
              {
                ...TARGET,
                ...override,
                ...("name" in override
                  ? { name: untrusted(override.name) }
                  : {}),
              },
            ],
          }),
        ]),
        "GenerateInputError",
        /has a target whose table, sys_id or name holds a control, bidi or zero-width character, is longer than its cap/,
      );
      // The refused value is model output; the message does not repeat it.
      for (const value of Object.values(override)) {
        if (typeof value === "string") {
          assert.equal(error.message.includes(value), false, label);
        }
      }
      assert.deepEqual(await tree(testsRoot), []);
    });
  }

  it("names the caps it enforces, so a refused caller can tell which one", async () => {
    const { testsRoot } = await sandbox();
    await refusal(
      write(testsRoot, [
        proposed({ targets: [{ ...TARGET, name: untrusted("\u0007") }] }),
      ]),
      "GenerateInputError",
      /\(\d+\/\d+\/\d+ chars\)/,
    );
  });

  it("refuses a target whose name is not branded untrusted text (AIS-4), writing nothing", async () => {
    // Fail closed: a name that did not come through the parser is not trusted
    // as plain text. A bare string and a hand-rolled `{ value }` look-alike are
    // both refused — the door checks provenance, not shape.
    const { testsRoot } = await sandbox();
    for (const name of [
      "Incident business rule",
      { value: "Incident business rule" },
      undefined,
    ]) {
      await refusal(
        write(testsRoot, [proposed({ targets: [{ ...TARGET, name }] })]),
        "GenerateInputError",
        /or whose name is not branded untrusted text/,
      );
    }
    assert.deepEqual(await tree(testsRoot), []);
  });

  it("refuses targets that are not a list at all", async () => {
    const { testsRoot } = await sandbox();
    for (const targets of ["incident", { 0: TARGET, length: 1 }, null]) {
      await refusal(
        write(testsRoot, [proposed({ targets })]),
        "GenerateInputError",
        /or its targets are not a list/,
      );
    }
    assert.deepEqual(await tree(testsRoot), []);
  });

  it("still accepts an empty target list", async () => {
    const { testsRoot } = await sandbox();
    const report = await write(testsRoot, [proposed({ targets: [] })]);
    assert.equal(report.written.length, 1);
  });
});

// ── the pre-check, before anything is created ───────────────────────────────

describe("the pre-check refuses a tree it cannot walk, leaving it as found", () => {
  it("refuses a FILE where the batch needs a directory", async () => {
    const { testsRoot } = await sandbox();
    const manifest = await seedPrevious(testsRoot);
    await writeFile(path.join(testsRoot, PROPOSED_DIRNAME, "domain"), "x");

    await refusal(
      write(testsRoot, [
        proposed({ id: "nested", filename: "domain/incident.unit.ts" }),
      ]),
      "GenerationFaultError",
      /domain exists and is not a directory; refusing to write beneath it/,
    );
    await assertPreviousKept(testsRoot, manifest, ["domain", "kept.unit.ts"]);
  });

  it("refuses when a target cannot be examined, instead of assuming it is absent", async (t) => {
    if (isRoot) return t.skip("root ignores mode bits");
    const { testsRoot } = await sandbox();
    const manifest = await seedPrevious(testsRoot);
    const proposedDir = path.join(testsRoot, PROPOSED_DIRNAME);
    // No search permission: `lstat` of anything inside fails with EACCES,
    // which is not ENOENT and must not be read as "nothing there yet".
    await chmod(proposedDir, 0o000);
    locked.push(proposedDir);
    try {
      const error = await refusal(
        write(testsRoot, [proposed()]),
        "GenerationFaultError",
        /incident\.unit\.ts could not be examined before writing: /,
      );
      assert.equal(error.cause?.code, "EACCES");
    } finally {
      await chmod(proposedDir, 0o755);
    }
    await assertPreviousKept(testsRoot, manifest, ["kept.unit.ts"]);
  });

  it("refuses when a directory on the way cannot be examined", async (t) => {
    if (isRoot) return t.skip("root ignores mode bits");
    const { testsRoot } = await sandbox();
    const manifest = await seedPrevious(testsRoot, "domain/kept.unit.ts");
    const domain = path.join(testsRoot, PROPOSED_DIRNAME, "domain");
    await chmod(domain, 0o000);
    locked.push(domain);
    try {
      const error = await refusal(
        write(testsRoot, [
          proposed({ id: "deep", filename: "domain/deeper/incident.unit.ts" }),
        ]),
        "GenerationFaultError",
        /deeper could not be examined: /,
      );
      assert.equal(error.cause?.code, "EACCES");
      assert.doesNotMatch(error.message, /before writing/);
    } finally {
      await chmod(domain, 0o755);
    }
    await assertPreviousKept(testsRoot, manifest, ["domain/kept.unit.ts"]);
  });
});

// ── after the swap ──────────────────────────────────────────────────────────

describe("a previous batch that cannot be removed after the swap", () => {
  it("is reported, not swallowed — the new batch stays installed", async (t) => {
    if (isRoot) return t.skip("root ignores mode bits");
    const { testsRoot } = await sandbox();
    await seedPrevious(testsRoot, "old/kept.unit.ts");
    // A read-only directory inside the PREVIOUS batch: it moves with the
    // retired tree (a rename needs nothing from it), but its file cannot be
    // unlinked, so removing the retired tree fails after the swap succeeded.
    const old = path.join(testsRoot, PROPOSED_DIRNAME, "old");
    await chmod(old, 0o555);

    let retiredOld;
    try {
      const error = await refusal(
        write(testsRoot, [proposed({ id: "new", filename: "new.unit.ts" })]),
        "GenerationFaultError",
        /the new batch was written to .*, but the previous one could not be removed from .*; delete it by hand/,
      );
      const retired = error.message.match(/removed from (\S+): /)?.[1];
      assert.ok(retired, "the message names the leftover directory");
      assert.equal(path.dirname(retired), testsRoot);
      retiredOld = path.join(retired, PROPOSED_DIRNAME, "old");
      locked.push(retiredOld);

      // The new batch is the one in place, and its manifest describes it.
      const manifest = JSON.parse(
        await readFile(
          path.join(testsRoot, PROPOSED_MANIFEST_FILENAME),
          "utf8",
        ),
      );
      assert.deepEqual(
        manifest.specs.map((entry) => entry.id),
        ["new"],
      );
      assert.deepEqual(await tree(path.join(testsRoot, PROPOSED_DIRNAME)), [
        "new.unit.ts",
      ]);
      // The leftover is the previous batch, intact, where the message says.
      assert.equal(
        await readFile(path.join(retiredOld, "kept.unit.ts"), "utf8"),
        "// old\n",
      );
    } finally {
      if (retiredOld !== undefined) await chmod(retiredOld, 0o755);
    }
  });
});
