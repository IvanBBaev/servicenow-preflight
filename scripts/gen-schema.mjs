#!/usr/bin/env node
// Generate the JSON Schemas for the `--format json` report from the TypeScript
// declarations, so the published contract can never drift from the types.
//
//   node scripts/gen-schema.mjs             write schemas/ and site/schemas/
//   node scripts/gen-schema.mjs --check     exit 1 if a committed schema is stale
//   --out <dir>                             write into <dir> only (tests)
//
// Reads src/types.ts, src/report/json.ts and src/trace.ts with the TypeScript compiler API
// (a devDependency); supports exactly the type shapes those files use.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = [
  join(ROOT, "src", "types.ts"),
  join(ROOT, "src", "report", "json.ts"),
  join(ROOT, "src", "trace.ts"),
];
const BASE_URL = "https://ivanbbaev.github.io/servicenow-preflight/schemas/";

/** The schema files to emit: file name, root declaration and title. */
export const SCHEMAS = [
  {
    file: "report.v1.json",
    root: "ReportEnvelope",
    title: "servicenow-preflight JSON report (v1)",
  },
  {
    file: "finding.v1.json",
    root: "Finding",
    title: "servicenow-preflight finding (v1)",
  },
];

/** Collect the interface and type-alias declarations of the source files. */
export function collectDeclarations(files = SOURCES) {
  const decls = new Map();
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const stmt of source.statements) {
      if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
        decls.set(stmt.name.text, stmt);
      }
    }
  }
  return decls;
}

/** The first JSDoc paragraph of a node, collapsed to one line. */
function describe(node) {
  const doc = ts.getJSDocCommentsAndTags(node).find(ts.isJSDoc);
  const text = typeof doc?.comment === "string" ? doc.comment : undefined;
  if (!text) return undefined;
  return text
    .split(/\n\s*\n/)[0]
    .replace(/\{@link\s+([^}]+)\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function withDescription(schema, node) {
  const description = describe(node);
  return description ? { description, ...schema } : schema;
}

/** The string/number literal values of a literal-union alias, or undefined. */
function literalValues(type, decls) {
  if (ts.isLiteralTypeNode(type)) {
    const lit = type.literal;
    if (ts.isStringLiteral(lit)) return [lit.text];
    if (ts.isNumericLiteral(lit)) return [Number(lit.text)];
    return undefined;
  }
  if (ts.isUnionTypeNode(type)) {
    const all = [];
    for (const t of type.types) {
      const values = literalValues(t, decls);
      if (!values) return undefined;
      all.push(...values);
    }
    return all;
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const decl = decls.get(type.typeName.text);
    if (decl && ts.isTypeAliasDeclaration(decl)) {
      return literalValues(decl.type, decls);
    }
  }
  return undefined;
}

function objectSchema(members, decls, refs) {
  const properties = {};
  const required = [];
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.type) {
      throw new Error(`gen-schema: unsupported member ${member.getText()}`);
    }
    const name = member.name.getText();
    properties[name] = withDescription(
      typeSchema(member.type, decls, refs),
      member,
    );
    if (!member.questionToken) required.push(name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** Convert one type node; named references are queued in `refs`. */
function typeSchema(type, decls, refs) {
  switch (type.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { type: "string" };
    case ts.SyntaxKind.NumberKeyword:
      return { type: "number" };
    case ts.SyntaxKind.BooleanKeyword:
      return { type: "boolean" };
    default:
      break;
  }
  if (ts.isTypeOperatorNode(type)) return typeSchema(type.type, decls, refs);
  if (ts.isArrayTypeNode(type)) {
    return { type: "array", items: typeSchema(type.elementType, decls, refs) };
  }
  if (ts.isTypeLiteralNode(type))
    return objectSchema(type.members, decls, refs);
  const literals = literalValues(type, decls);
  if (literals && !ts.isTypeReferenceNode(type)) {
    return literals.length === 1 ? { const: literals[0] } : { enum: literals };
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const name = type.typeName.text;
    if (name === "Record" && type.typeArguments?.length === 2) {
      const [keyType, valueType] = type.typeArguments;
      const keys = literalValues(keyType, decls);
      if (!keys) throw new Error("gen-schema: Record keys must be literals");
      const value = typeSchema(valueType, decls, refs);
      return {
        type: "object",
        properties: Object.fromEntries(keys.map((k) => [k, value])),
        required: keys.map(String),
      };
    }
    if (!decls.has(name)) {
      throw new Error(`gen-schema: unknown type reference ${name}`);
    }
    refs.add(name);
    return { $ref: `#/$defs/${name}` };
  }
  throw new Error(`gen-schema: unsupported type ${type.getText()}`);
}

/** Schema for one named declaration. */
function declarationSchema(decl, decls, refs) {
  const schema = ts.isInterfaceDeclaration(decl)
    ? objectSchema(decl.members, decls, refs)
    : typeSchema(decl.type, decls, refs);
  return withDescription(schema, decl);
}

/** Build the schema document rooted at `root`, with every referenced $def. */
export function buildSchema(spec, decls = collectDeclarations()) {
  const rootDecl = decls.get(spec.root);
  if (!rootDecl) throw new Error(`gen-schema: no declaration ${spec.root}`);
  const refs = new Set();
  const root = declarationSchema(rootDecl, decls, refs);
  const defs = {};
  const done = new Set();
  while (done.size < refs.size) {
    for (const name of [...refs].sort()) {
      if (done.has(name)) continue;
      done.add(name);
      defs[name] = declarationSchema(decls.get(name), decls, refs);
    }
  }
  const sorted = Object.fromEntries(
    Object.keys(defs)
      .sort()
      .map((k) => [k, defs[k]]),
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${BASE_URL}${spec.file}`,
    title: spec.title,
    ...root,
    ...(Object.keys(sorted).length > 0 ? { $defs: sorted } : {}),
  };
}

/** Render one schema file's text. */
export function renderSchema(spec, decls) {
  return `${JSON.stringify(buildSchema(spec, decls), null, 2)}\n`;
}

function main(argv) {
  const check = argv.includes("--check");
  const outIdx = argv.indexOf("--out");
  const dirs =
    outIdx >= 0 && argv[outIdx + 1]
      ? [argv[outIdx + 1]]
      : [join(ROOT, "schemas"), join(ROOT, "site", "schemas")];
  const decls = collectDeclarations();
  let stale = 0;
  for (const dir of dirs) {
    for (const spec of SCHEMAS) {
      const path = join(dir, spec.file);
      const text = renderSchema(spec, decls);
      const shown = relative(ROOT, path) || path;
      if (check) {
        if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
          process.stderr.write(
            `${shown} is stale; run \`npm run gen:schema\`.\n`,
          );
          stale += 1;
        }
        continue;
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, text);
      process.stdout.write(`Wrote ${shown}\n`);
    }
  }
  if (stale > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
