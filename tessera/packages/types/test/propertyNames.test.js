// The two §11.2/DR-3 property NAMES, declared once (wave 17).
//
// `@tessera/doctor` and `@tessera/phase05` each used to spell
// `glide.installation.production` (and the doctor, phase05 and the CLI each
// spelt `sn_atf.runner.enabled`) with a "mirrors the other one" comment. The
// doctor's probe resolves differing duplicate rows toward "production" only
// for the EXACT production name, so a copy that drifted would make a consumer
// read a property the probe treats as ordinary. Strings compare by value, so
// the pin is twofold: the values here, and — in each consumer's suite — the
// absence of a local declaration or literal in the built module.

import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ATF_RUNNER_ENABLED_PROPERTY,
  PRODUCTION_PROPERTY,
  SYS_PROPERTIES_TABLE,
} from "../build/index.js";

describe("sys_properties names — one source (wave 17)", () => {
  it("declares the production flag and the ATF runner property", () => {
    assert.equal(PRODUCTION_PROPERTY, "glide.installation.production");
    assert.equal(ATF_RUNNER_ENABLED_PROPERTY, "sn_atf.runner.enabled");
    assert.equal(SYS_PROPERTIES_TABLE, "sys_properties");
  });

  it("spells each name in exactly one built module, beside the table", () => {
    const BUILD = new URL("../build/", import.meta.url);
    for (const name of [PRODUCTION_PROPERTY, ATF_RUNNER_ENABLED_PROPERTY]) {
      const holders = readdirSync(BUILD)
        .filter((file) => file.endsWith(".js"))
        .filter((file) =>
          readFileSync(new URL(file, BUILD), "utf8").includes(`"${name}"`),
        );
      assert.deepEqual(holders, ["readCompleteness.js"], name);
    }
  });
});
