#!/usr/bin/env node
// Launcher only, and untyped for the same reason `tess` is: the package tsconfig
// compiles `src/**/*` alone, so anything written here would escape the
// type-checked ESLint ruleset. All of the server lives in `src/`.
//
// Nothing is printed here. stdout is the protocol channel — a banner, a version
// line or a stray `console.log` on it desynchronises the client before the
// handshake. `run` returns when stdin closes, which is how the host stops it.

import { run } from "../build/server.js";

await run();
