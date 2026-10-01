// W2 update-set asset validator — positive on the committed asset, negative
// on mutated copies (ADR-007, C5/C6; delegated decision 2026-09-23).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, test } from "node:test";

import {
  AUTHORING_CHANNEL_UPDATE_SET_URL,
  AUTHORING_CHANNEL_VERSION,
  validateAuthoringChannelUpdateSet,
} from "../build/index.js";

const ASSET = fs.readFileSync(AUTHORING_CHANNEL_UPDATE_SET_URL, "utf8");

const GRANT_ENTRY = `<sys_update_xml action="INSERT_OR_UPDATE">
<name>sys_user_has_role_7e55e0a0c0de4a5ea000000000000099</name>
<payload><![CDATA[<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_user_has_role"><sys_user_has_role action="INSERT_OR_UPDATE"><role>7e55e0a0c0de4a5ea000000000000010</role><user>6816f79cc0a8016401c5a33be04be441</user><sys_id>7e55e0a0c0de4a5ea000000000000099</sys_id></sys_user_has_role></record_update>]]></payload>
<remote_update_set display_value="Tessera authoring channel 1.0.0">7e55e0a0c0de4a5ea000000000000001</remote_update_set>
</sys_update_xml>
`;

const insertBeforeUnloadEnd = (xml, fragment) =>
  xml.replace("</unload>", `${fragment}</unload>`);

