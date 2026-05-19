/**
 * @openagentpay/governance — Spending Controls, Compliance, Audit
 *
 * Inspired by AWS Bedrock AgentCore Payments' 7-layer Guardrail design:
 *
 *   Layer 1: Authorization      (out of scope — handled by upstream auth)
 *   Layer 2: Session            (already in @openagentpay/core SessionManager)
 *   Layer 3: Policy             ← THIS PACKAGE — velocity/merchant/amount rules
 *   Layer 4: On-chain           (already in wallet connectors via EIP-3009)
 *   Layer 5: Compliance         ← THIS PACKAGE — sanctions/OFAC checks
 *   Layer 6: Identity           (already via AWS Secrets Manager + KMS)
 *   Layer 7: Audit              ← THIS PACKAGE — append-only audit log
 *
 * @license Apache-2.0
 */

// Policy engine
export { InMemoryPolicyEngine } from "./policy.js";
export type {
  Policy,
  PolicyDecision,
  PolicyEngine,
  PolicyEvaluationContext,
  RecentPaymentRecord,
} from "./policy.js";

// Built-in policies (functions, not types)
export {
  velocityLimit,
  amountThreshold,
  merchantWhitelist,
  merchantBlacklist,
  walletProviderWhitelist,
  timeOfDay,
} from "./policy.js";

// Compliance
export {
  StaticSanctionsChecker,
  CompositeComplianceChecker,
  DEMO_SANCTIONS_LIST,
} from "./compliance.js";
export type {
  ComplianceChecker,
  ComplianceCheckResult,
  SanctionsList,
} from "./compliance.js";

// Audit
export {
  AuditLogger,
  InMemoryAuditSink,
  ConsoleAuditSink,
} from "./audit.js";
export type { AuditEvent, AuditEventKind, AuditSink } from "./audit.js";

// Top-level facade
export { GovernanceManager } from "./manager.js";
export type {
  GovernanceConfig,
  PreCheckInput,
  PreCheckResult,
} from "./manager.js";
