/**
 * GovernanceManager — high-level facade that wires PolicyEngine + ComplianceChecker + AuditLogger.
 *
 * Used by PaymentManager (or by the demo-api directly) before processing a
 * payment to enforce all guardrails in one call:
 *
 *     const decision = await governance.preCheck({
 *       userId, walletProvider, request, session, recentPayments
 *     });
 *     if (!decision.allowed) return reject(decision.reason);
 *     // ... proceed with sign + settle ...
 *     await governance.recordSuccess({ ..., txHash });
 *
 * Every call produces an audit event regardless of allow/deny outcome.
 */

import type {
  PaymentRequest,
  Session,
  UserId,
  WalletProviderId,
} from "@openagentpay/core";

import type { ComplianceChecker, ComplianceCheckResult } from "./compliance.js";
import type {
  PolicyEngine,
  PolicyEvaluationContext,
  RecentPaymentRecord,
} from "./policy.js";
import { AuditLogger, type AuditSink } from "./audit.js";

export interface GovernanceConfig {
  readonly policyEngine: PolicyEngine;
  readonly complianceChecker?: ComplianceChecker;
  readonly auditSink: AuditSink;
  readonly now?: () => number;
}

export interface PreCheckInput {
  readonly userId: UserId;
  readonly walletProvider: WalletProviderId;
  readonly request: PaymentRequest;
  readonly session: Session;
  readonly recentPayments?: ReadonlyArray<RecentPaymentRecord>;
}

export interface PreCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly denyPolicyName?: string;
  readonly complianceMatches?: ComplianceCheckResult["matches"];
}

export class GovernanceManager {
  private readonly logger: AuditLogger;
  private readonly now: () => number;

  constructor(private readonly config: GovernanceConfig) {
    this.now = config.now ?? (() => Date.now());
    this.logger = new AuditLogger(config.auditSink, this.now);
  }

  /** Run all pre-payment checks (Layer 3 + 5). Records audit events. */
  async preCheck(input: PreCheckInput): Promise<PreCheckResult> {
    const ctx: PolicyEvaluationContext = {
      userId: input.userId,
      walletProvider: input.walletProvider,
      request: input.request,
      session: input.session,
      recentPayments: input.recentPayments ?? [],
      now: this.now(),
    };

    // Layer 3: Policy
    const policyResult = this.config.policyEngine.evaluate(ctx);
    await this.logger.emit({
      kind: "policy_check",
      actor: input.userId,
      walletProvider: input.walletProvider,
      sessionId: input.session.id,
      recipient: input.request.recipient,
      amountAtomic: input.request.amount.amountAtomic,
      currency: input.request.amount.currency,
      result: policyResult.allowed ? "allowed" : "denied",
      ...(policyResult.denyReason !== undefined
        ? { reason: policyResult.denyReason }
        : {}),
      policyEvaluations: policyResult.evaluations,
    });

    if (!policyResult.allowed) {
      return {
        allowed: false,
        ...(policyResult.denyReason !== undefined
          ? { reason: policyResult.denyReason }
          : {}),
        ...(policyResult.denyPolicyName !== undefined
          ? { denyPolicyName: policyResult.denyPolicyName }
          : {}),
      };
    }

    // Layer 5: Compliance
    if (this.config.complianceChecker) {
      const compliance = await this.config.complianceChecker.check(
        input.request.recipient
      );
      await this.logger.emit({
        kind: "compliance_check",
        actor: input.userId,
        walletProvider: input.walletProvider,
        sessionId: input.session.id,
        recipient: input.request.recipient,
        result: compliance.cleared ? "allowed" : "denied",
        complianceCheck: compliance,
        ...(compliance.cleared
          ? {}
          : {
              reason: `${compliance.matches.length} sanctions match(es): ${compliance.matches
                .map((m) => m.source)
                .join(", ")}`,
            }),
      });

      if (!compliance.cleared) {
        return {
          allowed: false,
          reason: `compliance check failed: ${compliance.matches
            .map((m) => m.reason)
            .join("; ")}`,
          complianceMatches: compliance.matches,
        };
      }
    }

    return { allowed: true };
  }

  /** Layer 7: log a successful payment outcome. */
  async recordSuccess(input: {
    readonly userId: UserId;
    readonly walletProvider: WalletProviderId;
    readonly sessionId: string;
    readonly instrumentId?: string;
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly currency: string;
    readonly chain: string;
    readonly txHash?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.logger.emit({
      kind: "payment_success",
      actor: input.userId,
      walletProvider: input.walletProvider,
      sessionId: input.sessionId,
      ...(input.instrumentId !== undefined
        ? { instrumentId: input.instrumentId }
        : {}),
      recipient: input.recipient,
      amountAtomic: input.amountAtomic,
      currency: input.currency,
      chain: input.chain,
      ...(input.txHash !== undefined ? { txHash: input.txHash } : {}),
      result: "succeeded",
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
  }

  /** Layer 7: log a failed payment outcome. */
  async recordFailure(input: {
    readonly userId: UserId;
    readonly walletProvider: WalletProviderId;
    readonly sessionId: string;
    readonly instrumentId?: string;
    readonly recipient: string;
    readonly amountAtomic: string;
    readonly currency: string;
    readonly chain: string;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  }): Promise<void> {
    await this.logger.emit({
      kind: "payment_failure",
      actor: input.userId,
      walletProvider: input.walletProvider,
      sessionId: input.sessionId,
      ...(input.instrumentId !== undefined
        ? { instrumentId: input.instrumentId }
        : {}),
      recipient: input.recipient,
      amountAtomic: input.amountAtomic,
      currency: input.currency,
      chain: input.chain,
      result: "failed",
      ...(input.errorMessage !== undefined
        ? { reason: `[${input.errorCode ?? "unknown"}] ${input.errorMessage}` }
        : {}),
    });
  }
}
