// The process boundary: `defaultContext()` is the only function that samples
// the real process, so it is exercised in a child with a controlled env rather
// than by mutating this process's `process.env`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  defaultContext,
  describe as describeValue,
  instanceFromEnv,
} from "../build/index.js";

const INDEX = fileURLToPath(new URL("../build/index.js", import.meta.url));

/** Run `defaultContext()` in a child whose env is exactly `env`. */
function sampleChild(env) {
  const script = `
    const { defaultContext } = await import(${JSON.stringify(INDEX)});
    const c = defaultContext();
    c.stdout("out-line");
    process.stdout.write(JSON.stringify({
      actor: c.actor,
      hasInstance: "instance" in c,
      instance: c.instance,
      cwd: c.cwd,
      envMarker: c.env.MARKER,
      now: c.now() instanceof Date,
    }));
  `;
  const PATH = process.env["PATH"];
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: { PATH, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const [line, json] = out.split("\n");
  assert.equal(line, "out-line");
  return JSON.parse(json);
}

describe("describe(value) — never [object Object]", () => {
  it("uses an Error's message and passes a string through", () => {
    assert.equal(describeValue(new TypeError("boom")), "boom");
    assert.equal(describeValue("plain"), "plain");
  });

  it("JSON-renders anything else, falling back for the unprintable", () => {
    assert.equal(describeValue({ code: 7 }), '{"code":7}');
    assert.equal(describeValue(42), "42");
    assert.equal(describeValue(null), "null");
    assert.equal(describeValue(undefined), "an unprintable value");
    assert.equal(
      describeValue(() => 1),
      "an unprintable value",
    );
  });
});

describe("instanceFromEnv(env)", () => {
  it("trims $SN_INSTANCE and is absent — never blank — when unset or blank", () => {
    assert.deepEqual(instanceFromEnv({ SN_INSTANCE: "  dev.example.com " }), {
      instance: "dev.example.com",
    });
    for (const env of [
      {},
      { SN_INSTANCE: undefined },
      { SN_INSTANCE: "" },
      { SN_INSTANCE: "  " },
    ]) {
      const got = instanceFromEnv(env);
      assert.deepEqual(got, {});
      assert.equal("instance" in got, false);
    }
  });

  it("reads only SN_INSTANCE", () => {
    assert.deepEqual(instanceFromEnv({ INSTANCE: "x", sn_instance: "y" }), {});
  });
});

describe("defaultContext() — the one place the real process is sampled", () => {
  it("takes the actor from $USER, then $USERNAME, then `cli`", () => {
    assert.equal(
      sampleChild({ USER: " alice ", USERNAME: "bob" }).actor,
      "alice",
    );
    assert.equal(sampleChild({ USERNAME: " bob " }).actor, "bob");
    assert.equal(sampleChild({}).actor, "cli");
  });

  it("carries $SN_INSTANCE through instanceFromEnv, the cwd and the env itself", () => {
    const withInstance = sampleChild({
      SN_INSTANCE: " dev.example.com ",
      MARKER: "m1",
    });
    assert.equal(withInstance.instance, "dev.example.com");
    assert.equal(withInstance.envMarker, "m1");
    assert.equal(withInstance.cwd, process.cwd());
    assert.equal(withInstance.now, true);
    assert.equal(sampleChild({ SN_INSTANCE: " " }).hasInstance, false);
  });

  it("writes stdout and stderr lines newline-terminated to the real streams", () => {
    const script = `
      const { defaultContext } = await import(${JSON.stringify(INDEX)});
      const c = defaultContext();
      c.stdout("a"); c.stderr("b"); c.stdout("c");
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: { PATH: process.env["PATH"] },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "a\nc\n");
    assert.equal(result.stderr, "b\n");
  });

  it("samples the real wall clock, fresh on every call", () => {
    const context = defaultContext();
    const before = Date.now();
    const first = context.now();
    const after = Date.now();
    assert.ok(first instanceof Date);
    assert.ok(first.getTime() >= before && first.getTime() <= after);
    assert.notEqual(context.now(), first);
  });
});
