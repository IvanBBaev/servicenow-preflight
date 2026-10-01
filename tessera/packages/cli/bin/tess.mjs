#!/usr/bin/env node
// Launcher only. Deliberately trivial and untyped: the package tsconfig
// compiles `src/**/*` alone, so anything written here would escape the
// type-checked ESLint ruleset. All of the CLI lives in `src/`.
//
// `main` never throws — it returns the exit code — so there is no catch here.
// `process.exitCode` rather than `process.exit()`: stdout must drain first.

import { run } from "../build/cli.js";

await run(process.argv.slice(2));
