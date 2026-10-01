// Shared CommonJS launcher for the Tessera bins (`tess`, `tessera-mcp`) that
// ship inside this package (ADR-001 Option B; staged into build/tessera by
// scripts/stage-tessera.mjs at pack time). Same constraints as
// servicenow-preflight.cjs: parseable by ancient Node, so the version guard can
// run. Everything goes to stderr — stdout is the MCP protocol channel.
"use strict";

var path = require("path");
var fs = require("fs");
var url = require("url");

module.exports = function launch(name, pkg, binFile) {
  var major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 20) {
    console.error(
      name +
        " requires Node.js >= 20, but this is " +
        process.versions.node +
        ".\nUse a newer runtime, e.g.: nvm install 22 && nvm use 22",
    );
    process.exit(1);
  }
  var entry = path.join(
    __dirname,
    "..",
    "build",
    "tessera",
    "node_modules",
    "@tessera",
    pkg,
    "bin",
    binFile,
  );
  if (!fs.existsSync(entry)) {
    console.error(
      name +
        " is not bundled in this build of servicenow-preflight (missing " +
        entry +
        ").\nIn a source checkout, build tessera/ and run: npm run stage:tessera",
    );
    process.exit(1);
  }
  import(url.pathToFileURL(entry).href).catch(function (err) {
    var message = err && err.message ? err.message : String(err);
    console.error(name + " failed to start: " + message);
    if (process.env.SNPF_DEBUG && err && err.stack) {
      console.error(err.stack);
    } else {
      console.error("Set SNPF_DEBUG=1 to see the full stack trace.");
    }
    process.exit(1);
  });
};
