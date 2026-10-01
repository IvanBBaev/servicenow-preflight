// Composition root (ARCH-1): core owns the registries and resolvePipeline.
// Composition only: the run loop that drives these ports over a live instance
// landed separately in `runPipeline.ts` (PLAN Phase 0.5) and nothing in this
// file knows about it.

import type {
  ImpactAnalyzer,
  Provisioner,
  Reporter,
  Resolver,
  Runner,
  TestGenerator,
  TestStore,
} from "./ports.js";
import type { GateEvaluator } from "./gateEvaluator.js";

export class Registry<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly kind: string) {}

  register(name: string, value: T): void {
    if (this.entries.has(name)) {
      throw new Error(`${this.kind} "${name}" is already registered`);
    }
    this.entries.set(name, value);
  }

  get(name: string): T {
    const value = this.entries.get(name);
    if (value === undefined) {
      const known = this.names().join(", ") || "none";
      throw new Error(`unknown ${this.kind} "${name}" (registered: ${known})`);
    }
    return value;
  }

  names(): string[] {
    return [...this.entries.keys()].sort();
  }
}

export interface PipelineRegistries {
  resolvers: Registry<Resolver>;
  impactAnalyzers: Registry<ImpactAnalyzer>;
  generators: Registry<TestGenerator>;
  stores: Registry<TestStore>;
  runners: Registry<Runner>;
  reporters: Registry<Reporter>;
  provisioners: Registry<Provisioner>;
  gates: Registry<GateEvaluator>;
}

export function createRegistries(): PipelineRegistries {
  return {
    resolvers: new Registry("resolver"),
    impactAnalyzers: new Registry("impact analyzer"),
    generators: new Registry("test generator"),
    stores: new Registry("test store"),
    runners: new Registry("runner"),
    reporters: new Registry("reporter"),
    provisioners: new Registry("provisioner"),
    gates: new Registry("gate evaluator"),
  };
}

/** Adapter names config selects — resolved against the registries (ARCH-1). */
export interface PipelineConfig {
  resolver: string;
  impactAnalyzer: string;
  generator: string;
  store: string;
  runners: readonly string[];
  reporters: readonly string[];
  provisioner: string;
  gate: string;
}

/** The resolved set of ports one pipeline run composes. */
export interface PipelinePorts {
  resolver: Resolver;
  impactAnalyzer: ImpactAnalyzer;
  generator: TestGenerator;
  store: TestStore;
  runners: readonly Runner[];
  reporters: readonly Reporter[];
  provisioner: Provisioner;
  gate: GateEvaluator;
}

/**
 * Resolve a config to concrete ports. Throws (naming the registered
 * alternatives) on any unknown adapter name — composition errors surface at
 * startup, not mid-run.
 */
export function resolvePipeline(
  registries: PipelineRegistries,
  config: PipelineConfig,
): PipelinePorts {
  return {
    resolver: registries.resolvers.get(config.resolver),
    impactAnalyzer: registries.impactAnalyzers.get(config.impactAnalyzer),
    generator: registries.generators.get(config.generator),
    store: registries.stores.get(config.store),
    runners: config.runners.map((name) => registries.runners.get(name)),
    reporters: config.reporters.map((name) => registries.reporters.get(name)),
    provisioner: registries.provisioners.get(config.provisioner),
    gate: registries.gates.get(config.gate),
  };
}
