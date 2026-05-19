/**
 * Types and helpers used internally — not all are re-exported from index.ts.
 */
import type {
  Money,
  PaymentManager,
  Session,
  SessionId,
  UserId,
  WalletProviderId,
} from "@openagentpay/core";
import type { GovernanceManager, RecentPaymentRecord } from "@openagentpay/governance";

/**
 * What the LangChain agent will see as the tool's `_call` arguments.
 *
 * Kept intentionally minimal so the LLM doesn't have to fight the schema:
 *   - amountUsd : how much (in USDC dollars)
 *   - recipient : who gets paid (chain address or merchant id)
 *   - reason    : human-readable note (auditable)
 *
 * walletProvider can be omitted — we'll fall back to the configured default.
 */
export interface PaymentToolInput {
  readonly amountUsd: number;
  readonly recipient: string;
  readonly reason: string;
  readonly walletProvider?: string;
}

export interface PaymentToolResult {
  readonly success: boolean;
  readonly txHash?: string;
  readonly explorerUrl?: string;
  readonly walletProvider: string;
  readonly amountUsd: number;
  readonly recipient: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly auditEventId?: string;
}

/**
 * Per-tool configuration. Most fields have sensible defaults so basic
 * usage is one-liner: `createPaymentTool({ manager, defaultBudgetUsd: 5 })`.
 */
export interface CreatePaymentToolConfig {
  /** PaymentManager instance — handles instrument creation + sign + settle. */
  readonly manager: PaymentManager;
  /** Optional governance — runs Layer 3+5 pre-checks + Layer 7 audit. */
  readonly governance?: GovernanceManager;
  /** User identity — propagates to audit log. */
  readonly userId: UserId;
  /** Wallet provider to use when caller doesn't specify. */
  readonly defaultWalletProvider: WalletProviderId;
  /** Default budget for auto-created sessions (USD). Defaults to $5. */
  readonly defaultSessionBudgetUsd?: number;
  /** Default session TTL in minutes. Defaults to 30. */
  readonly defaultSessionExpiryMinutes?: number;
  /**
   * Optional pre-existing session id — if provided, all calls share this
   * session's budget. If absent, a new session is created on first call.
   */
  readonly sharedSessionId?: SessionId;
  /**
   * Hook to convert amountUsd to Money — defaults to USDC with 6 decimals.
   * Override for non-USDC quotes.
   */
  readonly toMoney?: (amountUsd: number) => Money;
  /**
   * Recent-payments buffer for velocity policies. The plugin will append
   * to this; can be shared across multiple tools.
   */
  readonly recentPayments?: RecentPaymentRecord[];
  /**
   * Async-IO chain context. PaymentRequest.protocol comes from this map
   * (each wallet's connector reports a protocol it speaks).
   */
  readonly resolveProtocolForWallet?: (
    walletProvider: WalletProviderId
  ) => string | Promise<string>;
  /**
   * Hook to generate the EIP-3009 nonce. Defaults to crypto.getRandomValues.
   */
  readonly generateNonce?: () => string;
  /** Hook to build a per-call recipient asset descriptor. Default: USDC. */
  readonly toAsset?: () => { readonly symbol: string; readonly decimals: number };
  /** Override clock for tests. */
  readonly now?: () => number;
}

export const DEFAULT_BUDGET_USD = 5;
export const DEFAULT_EXPIRY_MIN = 30;

export function defaultMoney(amountUsd: number): Money {
  // USDC default — 6 decimals
  const atomic = BigInt(Math.round(amountUsd * 1_000_000)).toString();
  return { amountAtomic: atomic, decimals: 6, currency: "USDC" };
}

export function defaultAsset() {
  return { symbol: "USDC", decimals: 6 } as const;
}

export function defaultNonce(): string {
  const bytes = new Uint8Array(32);
  // Both Node and browsers expose globalThis.crypto.getRandomValues
  globalThis.crypto.getRandomValues(bytes);
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Lightweight session reference held by the tool */
export interface SessionHandle {
  readonly id: SessionId;
  readonly budget: Money;
  /** Snapshot — re-read on every call in case manager mutates externally. */
  readonly snapshot: Session;
}
