// `tess run` argument parsing: the mode boundary, the flags that belong to
// exactly one mode, and the refusals that stop a run before anything is
// written. Pure parsing — nothing here touches an instance or a ledger.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { parseRunArgs } from "../build/index.js";

const ctx = {
  now: () => new Date("2026-09-26T10:00:00.000Z"),
  actor: "tester",
  cwd: "/work",
};

const LIVE = ["--live", "--scope", "x_app", "--tests-root", "tests"];

function refusal(argv, context = ctx) {
  const parsed = parseRunArgs(argv, context);
  assert.equal(parsed.kind, "error", JSON.stringify(parsed));
  return parsed.message;
}

describe("tess run — the mode is named, never defaulted", () => {
  it("refuses both modes at once and refuses neither", () => {
    assert.match(
      refusal(["--skeleton", "--live"]),
      /two different runs; pass exactly one/,
    );
    assert.match(refusal([]), /`run` requires a mode: --skeleton .* or --live/);
  });

  it("refuses an unknown option by name", () => {
    assert.equal(
      refusal(["--skeleton", "--fake", "--frobnicate"]),
      "unknown option --frobnicate",
    );
  });
});

describe("tess run --skeleton", () => {
  it("--lifecycle takes ephemeral or persistent and nothing else", () => {
    const parsed = parseRunArgs(
      ["--skeleton", "--fake", "--lifecycle", "persistent"],
      ctx,
    );
    assert.equal(parsed.kind, "run");
    assert.equal(parsed.options.lifecycle, "persistent");
    assert.equal(
      refusal(["--skeleton", "--lifecycle", "forever"]),
      '--lifecycle expects "ephemeral" or "persistent" (got "forever")',
    );
    assert.equal(
      refusal(["--skeleton", "--lifecycle"]),
      '--lifecycle expects "ephemeral" or "persistent" (got "")',
    );
  });

  it("--docs-dir and --keep reach the options; a bare --docs-dir is refused", () => {
    const parsed = parseRunArgs(
      ["--skeleton", "--fake", "--docs-dir", "docs", "--keep"],
      ctx,
    );
    assert.equal(parsed.kind, "run");
    assert.equal(parsed.options.docsDir, "docs");
    assert.equal(parsed.options.keepLedger, true);
    assert.equal(
      refusal(["--skeleton", "--fake", "--docs-dir"]),
      "--docs-dir expects a directory",
    );
  });

  it("without --instance, SN_INSTANCE or --fake there is no instance", () => {
    for (const instance of [undefined, "", "   "]) {
      assert.equal(
        refusal(["--skeleton"], { ...ctx, instance }),
        "no instance: pass --instance <host> or set SN_INSTANCE (or use --fake)",
      );
    }
    const parsed = parseRunArgs(["--skeleton"], {
      ...ctx,
      instance: "dev.example.com",
    });
    assert.equal(parsed.kind, "run");
    assert.equal(parsed.options.instanceHost, "dev.example.com");
    assert.deepEqual(parsed.options.nonProdAllowlist, []);
  });
});

describe("tess run --live", () => {
  it("refuses every skeleton-only flag, naming the first one typed", () => {
    for (const flag of [
      "--fake",
      "--mutant",
      "--fake-production-property",
      "--keep",
    ]) {
      assert.match(
        refusal([...LIVE, flag]),
        new RegExp(`^${flag} belongs to --skeleton; --live takes`),
      );
    }
    assert.match(
      refusal([...LIVE, "--keep", "--fake"]),
      /^--keep belongs to --skeleton/,
    );
  });

  it("is ephemeral-only: --lifecycle persistent is refused, ephemeral is accepted", () => {
    assert.match(
      refusal([...LIVE, "--lifecycle", "persistent"]),
      /ephemeral-only \(DEV-20\)/,
    );
    assert.equal(
      parseRunArgs([...LIVE, "--lifecycle", "ephemeral"], ctx).kind,
      "live",
    );
  });

  it("needs --scope and --tests-root, with no default for either", () => {
    assert.match(
      refusal(["--live", "--tests-root", "tests"]),
      /^--live needs --scope <app scope>/,
    );
    assert.match(
      refusal(["--live", "--scope", "x_app"]),
      /^--live needs --tests-root <dir>/,
    );
  });

  it("carries --acknowledge-prod as a cli-surface acknowledgement by the actor", () => {
    const parsed = parseRunArgs(
      [...LIVE, "--actor", "ops", "--acknowledge-prod", "CAB-123 approved"],
      ctx,
    );
    assert.equal(parsed.kind, "live");
    assert.deepEqual(parsed.options.acknowledgeProd, {
      reason: "CAB-123 approved",
      actor: "ops",
      surface: "cli",
    });
    assert.equal(parsed.options.actor, "ops");
    assert.equal("acknowledgeProd" in parseRunArgs(LIVE, ctx).options, false);
  });

  it("defaults the runner to `default` and the source to the runner; paths resolve from cwd", () => {
    const parsed = parseRunArgs(
      [...LIVE, "--json-out", "out/r.json", "--junit-out", "out/r.xml"],
      ctx,
    );
    assert.equal(parsed.kind, "live");
    assert.equal(parsed.options.runner, "default");
    assert.equal(parsed.options.source, "default");
    assert.equal(parsed.options.testsRoot, path.resolve("/work", "tests"));
    assert.equal(parsed.options.jsonOut, path.resolve("/work", "out/r.json"));
    assert.equal(parsed.options.junitOut, path.resolve("/work", "out/r.xml"));
    const named = parseRunArgs([...LIVE, "--runner", "atf"], ctx);
    assert.equal(named.options.runner, "atf");
    assert.equal(named.options.source, "atf");
  });
});
