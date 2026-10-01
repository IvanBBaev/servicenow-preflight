// @tessera/provisioner — PLAN Phase 1, ARCH-2/ARCH-3.
//
// Turns the EnvironmentDoctor's not-ready findings into an inspectable plan of
// precise writes, and applies that plan — only in `mode: "apply"`, only through
// the single mutation channel, and only as far as the instance will confirm
// afterwards. What it cannot fix precisely, it reports as a blocker rather than
// guessing.

export type {
  HashedProvisionPlan,
  PreflightProvisionPlan,
  ProvisionBlocker,
  ProvisionMode,
  ProvisionStep,
  ProvisionWrite,
  UpdateRecordWrite,
} from "./types.js";
export {
  ProvisionApplyError,
  ProvisionRefusedError,
  ProvisionVerificationError,
} from "./errors.js";
export { createSnInstanceWriter } from "./writer.js";
export type { InstanceWriter, WriteOutcome } from "./writer.js";
export {
  DEFAULT_RECIPES,
  defineRecipe,
  enableAtfRunnerRecipe,
} from "./recipes.js";
export type { Recipe, RecipeResult, RecipeWriteScope } from "./recipes.js";
export {
  createPreflightProvisioner,
  formatProvisionPlan,
  isExecutable,
} from "./provisioner.js";
export type {
  PreflightProvisioner,
  PreflightProvisionerOptions,
} from "./provisioner.js";
