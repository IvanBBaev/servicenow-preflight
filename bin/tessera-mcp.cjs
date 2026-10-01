#!/usr/bin/env node
// `tessera-mcp` — the Tessera MCP server (stdio), shipped inside
// servicenow-preflight (ADR-001). Prints nothing to stdout itself.
"use strict";

require("./tessera-launcher.cjs")("tessera-mcp", "mcp", "tessera-mcp.mjs");
