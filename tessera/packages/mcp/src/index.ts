// `@tessera/mcp` — the MCP surface: the read-only reports, one repo-writing
// generator, and three guarded writers that share one channel to the runner.
//
// PLAN's value-first milestones give v0.2 and v0.3 two halves each: a CLI
// command and an MCP tool. The CLI halves shipped with Phases 3 and 4, and the
// tool halves — `preflight_impact` and `preflight_coverage` — shipped here,
// "pulling a thin slice of Phase 9 forward; Phase 9 absorbs them unchanged".
// That absorption is what the rest of this package now is: Phase 9 added
// `preflight_resolve`, `preflight_plan` and `preflight_apply` by writing three
// more records in `tools.ts` and changing nothing about how a call is served,
// which is the evidence that the thin slice really was a slice.
//
// `preflight_generate` arrived the same way once Phase 6 existed to delegate to
// — one more record, no new code path — and it is the row that finally exercised
// the second declaration axis: it writes the REPOSITORY, and it is the first
// tool here that can hand instance-derived text to a third party.
//
// `preflight_run` arrived the same way again, and it is the row that proves the
// shape holds for a WRITER: a second mutating tool, added as one more record,
// inheriting the §11 guard, the ARCH-3 single mutation channel and the §4b
// intent ledger through `tess` because there is nowhere else here for it to get
// them from.
//
// The last three of §6b's nine rows — `run_status`, `confirm_ready` and
// `cleanup` — arrived once `tess status`, `tess confirm` and `tess cleanup`
// existed to delegate to, as four more records: `preflight_run_status`,
// `preflight_confirm_ready`, and cleanup split into `preflight_cleanup_plan`
// and `preflight_cleanup_apply` the way preflight is (decision 12). They read
// the §4b record a run left behind, and the apply half is the third writer.
//
// What this package is NOT is as important as what it is. It holds no resolver,
// no analyzer, no client, no config precedence and — since the apply tool — no
// writer and no guard either. It turns a `tools/call` into an argv, hands it to
// `@tessera/cli`'s `main`, and turns the exit code back into a result; every
// decision about whether that argv may change anything is made behind `main`,
// where the CLI meets it identically. See `dispatch.ts` for why that is the
// required shape rather than the convenient one.
//
// The whole surface is exported for tests, and for a host that would rather
// embed the dispatcher than spawn the binary.

export {
  SERVER_INFO,
  callTool,
  createSession,
  handleMessage,
} from "./dispatch.js";
export type { ServerContext, Session } from "./dispatch.js";
export {
  ERROR_CODES,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  errorResponse,
  negotiateProtocolVersion,
  parseMessage,
  resultResponse,
} from "./protocol.js";
export type {
  ErrorCode,
  ParseOutcome,
  RequestId,
  ResponseId,
  RpcError,
  RpcErrorResponse,
  RpcMessage,
  RpcResponse,
  RpcResultResponse,
} from "./protocol.js";
export { toolResultFor } from "./results.js";
export type { CommandOutcome, TextContent, ToolResult } from "./results.js";
export {
  defaultServerContext,
  handleLine,
  run,
  serve,
  stdioTransport,
} from "./server.js";
export type { Transport } from "./server.js";
export {
  APPLY_TOOL,
  CLEANUP_APPLY_TOOL,
  CLEANUP_LEGACY_PLAN_TOOL,
  CLEANUP_PLAN_TOOL,
  CONFIRM_READY_TOOL,
  COVERAGE_TOOL,
  DOCTOR_TOOL,
  GENERATE_TOOL,
  IMPACT_TOOL,
  PLAN_TOOL,
  RESOLVE_TOOL,
  RUN_STATUS_TOOL,
  RUN_TOOL,
  TOOLS,
  findTool,
  inputSchemaFor,
  toArgv,
  toolDefinition,
  validateArguments,
} from "./tools.js";
export type {
  ToolArgumentValue,
  ToolEgress,
  ToolField,
  ToolFieldType,
  ToolSpec,
  ToolWriteClass,
  ValidationOutcome,
} from "./tools.js";
