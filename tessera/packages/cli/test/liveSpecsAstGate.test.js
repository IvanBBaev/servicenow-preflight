// PA-10 (2): `loadLiveSpecs` holds every repo `unit` body to BOTH TM-3 layers.
//
// Before PA-10 a live spec body was held to the lexical deny-list only, so a
// body that spelled nothing on the list — an undenied write method, a
// homoglyph, an alias — was projected into an ATF step. These cases pin that a
// body the lexical layer alone clears is now refused by the AST allowlist, that
// the spec's declared Script Include targets are the only constructible
// classes, and that the bodies the live fixtures use still load. Strings and a
// temp directory only; nothing runs against an instance.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAX_TARGET_CLASS_NAMES,
  inspectGeneratedSource,
} from "@tessera/generate";
import { S5_GENERATED_TEST_SCRIPT, S5_TARGET_NAME } from "@tessera/phase05";
import { untrusted } from "@tessera/types";

import {
  formatRejectedSpecs,
  loadLiveSpecs,
  specBodySha256,
} from "../build/index.js";

/** A review record for `body` (PA-10 fix 3): what `tess review` would stamp. */
const reviewOf = (body) => ({
  bodySha256: specBodySha256(body),
  reviewer: "test-reviewer",
});

const tempRoots = [];
after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const hex = (prefix) => prefix.padEnd(32, "0");

async function root(body, targets) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-ast-"));
  tempRoots.push(base);
  const testsRoot = path.join(base, "tests");
  await fs.mkdir(testsRoot, { recursive: true });
  await fs.writeFile(path.join(testsRoot, "u.unit.ts"), body);
  await fs.writeFile(
    path.join(testsRoot, ".manifest.json"),
    JSON.stringify({
      version: 1,
      specs: [
        {
          id: "U",
          path: "u.unit.ts",
          kind: "unit",
          targets,
          review: reviewOf(body),
        },
      ],
    }),
  );
  return testsRoot;
}

const include = (name) => ({
  table: "sys_script_include",
  sysId: hex("a11ce"),
  name,
});

const GOOD_BODY = `(function (outputs, steps, params, stepResult, assertEqual) {
  var d = new LiveDiscount();
  assertEqual({ name: "below threshold pays full price", shouldbe: 990, value: d.apply(99, 10) });
})(outputs, steps, params, stepResult, assertEqual);
`;

describe("loadLiveSpecs requires the AST layer (PA-10)", () => {
  it("the live fixture body still loads with its target declared", async () => {
    const load = await loadLiveSpecs(
      await root(GOOD_BODY, [include("LiveDiscount")]),
    );
    assert.equal(load.kind, "loaded");
    assert.equal(load.specs[0].payload.script, GOOD_BODY);
  });

  it("the S5 generated script loads with its target declared", async () => {
    const load = await loadLiveSpecs(
      await root(S5_GENERATED_TEST_SCRIPT, [include(S5_TARGET_NAME)]),
    );
    assert.equal(load.kind, "loaded");
  });

  it("a target that is not a Script Include is not constructible", async () => {
    const load = await loadLiveSpecs(
      await root(GOOD_BODY, [
        { table: "sys_script", sysId: hex("b"), name: "LiveDiscount" },
      ]),
    );
    assert.equal(load.kind, "rejected");
    assert.ok(
      load.rejected[0].violations.some(
        (violation) => violation.rule === "ast-new-outside-allowlist",
      ),
    );
  });

  it("a malformed declared target name refuses the spec (PA-10)", async () => {
    const load = await loadLiveSpecs(
      await root(GOOD_BODY, [
        include("LiveDiscount"),
        include("Live-Discount; gs.log"),
      ]),
    );
    assert.equal(load.kind, "rejected");
    const lines = formatRejectedSpecs(load.rejected);
    assert.ok(
      lines.some((line) =>
        /outside-allowlist\/ast-target-name-invalid/.test(line),
      ),
    );
    assert.ok(lines.every((line) => !line.includes("Live-Discount")));
  });

  it("more than MAX_TARGET_CLASS_NAMES declared targets refuses the spec", async () => {
    const targets = Array.from(
      { length: MAX_TARGET_CLASS_NAMES + 1 },
      (_, index) => include(`LiveDiscount${index}`),
    );
    const load = await loadLiveSpecs(await root(GOOD_BODY, targets));
    assert.equal(load.kind, "rejected");
    assert.ok(
      load.rejected[0].violations.some(
        (violation) => violation.rule === "ast-too-many-targets",
      ),
    );
  });

  for (const [label, body] of [
    [
      "an undenied write-like method",
      "var gr = new GlideRecord('incident'); gr.applyEncodedQuery('x');\n",
    ],
    [
      "a homoglyph method name",
      "var gr = new GlideRecord('incident'); gr.dеleteRecord();\n",
    ],
    [
      "a Script Include reached by name",
      "var s = new OtherInclude(); s.run();\n",
    ],
  ]) {
    it(`refuses ${label} that the lexical layer alone clears`, async () => {
      assert.equal(inspectGeneratedSource(untrusted(body)).ok, true);
      const load = await loadLiveSpecs(
        await root(body, [include("LiveDiscount")]),
      );
      assert.equal(load.kind, "rejected");
      const lines = formatRejectedSpecs(load.rejected);
      assert.ok(lines.some((line) => /outside-allowlist\/ast-/.test(line)));
      // Rule names and constant text only — never the body.
      assert.ok(lines.every((line) => !line.includes("OtherInclude")));
      assert.ok(lines.every((line) => !line.includes("applyEncodedQuery")));
    });
  }
});
