// PA-10 fix 3: the reviewed-body binding.
//
// `tess review` records `{ bodySha256, reviewer }` on a promoted manifest
// entry; `loadLiveSpecs` (and so `tess run --live`) refuses any unit spec whose
// current body does not hash to it. Everything here is local disk — no fake
// instance, no `fetch`.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readSpecInventory } from "@tessera/specs";

import {
  canonicalSpecBody,
  commandHelp,
  EXIT_CODES,
  formatUnreviewedSpecs,
  loadLiveSpecs,
  main,
  REVIEW_RESULT_KIND,
  specBodySha256,
  verifySpecReview,
} from "../build/index.js";

const tempRoots = [];
after(async () => {
  for (const dir of tempRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const hex = (prefix) => prefix.padEnd(32, "0");
const TARGETS = [{ table: "sys_script_include", sysId: hex("a"), name: "X" }];
const BODY = "gs.info('reviewed');\n";
const HOSTILE = `var gr = new GlideRecord("sys_user");
gr.query();
while (gr.next()) { gr.deleteRecord(); }
`;

/**
 * A tests root with one file per entry. `entry.body` is written to disk; the
 * rest of the entry (minus `body`) goes into `.manifest.json` as is.
 */
async function root(entries, extra = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-review-"));
  tempRoots.push(base);
  const testsRoot = path.join(base, "tests");
  await fs.mkdir(testsRoot, { recursive: true });
  const specs = [];
  for (const { body, ...entry } of entries) {
    await fs.writeFile(path.join(testsRoot, entry.path), body ?? BODY);
    specs.push({ kind: "unit", targets: TARGETS, ...entry });
  }
  await fs.writeFile(
    path.join(testsRoot, ".manifest.json"),
    JSON.stringify({ version: 1, specs, ...extra }),
  );
  return { base, testsRoot };
}

const reviewOf = (body, reviewer = "alice") => ({
  bodySha256: specBodySha256(body),
  reviewer,
});

function capture(cwd) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    context: {
      now: () => new Date("2026-10-22T10:00:00.000Z"),
      // An ambient identity that MUST NOT become the reviewer.
      actor: "ambient-user",
      cwd,
      env: { USER: "ambient-user" },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  };
}

async function readManifest(testsRoot) {
  return JSON.parse(
    await fs.readFile(path.join(testsRoot, ".manifest.json"), "utf8"),
  );
}

// ── the canonical form ──────────────────────────────────────────────────────

describe("specBodySha256 — the canonical review digest", () => {
  it("is lowercase hex SHA-256 over the UTF-8 text (FIPS 180-2 vector)", () => {
    assert.equal(
      specBodySha256("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is stable: the same text always hashes the same", () => {
    const body = "var x = 1;\n// é\n";
    assert.equal(specBodySha256(body), specBodySha256(`${body}`));
    assert.equal(
      specBodySha256(body),
      createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"),
    );
  });

  it("folds CRLF to LF and normalises nothing else: lone CR, BOM, trailing whitespace and NFC/NFD all differ", () => {
    const lf = "gs.info('a');\n";
    assert.equal(specBodySha256("gs.info('a');\r\n"), specBodySha256(lf));
    assert.equal(canonicalSpecBody("a\r\nb\r\n"), "a\nb\n");
    // Idempotent: a CR run before an LF folds in one pass, so the digest of
    // the canonical text is the digest of the text that runs.
    assert.equal(canonicalSpecBody("a\r\r\nb"), "a\nb");
    for (const raw of ["a\r\r\n", "\r\n\r\n", "x\ry\r\n", "\r"]) {
      const once = canonicalSpecBody(raw);
      assert.equal(canonicalSpecBody(once), once, JSON.stringify(raw));
      assert.equal(specBodySha256(raw), specBodySha256(once));
    }
    assert.equal(canonicalSpecBody("x\ry"), "x\ry");
    const variants = [
      "gs.info('a');\r",
      String.fromCharCode(0xfeff) + lf,
      "gs.info('a'); \n",
      "gs.info('a');",
    ];
    for (const variant of variants) {
      assert.notEqual(specBodySha256(variant), specBodySha256(lf), variant);
    }
    assert.notEqual(
      specBodySha256("// caf\u00e9\n"),
      specBodySha256("// cafe\u0301\n"),
    );
  });

  it("a CRLF checkout of an LF-reviewed body still loads, and projects LF", async () => {
    const lf = "gs.info('one');\ngs.info('two');\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    const { testsRoot } = await root([
      { id: "U", path: "u.unit.ts", body: crlf, review: reviewOf(lf) },
    ]);
    const load = await loadLiveSpecs(testsRoot);
    assert.equal(load.kind, "loaded");
    assert.equal(load.specs[0].payload.script, lf);
  });

  it("tess review on a CRLF file records the digest an LF checkout matches", async () => {
    const lf = "gs.info('x');\n";
    const { base, testsRoot } = await root([
      { id: "U", path: "u.unit.ts", body: lf.replace(/\n/g, "\r\n") },
    ]);
    const io = capture(base);
    const code = await main(
      ["review", "--tests-root", testsRoot, "--spec", "U", "--reviewer", "bob"],
      io.context,
    );
    assert.equal(code, 0, io.stderr());
    const manifest = await readManifest(testsRoot);
    assert.equal(manifest.specs[0].review.bodySha256, specBodySha256(lf));
    await fs.writeFile(path.join(testsRoot, "u.unit.ts"), lf);
    assert.equal((await loadLiveSpecs(testsRoot)).kind, "loaded");
  });

  it("hashes exactly what loadLiveSpecs projects as the step script", async () => {
    const body = "gs.info('crlf');\r\n";
    const { testsRoot } = await root([
      { id: "U", path: "u.unit.ts", body, review: reviewOf(body) },
    ]);
    const load = await loadLiveSpecs(testsRoot);
    assert.equal(load.kind, "loaded");
    assert.equal(
      specBodySha256(load.specs[0].payload.script),
      reviewOf(body).bodySha256,
    );
  });
});

// ── verifySpecReview ────────────────────────────────────────────────────────

describe("verifySpecReview", () => {
  const ref = { id: "U", path: "u.unit.ts" };

  it("a matching record passes", () => {
    assert.equal(
      verifySpecReview(ref, { ok: true, record: reviewOf(BODY) }, BODY),
      undefined,
    );
  });

  it("no record, a malformed record and a changed body are each refusals", () => {
    assert.equal(verifySpecReview(ref, undefined, BODY)?.reason, "missing");
    const malformed = verifySpecReview(
      ref,
      { ok: false, problem: "bad" },
      BODY,
    );
    assert.equal(malformed?.reason, "malformed");
    assert.equal(malformed?.problem, "bad");
    const changed = verifySpecReview(
      ref,
      { ok: true, record: reviewOf("other();\n", "bob") },
      BODY,
    );
    assert.equal(changed?.reason, "changed");
    assert.equal(changed?.reviewer, "bob");
    assert.equal(changed?.recordedSha256, specBodySha256("other();\n"));
    assert.equal(changed?.currentSha256, specBodySha256(BODY));
  });

  it("the operator lines carry ids and digests and a --reviewer remedy, never the body", () => {
    const lines = formatUnreviewedSpecs(
      [
        verifySpecReview(ref, undefined, BODY),
        verifySpecReview(ref, { ok: false, problem: "bad shape" }, BODY),
        verifySpecReview(ref, { ok: true, record: reviewOf("x\n") }, BODY),
      ],
      "tests",
    );
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.match(line, /--reviewer <id>/);
      assert.doesNotMatch(line, /reviewed'\)/);
    }
    assert.match(lines[0], /tess review --tests-root tests --spec U/);
    assert.match(lines[1], /bad shape/);
    assert.match(lines[2], /re-review the CURRENT body/);
  });
});

// ── loadLiveSpecs ───────────────────────────────────────────────────────────

describe("loadLiveSpecs requires a matching review for every unit spec", () => {
  it("a body whose digest matches its record loads", async () => {
    const { testsRoot } = await root([
      { id: "U", path: "u.unit.ts", review: reviewOf(BODY) },
    ]);
    const load = await loadLiveSpecs(testsRoot);
    assert.equal(load.kind, "loaded");
    assert.equal(load.specs.length, 1);
  });

  it("a changed body is refused, naming both digests and the reviewer", async () => {
    const { testsRoot } = await root([
      {
        id: "U",
        path: "u.unit.ts",
        body: "gs.info('changed');\n",
        review: reviewOf(BODY),
      },
    ]);
    const load = await loadLiveSpecs(testsRoot);
    assert.equal(load.kind, "unreviewed");
    assert.deepEqual(load.unreviewed, [
      {
        id: "U",
        path: "u.unit.ts",
        reason: "changed",
        currentSha256: specBodySha256("gs.info('changed');\n"),
        recordedSha256: specBodySha256(BODY),
        reviewer: "alice",
      },
    ]);
  });

  it("a spec with no record is refused (a pre-review manifest fails closed)", async () => {
    const { testsRoot } = await root([{ id: "U", path: "u.unit.ts" }]);
    const load = await loadLiveSpecs(testsRoot);
    assert.equal(load.kind, "unreviewed");
    assert.equal(load.unreviewed[0].reason, "missing");
  });

  it("a malformed record is refused, never coerced", async () => {
    const malformed = [
      "not-an-object",
      { bodySha256: "ABC", reviewer: "alice" },
      { bodySha256: specBodySha256(BODY).toUpperCase(), reviewer: "alice" },
      { bodySha256: specBodySha256(BODY) },
      { bodySha256: specBodySha256(BODY), reviewer: "" },
      { bodySha256: specBodySha256(BODY), reviewer: "-flag" },
      { bodySha256: specBodySha256(BODY), reviewer: "a b" },
      { ...reviewOf(BODY), reviewedAt: "2026-10-22" },
    ];
    for (const review of malformed) {
      const { testsRoot } = await root([
        { id: "U", path: "u.unit.ts", review },
      ]);
      const load = await loadLiveSpecs(testsRoot);
      assert.equal(load.kind, "unreviewed", JSON.stringify(review));
      assert.equal(load.unreviewed[0].reason, "malformed");
      assert.equal(typeof load.unreviewed[0].problem, "string");
    }
  });

  it("one unreviewed spec refuses the whole load; only it is listed", async () => {
    const { testsRoot } = await root([
      { id: "A", path: "a.unit.ts", review: reviewOf(BODY) },
      { id: "B", path: "b.unit.ts" },
    ]);
    const load = await loadLiveSpecs(testsRoot);
    assert.equal(load.kind, "unreviewed");
    assert.deepEqual(
      load.unreviewed.map((entry) => entry.id),
      ["B"],
    );
  });

  it("a TM-3 rejection is reported ahead of a missing review", async () => {
    const { testsRoot } = await root([
      { id: "A", path: "a.unit.ts" },
      { id: "H", path: "h.unit.ts", body: HOSTILE, review: reviewOf(HOSTILE) },
    ]);
    const load = await loadLiveSpecs(testsRoot);
    assert.equal(load.kind, "rejected");
    assert.deepEqual(
      load.rejected.map((entry) => entry.id),
      ["H"],
    );
  });

  it("a non-unit spec needs no review record", async () => {
    const { testsRoot } = await root([
      { id: "U", path: "u.unit.ts", review: reviewOf(BODY) },
      { id: "E", path: "e.e2e.atf.yaml", kind: "e2e" },
    ]);
    const load = await loadLiveSpecs(testsRoot);
    assert.equal(load.kind, "loaded");
  });
});

// ── other commands keep working without review records ─────────────────────

describe("review records are a run --live requirement only", () => {
  it("the inventory reads a pre-review manifest with no new warning", async () => {
    const { testsRoot } = await root([{ id: "U", path: "u.unit.ts" }]);
    const inventory = await readSpecInventory({ root: testsRoot });
    assert.equal(inventory.specs.length, 1);
    assert.equal(inventory.incomplete, false);
    assert.equal(inventory.reviews.size, 0);
  });

  it("a malformed record is reported in `reviews`, not as a warning", async () => {
    const { testsRoot } = await root([
      { id: "U", path: "u.unit.ts", review: { bodySha256: "x" } },
    ]);
    const inventory = await readSpecInventory({ root: testsRoot });
    assert.equal(inventory.specs.length, 1);
    assert.equal(inventory.incomplete, false);
    assert.equal(
      inventory.notes.filter((note) => note.level === "warning").length,
      0,
    );
    assert.equal(inventory.reviews.get("U")?.ok, false);
  });
});

// ── tess review ─────────────────────────────────────────────────────────────

describe("tess review", () => {
  it("records the body digest and the explicitly named reviewer", async () => {
    const { base, testsRoot } = await root(
      [
        { id: "U", path: "u.unit.ts", note: "kept" },
        { id: "V", path: "v.unit.ts", body: "gs.info('v');\n" },
      ],
      { comment: "top-level fields are carried through" },
    );
    const cap = capture(base);
    const code = await main(
      ["review", "--tests-root", "tests", "--spec", "U", "--reviewer", "alice"],
      cap.context,
    );
    assert.equal(code, EXIT_CODES.ok, cap.stderr());
    assert.equal(
      cap.stdout(),
      `reviewed U (u.unit.ts): sha256 ${specBodySha256(BODY)} by alice`,
    );
    const manifest = await readManifest(testsRoot);
    assert.equal(manifest.comment, "top-level fields are carried through");
    assert.deepEqual(manifest.specs[0].review, reviewOf(BODY));
    assert.equal(manifest.specs[0].note, "kept");
    assert.equal(manifest.specs[1].review, undefined, "only --spec ids");
    assert.doesNotMatch(JSON.stringify(manifest), /ambient-user/);
    // No temp file is left next to the manifest.
    assert.deepEqual(
      (await fs.readdir(testsRoot)).filter((name) => name.endsWith(".tmp")),
      [],
    );
    // The spec it recorded now loads; the one it did not is still refused.
    const load = await loadLiveSpecs(testsRoot);
    assert.equal(load.kind, "unreviewed");
    assert.deepEqual(
      load.unreviewed.map((entry) => entry.id),
      ["V"],
    );
  });

  it("re-reviewing after an edit replaces the record; --json reports it", async () => {
    const { base, testsRoot } = await root([
      { id: "U", path: "u.unit.ts", review: reviewOf("old();\n", "bob") },
    ]);
    const cap = capture(base);
    const code = await main(
      [
        "review",
        "--tests-root",
        testsRoot,
        "--spec",
        "U",
        "--spec",
        "U",
        "--reviewer",
        "carol@example.com",
        "--json",
      ],
      cap.context,
    );
    assert.equal(code, EXIT_CODES.ok, cap.stderr());
    assert.deepEqual(JSON.parse(cap.stdout()), {
      kind: REVIEW_RESULT_KIND,
      reviewed: [
        {
          id: "U",
          path: "u.unit.ts",
          ...reviewOf(BODY, "carol@example.com"),
        },
      ],
    });
    assert.equal((await loadLiveSpecs(testsRoot)).kind, "loaded");
  });

  it("requires --reviewer and never defaults it from $USER or the actor", async () => {
    const { base, testsRoot } = await root([{ id: "U", path: "u.unit.ts" }]);
    const before = await fs.readFile(
      path.join(testsRoot, ".manifest.json"),
      "utf8",
    );
    const cap = capture(base);
    const code = await main(
      ["review", "--tests-root", "tests", "--spec", "U"],
      cap.context,
    );
    assert.equal(code, EXIT_CODES.usage);
    assert.match(cap.stderr(), /review needs --reviewer <id>/);
    assert.match(cap.stderr(), /never taken from git config or \$USER/);
    assert.equal(
      await fs.readFile(path.join(testsRoot, ".manifest.json"), "utf8"),
      before,
    );
  });

  it("refuses bad arguments as usage errors and writes nothing", async () => {
    const { base, testsRoot } = await root([
      { id: "U", path: "u.unit.ts" },
      { id: "E", path: "e.e2e.atf.yaml", kind: "e2e" },
    ]);
    const before = await fs.readFile(
      path.join(testsRoot, ".manifest.json"),
      "utf8",
    );
    const cases = [
      [["--spec", "U", "--reviewer", "a"], /needs --tests-root/],
      [["--tests-root", "tests", "--reviewer", "a"], /at least one --spec/],
      [
        ["--tests-root", "tests", "--spec", "U", "--reviewer", "a b"],
        /not a valid reviewer id/,
      ],
      [
        [
          "--tests-root",
          "tests",
          "--spec",
          "U",
          "--reviewer",
          "a",
          "--reviewer",
          "b",
        ],
        /--reviewer given more than once/,
      ],
      [
        [
          "--tests-root",
          "tests",
          "--tests-root",
          "x",
          "--spec",
          "U",
          "--reviewer",
          "a",
        ],
        /--tests-root given more than once/,
      ],
      [["--tests-root", "tests", "--spec"], /--spec expects a value/],
      [["--bogus"], /unknown flag "--bogus"/],
      [
        [
          "--tests-root",
          "tests",
          "--spec",
          "U",
          "--spec",
          "NOPE",
          "--reviewer",
          "a",
        ],
        /spec "NOPE" is not registered/,
      ],
      [
        ["--tests-root", "tests", "--spec", "E", "--reviewer", "a"],
        /is a e2e spec; only unit specs/,
      ],
      [
        ["--tests-root", "missing", "--spec", "U", "--reviewer", "a"],
        /--tests-root missing/,
      ],
    ];
    for (const [argv, pattern] of cases) {
      const cap = capture(base);
      const code = await main(["review", ...argv], cap.context);
      assert.equal(code, EXIT_CODES.usage, argv.join(" "));
      assert.match(cap.stderr(), pattern, argv.join(" "));
      assert.match(cap.stderr(), /tess review --help/);
    }
    assert.equal(
      await fs.readFile(path.join(testsRoot, ".manifest.json"), "utf8"),
      before,
    );
  });

  it("refuses a duplicated id rather than guess which entry to stamp", async () => {
    const { base, testsRoot } = await root([
      { id: "U", path: "u.unit.ts" },
      { id: "U", path: "w.unit.ts" },
    ]);
    const cap = capture(base);
    const code = await main(
      ["review", "--tests-root", testsRoot, "--spec", "U", "--reviewer", "a"],
      cap.context,
    );
    assert.equal(code, EXIT_CODES.usage);
    assert.match(cap.stderr(), /appears 2 times/);
    const manifest = await readManifest(testsRoot);
    assert.equal(manifest.specs[0].review, undefined);
  });

  it("never records a body the TM-3 gate refuses (exit 4, nothing written)", async () => {
    const { base, testsRoot } = await root([
      { id: "U", path: "u.unit.ts" },
      { id: "H", path: "h.unit.ts", body: HOSTILE },
    ]);
    const before = await fs.readFile(
      path.join(testsRoot, ".manifest.json"),
      "utf8",
    );
    const cap = capture(base);
    const code = await main(
      [
        "review",
        "--tests-root",
        testsRoot,
        "--spec",
        "U",
        "--spec",
        "H",
        "--reviewer",
        "alice",
      ],
      cap.context,
    );
    assert.equal(code, EXIT_CODES.refused);
    assert.match(cap.stderr(), /REFUSED \(TM-3\): 1 spec/);
    assert.match(cap.stderr(), /H \(h\.unit\.ts\)/);
    assert.doesNotMatch(cap.stderr(), /deleteRecord\(\)/);
    assert.deepEqual(cap.out, []);
    assert.equal(
      await fs.readFile(path.join(testsRoot, ".manifest.json"), "utf8"),
      before,
    );
  });

  it("has help that names the required reviewer and the canonical form", () => {
    const text = commandHelp("review");
    assert.match(text, /--reviewer <id>\s+Who reviewed the bodies\. Required/);
    assert.match(text, /never\s+defaulted from git config or \$USER/);
    assert.match(text, /each CRLF folded to LF/);
    assert.match(
      text,
      /no other newline, BOM, whitespace or Unicode\s+normalisation/,
    );
    assert.match(commandHelp("run"), /REFUSED \(TM-5 review\)/);
  });
});
