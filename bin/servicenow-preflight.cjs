#!/usr/bin/env node
// CommonJS launcher whose only job is the Node version guard. It must stay
// parseable by ancient Node (no ?., ??, ESM syntax): the real entry is an ESM
// graph that old Node fails to *parse*, so a guard inside it can never run.
"use strict";

var major = parseInt(process.versions.node.split(".")[0], 10);
if (major < 20) {
  console.error(
    "servicenow-preflight requires Node.js >= 20, but this is " +
      process.versions.node +
      ".\nUse a newer runtime, e.g.: nvm install 22 && nvm use 22",
  );
  process.exit(1);
}

import("../build/cli.js").catch(function (err) {
  var message = err && err.message ? err.message : String(err);
  console.error("servicenow-preflight failed to start: " + message);
  if (process.env.SNPF_DEBUG && err && err.stack) {
    console.error(err.stack);
  } else {
    console.error("Set SNPF_DEBUG=1 to see the full stack trace.");
  }
  process.exit(1);
});