function expectProblem(xml, pattern) {
  const verdict = validateAuthoringChannelUpdateSet(xml);
  assert.equal(verdict.ok, false, "mutated copy must fail");
  assert.ok(
    verdict.problems.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}, got:\n${verdict.problems.join("\n")}`,
  );
}

describe("the committed authoring-channel update set", () => {
  test("validates clean", () => {
    const verdict = validateAuthoringChannelUpdateSet(ASSET);
    assert.deepEqual(verdict.problems, []);
    assert.equal(verdict.ok, true);
  });

  test("carries exactly the expected record types", () => {
    const { records } = validateAuthoringChannelUpdateSet(ASSET);
    const tally = {};
    for (const r of records) tally[r.table] = (tally[r.table] ?? 0) + 1;
    assert.deepEqual(tally, {
      sys_user_role: 1,
      sys_security_acl: 3,
      sys_security_acl_role: 3,
      sys_properties: 1,
    });
  });

  test("ships the version row the store expects, and ACLs for create/write/delete", () => {
    const { records } = validateAuthoringChannelUpdateSet(ASSET);
    const property = records.find((r) => r.table === "sys_properties");
    assert.equal(property.fields.name, "x_tessera.channel.version");
    assert.equal(property.fields.value, AUTHORING_CHANNEL_VERSION);
    const acls = records.filter((r) => r.table === "sys_security_acl");
    assert.deepEqual(acls.map((a) => a.fields.operation).sort(), [
      "create",
      "delete",
      "write",
    ]);
    for (const acl of acls) {
      assert.equal(acl.fields.name, "sys_variable_value");
      assert.equal(acl.fields.advanced, "false");
      assert.equal(acl.fields.script, "");
    }
  });

  test("contains no role grant anywhere (C6)", () => {
    assert.equal(ASSET.includes("sys_user_has_role"), false);
  });
});

describe("mutated copies fail", () => {
  test("an injected sys_user_has_role grant (C6)", () => {
    expectProblem(
      insertBeforeUnloadEnd(ASSET, GRANT_ENTRY),
      /sys_user_has_role.*C6/,
    );
    expectProblem(
      insertBeforeUnloadEnd(ASSET, GRANT_ENTRY),
      /unexpected record type sys_user_has_role/,
    );
  });

  test("a grant hidden in a comment is still refused", () => {
    expectProblem(
      ASSET.replace("<unload ", "<!-- sys_user_has_role --><unload "),
      /sys_user_has_role/,
    );
  });

  test("a missing version row", () => {
    const mutated = ASSET.replace(
      /<sys_update_xml action="INSERT_OR_UPDATE">(?:(?!<\/sys_update_xml>)[\s\S])*record_update table="sys_properties"[\s\S]*?<\/sys_update_xml>\n/,
      "",
    );
    assert.notEqual(mutated, ASSET);
    expectProblem(mutated, /exactly one sys_properties row/);
  });

  test("a version row with a different major", () => {
    expectProblem(
      ASSET.replace("<value>1.0.0</value>", "<value>2.0.0</value>"),
      /requires major 1/,
    );
  });

  test("a scripted ACL (zero code)", () => {
    expectProblem(
      ASSET.replace(
        "<advanced>false</advanced>",
        "<advanced>true</advanced>",
      ).replace("<script/>", "<script>answer = true;</script>"),
      /carries a script/,
    );
  });

  test("an unconditioned ACL", () => {
    expectProblem(
      ASSET.replace(
        "<condition>document=sys_atf_step^EQ</condition>",
        "<condition/>",
      ),
      /not conditioned on document=sys_atf_step/,
    );
  });

  // Fix 2026-09-26 (F3): the condition must be EXACTLY document=sys_atf_step
  // (optionally ^EQ); an appended OR / new-query term widens the ACL to rows
  // that are not ATF step inputs.
  test("the shipped conditions are exactly document=sys_atf_step^EQ", () => {
    const { records } = validateAuthoringChannelUpdateSet(ASSET);
    const conditions = records
      .filter((r) => r.table === "sys_security_acl")
      .map((r) => r.fields.condition);
    assert.deepEqual(conditions, Array(3).fill("document=sys_atf_step^EQ"));
  });

  for (const widening of [
    "^NQsys_idISNOTEMPTY",
    "^ORsys_idISNOTEMPTY",
    "^ORdocument!=sys_atf_step",
    "^NQdocument!=sys_atf_step",
  ]) {
    test(`a condition widened with ${JSON.stringify(widening)}`, () => {
      for (const condition of [
        `document=sys_atf_step^EQ${widening}`,
        `document=sys_atf_step${widening}`,
        `document=sys_atf_step${widening}^EQ`,
      ]) {
        expectProblem(
          ASSET.replaceAll(
            "<condition>document=sys_atf_step^EQ</condition>",
            `<condition>${condition}</condition>`,
          ),
          /not conditioned on document=sys_atf_step/,
        );
      }
    });
  }

  test("a condition with a leading widening term", () => {
    expectProblem(
      ASSET.replaceAll(
        "<condition>document=sys_atf_step^EQ</condition>",
        "<condition>sys_idISNOTEMPTY^ORdocument=sys_atf_step^EQ</condition>",
      ),
      /not conditioned on document=sys_atf_step/,
    );
  });

  test("a bare document=sys_atf_step condition (no ^EQ) is accepted", () => {
    const verdict = validateAuthoringChannelUpdateSet(
      ASSET.replaceAll(
        "<condition>document=sys_atf_step^EQ</condition>",
        "<condition>document=sys_atf_step</condition>",
      ),
    );
    assert.deepEqual(verdict.problems, []);
  });

  test("a Scripted REST resource (C5)", () => {
    const rest = `<sys_update_xml action="INSERT_OR_UPDATE">
<payload><![CDATA[<record_update table="sys_ws_operation"><sys_ws_operation action="INSERT_OR_UPDATE"><name>author</name><operation_script>gs.info(1)</operation_script></sys_ws_operation></record_update>]]></payload>
<remote_update_set>7e55e0a0c0de4a5ea000000000000001</remote_update_set>
</sys_update_xml>
`;
    expectProblem(
      insertBeforeUnloadEnd(ASSET, rest),
      /unexpected record type sys_ws_operation/,
    );
  });

  test("an ACL whose role binding is removed", () => {
    expectProblem(
      ASSET.replace(
        /<sys_security_acl_role action="INSERT_OR_UPDATE">[\s\S]*?<\/sys_security_acl_role>/,
        "",
      ),
      /must be bound to x_tessera.author/,
    );
  });

  test("not an update-set export at all", () => {
    expectProblem("<xml/>", /not an update-set export/);
  });
});
