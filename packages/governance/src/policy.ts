/**
 * Policy engine — Layer 3 of the Guardrail (per AgentCore Payments design).
 *
 * Each policy is a pure function: given a payment context, return allow/deny.
 * Compose multiple policies; first deny wins. Allowed rules:
 *
 *   - velocityLimit       (max N payments per window, max $X per window)
 *   - amountThreshold     (deny single payments above $X without approval)
 *   - merchantWhitelist   (only allow known-good recipients)
 *   - merchantBlacklist   (block known-bad recipients)
 *   - walletProviderWhitelist (only allow specific wallets)
 *   - timeOfDay           (only allow during business hours)
 */

import type {
  Money,
  PaymentRequest,
  Session,
  UserId,
  WalletProviderId,
} from "@openagentpay/core";

// ============================================================================
//  Types
// ============================================================================

export interface PolicyEvaluationContext {
  readonly userId: UserId;
  readonly walletProvider: WalletProviderId;
  readonly request: PaymentRequest;
  readonly session: Session;
  readonly recentPayments: ReadonlyArray<RecentPaymentRecord>;
  readonly now: number; // unix ms
}

export interface RecentPaymentRecord {
  readonly timestamp: number; // unix ms
  readonly amount: Money;
  readonly recipient: string;
  readonly walletProvider: WalletProviderId;
  readonly success: boolean;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly policyName: string;
  readonly reason?: string;
  /** Severity for downstream logging — info/warn/critical. */
  readonly severity?: "info" | "warn" | "critical";
}

/** A policy is a pure function returning a decision. */
export type Policy = (ctx: PolicyEvaluationContext) => PolicyDecision;

// ============================================================================
//  Built-in policies
// ============================================================================

/**
 * Velocity limit: deny if N payments in the last `windowMs` exceed `maxCount`,
 * or if total atomic spend in window exceeds `maxAmountAtomic`.
 */
export function velocityLimit(opts: {
  readonly windowMs: number;
  readonly maxCount?: number;
  readonly maxAmountAtomic?: string; // bigint as string
  readonly currency?: string; // default USDC
}): Policy {
  const name = `velocityLimit(${opts.windowMs}ms,maxCount=${opts.maxCount},maxAmount=${opts.maxAmountAtomic})`;
  return (ctx) => {
    const cutoff = ctx.now - opts.windowMs;
    const inWindow = ctx.recentPayments.filter(
      (p) =>
        p.timestamp >= cutoff &&
        p.success &&
        (opts.currency ? p.amount.currency === opts.currency : true)
    );
    if (opts.maxCount != null && inWindow.length >= opts.maxCount) {
      return {
        allowed: false,
        policyName: name,
        reason: `${inWindow.length} payments in last ${opts.windowMs}ms exceeds maxCount=${opts.maxCount}`,
        severity: "warn",
      };
    }
    if (opts.maxAmountAtomic != null) {
      const totalAtomic = inWindow.reduce(
        (acc, p) => acc + BigInt(p.amount.amountAtomic),
        BigInt(0)
      );
      const incoming = BigInt(ctx.request.amount.amountAtomic);
      if (totalAtomic + incoming > BigInt(opts.maxAmountAtomic)) {
        return {
          allowed: false,
          policyName: name,
          reason: `total spend (${totalAtomic} + incoming ${incoming}) would exceed cap ${opts.maxAmountAtomic}`,
          severity: "warn",
        };
      }
    }
    return { allowed: true, policyName: name };
  };
}

/** Single-payment amount threshold: deny if amount exceeds `maxAtomic`. */
export function amountThreshold(opts: {
  readonly maxAtomic: string;
  readonly currency?: string;
}): Policy {
  const name = `amountThreshold(${opts.maxAtomic})`;
  return (ctx) => {
    if (opts.currency && ctx.request.amount.currency !== opts.currency) {
      return { allowed: true, policyName: name }; // doesn't apply
    }
    if (BigInt(ctx.request.amount.amountAtomic) > BigInt(opts.maxAtomic)) {
      return {
        allowed: false,
        policyName: name,
        reason: `amount ${ctx.request.amount.amountAtomic} exceeds maxAtomic ${opts.maxAtomic}`,
        severity: "warn",
      };
    }
    return { allowed: true, policyName: name };
  };
}

/** Whitelist mode: deny unless recipient is in the allowed set. */
export function merchantWhitelist(addresses: ReadonlyArray<string>): Policy {
  const allowed = new Set(addresses.map((a) => a.toLowerCase()));
  const name = `merchantWhitelist(${allowed.size} entries)`;
  return (ctx) => {
    if (allowed.has(ctx.request.recipient.toLowerCase())) {
      return { allowed: true, policyName: name };
    }
    return {
      allowed: false,
      policyName: name,
      reason: `recipient ${ctx.request.recipient} not in whitelist`,
      severity: "warn",
    };
  };
}

