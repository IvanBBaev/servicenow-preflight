import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * The instance registry: a static, committed description of the ServiceNow
 * instances a project targets (dev → staging → test → prod) and the order they
 * promote in. It never holds credentials — those come from the environment,
 * namespaced per instance (see {@link ResolvedInstance.envPrefix} and
 * `resolveAuthFromEnv`). Lives at `.preflight/instances.json` by default.
 */

/** Directory holding the registry and per-instance state manifests. */
export const PREFLIGHT_DIR = ".preflight";

/** Registry file name under {@link PREFLIGHT_DIR}. */
export const REGISTRY_BASENAME = "instances.json";

/** One instance in the registry. */
export interface InstanceDef {
  /** Base URL, e.g. `https://dev12345.service-now.com`. */
  url: string;
  /** Pipeline stage — free-form, conventionally `dev｜staging｜test｜prod`. */
  stage?: string;
  /**
   * Name of the instance this one promotes to (the next stage), or `null` for
   * the terminal stage. Drives the promote-gate ordering.
   */
  promotesTo?: string | null;
  /** Target scope; overrides the registry-level {@link InstanceRegistry.scope}. */
  scope?: string;
  /**
   * Credential env namespace — `SNPF_<envPrefix>_*` is consulted before the
   * unprefixed `SNPF_*`. Defaults to the instance name upper-cased.
   */
  envPrefix?: string;
}

/** The parsed `instances.json`. */
export interface InstanceRegistry {
  /** Schema version (currently `1`). */
  version: number;
  /** Default scope applied to every instance that does not override it. */
  scope?: string;
  /** Instances keyed by name (`dev`, `staging`, …). */
  instances: Record<string, InstanceDef>;
}

/** A registry entry resolved for a run: defaults applied, name attached. */
export interface ResolvedInstance {
  /** Registry key (`dev`, `staging`, …). */
  name: string;
  url: string;
  stage?: string;
  promotesTo?: string | null;
  /** Effective scope (instance override, else registry default). */
  scope?: string;
  /** Effective credential env namespace (see {@link InstanceDef.envPrefix}). */
  envPrefix: string;
}

/** Absolute path of the registry file for a working directory. */
export function registryPath(cwd: string = process.cwd()): string {
  return resolve(cwd, PREFLIGHT_DIR, REGISTRY_BASENAME);
}

/** Turn an instance name into a safe env-prefix (upper snake, non-word → `_`). */
function defaultEnvPrefix(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Minimal structural validation; throws a clear error on a malformed file. */
function assertRegistry(value: unknown, path: string): InstanceRegistry {
  const reg = value as Partial<InstanceRegistry> | null;
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) {
    throw new Error(`Registry ${path} is not a JSON object.`);
  }
  if (!reg.instances || typeof reg.instances !== "object") {
    throw new Error(`Registry ${path} has no "instances" map.`);
  }
  for (const [name, def] of Object.entries(reg.instances)) {
    if (!def || typeof def !== "object" || typeof def.url !== "string") {
      throw new Error(`Registry ${path}: instance "${name}" is missing a url.`);
    }
  }
  return {
    version: reg.version ?? 1,
    scope: reg.scope,
    instances: reg.instances,
  };
}

/**
 * Load the registry from `.preflight/instances.json` (or an explicit path).
 * Returns `undefined` when the file is absent — the single-instance path stays
 * fully usable. Throws on a present-but-malformed file.
 */
export async function loadRegistry(
  cwd: string = process.cwd(),
  explicitPath?: string,
): Promise<InstanceRegistry | undefined> {
  const path = explicitPath
    ? isAbsolute(explicitPath)
      ? explicitPath
      : resolve(cwd, explicitPath)
    : registryPath(cwd);
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Registry ${path} is not valid JSON.`);
  }
  return assertRegistry(parsed, path);
}

/** Names of the instances declared in the registry (in declaration order). */
export function instanceNames(registry: InstanceRegistry): string[] {
  return Object.keys(registry.instances);
}

/**
 * Resolve one named instance from the registry, applying defaults: the scope
 * falls back to the registry default, and the env-prefix to the upper-cased
 * name. Throws (listing the known names) when `name` is not declared.
 */
export function resolveInstance(
  registry: InstanceRegistry,
  name: string,
): ResolvedInstance {
  const def = registry.instances[name];
  if (!def) {
    const known = instanceNames(registry).join(", ") || "(none)";
    throw new Error(`Unknown instance "${name}". Known instances: ${known}.`);
  }
  return {
    name,
    url: def.url,
    stage: def.stage,
    promotesTo: def.promotesTo ?? null,
    scope: def.scope ?? registry.scope,
    envPrefix: def.envPrefix?.trim() || defaultEnvPrefix(name),
  };
}
