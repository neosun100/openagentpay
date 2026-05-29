/**
 * Per-agent policy bundle — different agents get different policy stacks.
 *
 * Wraps a map of agentId → PolicyEngine. Use case:
 *   - "research-bot" gets $50/day, US business hours
 *   - "trading-bot" gets $5000/day, 24h, allows specific DEXes
 *   - "support-bot" gets $1/payment, unlimited frequency
 *
 * Compatible with existing GovernanceManager — just construct one PolicyEngine
 * per agentId and dispatch to the right one.
 *
 * @license Apache-2.0
 */

import type {
  PolicyEngine,
  PolicyEvaluationContext,
  Policy,
} from "../policy.js";
import { InMemoryPolicyEngine } from "../policy.js";

// ============================================================================
//  Types
// ============================================================================

export interface PerAgentPolicyBundle {
  readonly agentId: string;
  readonly description?: string;
  readonly policies: ReadonlyArray<Policy>;
}

export interface PerAgentPolicyEngineConfig {
  /** Bundles keyed by agent id. */
  readonly bundles: ReadonlyArray<PerAgentPolicyBundle>;
  /** Fallback bundle when no specific agentId matches. */
  readonly defaultPolicies?: ReadonlyArray<Policy>;
  /** How to read agentId from a context. Default: ctx.session.metadata.agentId. */
  readonly extractAgentId?: (ctx: PolicyEvaluationContext) => string | undefined;
}

// ============================================================================
//  PerAgentPolicyEngine
// ============================================================================

export class PerAgentPolicyEngine implements PolicyEngine {
  private readonly engines: ReadonlyMap<string, InMemoryPolicyEngine>;
  private readonly defaultEngine: InMemoryPolicyEngine;
  private readonly extract: (ctx: PolicyEvaluationContext) => string | undefined;

  constructor(config: PerAgentPolicyEngineConfig) {
    const map = new Map<string, InMemoryPolicyEngine>();
    for (const b of config.bundles) {
      const eng = new InMemoryPolicyEngine();
      for (const p of b.policies) eng.use(p);
      map.set(b.agentId, eng);
    }
    this.engines = map;
    this.defaultEngine = new InMemoryPolicyEngine();
    for (const p of config.defaultPolicies ?? []) this.defaultEngine.use(p);
    this.extract = config.extractAgentId ?? defaultExtract;
  }

  evaluate(ctx: PolicyEvaluationContext): ReturnType<PolicyEngine["evaluate"]> {
    const agentId = this.extract(ctx);
    const eng = (agentId && this.engines.get(agentId)) || this.defaultEngine;
    return eng.evaluate(ctx);
  }

  /** Aggregate list across all bundles + default — for diagnostics UI. */
  list(): ReadonlyArray<{ readonly name: string }> {
    const all: Array<{ name: string }> = [];
    for (const [agentId, eng] of this.engines) {
      for (const p of eng.list()) all.push({ name: `${agentId}:${p.name}` });
    }
    for (const p of this.defaultEngine.list()) all.push({ name: `default:${p.name}` });
    return all;
  }

  /** Required by PolicyEngine — but not meaningful in per-agent mode. */
  use(_policy: Policy): void {
    // No-op — policies must be provided up front via bundles.
    // Keeping this method makes it interchangeable with InMemoryPolicyEngine.
  }
}

function defaultExtract(ctx: PolicyEvaluationContext): string | undefined {
  const m = ctx.session.metadata;
  if (m && typeof m["agentId"] === "string") return m["agentId"];
  return undefined;
}