/** Blacklist mode: deny if recipient is in the blocked set. */
export function merchantBlacklist(addresses: ReadonlyArray<string>): Policy {
  const blocked = new Set(addresses.map((a) => a.toLowerCase()));
  const name = `merchantBlacklist(${blocked.size} entries)`;
  return (ctx) => {
    if (blocked.has(ctx.request.recipient.toLowerCase())) {
      return {
        allowed: false,
        policyName: name,
        reason: `recipient ${ctx.request.recipient} is blacklisted`,
        severity: "critical",
      };
    }
    return { allowed: true, policyName: name };
  };
}

/** Restrict which wallet providers can be used. */
export function walletProviderWhitelist(
  providers: ReadonlyArray<WalletProviderId>
): Policy {
  const allowed = new Set(providers);
  const name = `walletProviderWhitelist(${[...allowed].join(",")})`;
  return (ctx) => {
    if (allowed.has(ctx.walletProvider)) {
      return { allowed: true, policyName: name };
    }
    return {
      allowed: false,
      policyName: name,
      reason: `wallet provider ${ctx.walletProvider} not in whitelist`,
      severity: "warn",
    };
  };
}

/**
 * Time-of-day restriction: only allow during specified hours (UTC).
 * Hour is 0-23. `[9, 18]` = 9am to 6pm UTC inclusive.
 */
export function timeOfDay(opts: {
  readonly startHourUtc: number;
  readonly endHourUtc: number;
}): Policy {
  const name = `timeOfDay(${opts.startHourUtc}-${opts.endHourUtc} UTC)`;
  return (ctx) => {
    const hour = new Date(ctx.now).getUTCHours();
    if (hour >= opts.startHourUtc && hour <= opts.endHourUtc) {
      return { allowed: true, policyName: name };
    }
    return {
      allowed: false,
      policyName: name,
      reason: `current UTC hour ${hour} outside window ${opts.startHourUtc}-${opts.endHourUtc}`,
      severity: "info",
    };
  };
}

// ============================================================================
//  PolicyEngine
// ============================================================================

export interface PolicyEngine {
  /** Add a policy to the chain. */
  use(policy: Policy): void;

  /** List all registered policies (for diagnostics / UI). */
  list(): ReadonlyArray<{ readonly name: string }>;

  /**
   * Evaluate every policy. Returns the first deny, or { allowed: true } if all pass.
   * All decisions are returned in `evaluations` for audit logging.
   */
  evaluate(ctx: PolicyEvaluationContext): {
    readonly allowed: boolean;
    readonly denyReason?: string;
    readonly denyPolicyName?: string;
    readonly evaluations: ReadonlyArray<PolicyDecision>;
  };
}

export class InMemoryPolicyEngine implements PolicyEngine {
  private readonly policies: Policy[] = [];

  use(policy: Policy): void {
    this.policies.push(policy);
  }

  list(): ReadonlyArray<{ readonly name: string }> {
    // Each policy carries its name in the closure — invoke a no-op evaluation
    // on a sentinel context to extract the name. We use a more robust pattern:
    // wrap the policy and capture its name. For simplicity here, we expose a
    // dummy evaluation against a minimal context so name shows up.
    return this.policies.map((p) => {
      const dummy: PolicyEvaluationContext = {
        userId: "_introspect" as UserId,
        walletProvider: "_introspect" as WalletProviderId,
        request: {
          protocol: "_introspect" as any,
          amount: { amountAtomic: "0", decimals: 0, currency: "_" },
          recipient: "_",
          asset: { symbol: "_", decimals: 0 },
          validAfter: 0,
          validBefore: 0,
          nonce: "_",
          rawPayload: {},
        } as PaymentRequest,
        session: {} as Session,
        recentPayments: [],
        now: 0,
      };
      try {
        const d = p(dummy);
        return { name: d.policyName };
      } catch {
        return { name: "unknown" };
      }
    });
  }

  evaluate(ctx: PolicyEvaluationContext): {
    readonly allowed: boolean;
    readonly denyReason?: string;
    readonly denyPolicyName?: string;
    readonly evaluations: ReadonlyArray<PolicyDecision>;
  } {
    const evaluations: PolicyDecision[] = [];
    for (const p of this.policies) {
      const decision = p(ctx);
      evaluations.push(decision);
      if (!decision.allowed) {
        return {
          allowed: false,
          ...(decision.reason !== undefined ? { denyReason: decision.reason } : {}),
          denyPolicyName: decision.policyName,
          evaluations,
        };
      }
    }
    return { allowed: true, evaluations };
  }
}
