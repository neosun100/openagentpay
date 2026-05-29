/**
 * @openagentpay/llamaindex-plugin
 * ================================
 *
 * LlamaIndex.TS-compatible Tool wrapper for OpenAgentPay's PaymentManager.
 *
 * Design choice: LlamaIndex SDK is an OPTIONAL peer dependency (same pattern
 * as openagentpay-strands). When installed we adapt to FunctionTool; when
 * absent we expose a plain async function with a JSON-schema descriptor that
 * any other framework can also consume.
 *
 * @license Apache-2.0
 */

import type {
  InstrumentId,
  PaymentManager,
  PaymentRequest,
  ProtocolId,
  SessionId,
  UserId,
  WalletProviderId,
  Money,
  Mandate,
} from "@openagentpay/core";
import type {
  GovernanceManager,
  RecentPaymentRecord,
} from "@openagentpay/governance";

// ============================================================================
//  Public types
// ============================================================================

export interface LlamaPaymentToolInput {
  readonly amountUsd: number;
  readonly recipient: string;
  readonly reason: string;
  readonly walletProvider?: string;
  /** Optional AP2 mandate chain to ride along with this payment. */
  readonly mandates?: readonly Mandate[];
}

export interface LlamaPaymentToolResult {
  readonly success: boolean;
  readonly txHash?: string;
  readonly explorerUrl?: string;
  readonly walletProvider: string;
  readonly amountUsd: number;
  readonly recipient: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly hadMandates: boolean;
}

export interface CreateLlamaPaymentToolConfig {
  readonly manager: PaymentManager;
  readonly governance?: GovernanceManager;
  readonly userId: UserId;
  readonly defaultWalletProvider: WalletProviderId;
  readonly defaultSessionBudgetUsd?: number;
  readonly defaultSessionExpiryMinutes?: number;
  readonly sharedSessionId?: SessionId;
  readonly recentPayments?: RecentPaymentRecord[];
  readonly resolveProtocolForWallet?: (
    walletProvider: WalletProviderId
  ) => string | Promise<string>;
  readonly toMoney?: (usd: number) => Money;
  readonly generateNonce?: () => string;
  readonly now?: () => number;
}

const DEFAULT_BUDGET_USD = 5;
const DEFAULT_EXPIRY_MIN = 30;

const DESCRIPTION = `Make an autonomous payment via OpenAgentPay.

Use this when:
  - You hit an HTTP 402 (Payment Required) response
  - The user explicitly authorizes a payment
  - You need to buy access to a paid resource within your budget

Returns a structured result. The 7-Layer Guardrail (session budget, policy
rules, on-chain settlement, sanctions/compliance, identity, audit) enforces
hard limits — denied payments come back with errorCode you can reason about.

Optional: pass an AP2 mandate chain via \`mandates\` to attach W3C VC-style
authorization that travels with the payment for compliance/audit.`.trim();

const PARAMETERS_JSON_SCHEMA = {
  type: "object",
  properties: {
    amountUsd: {
      type: "number",
      description: "Amount in USD (settles in USDC). Must be > 0.",
    },
    recipient: {
      type: "string",
      description: "Recipient (0x… address, merchant id, or DID).",
    },
    reason: {
      type: "string",
      description: "Short human-readable reason — logged to audit trail.",
    },
    walletProvider: {
      type: "string",
      description:
        "Optional override (e.g., 'coinbase-cdp', 'hashkey-chain', 'metamask', 'solana'). Default: agent's configured wallet.",
    },
    mandates: {
      type: "array",
      description:
        "Optional AP2 Verifiable Credential mandates (Intent / Cart / Payment).",
      items: { type: "object" },
    },
  },
  required: ["amountUsd", "recipient", "reason"],
} as const;

// ============================================================================
//  Core implementation — framework-agnostic
// ============================================================================

export class OpenAgentPayLlamaTool {
  readonly name = "openagentpay_pay";
  readonly description = DESCRIPTION;
  readonly parameters = PARAMETERS_JSON_SCHEMA;
  private cachedSessionId: SessionId | null = null;

  constructor(private readonly cfg: CreateLlamaPaymentToolConfig) {
    if (cfg.sharedSessionId) this.cachedSessionId = cfg.sharedSessionId;
  }

  /** LlamaIndex calls this. Returns JSON string for LLM consumption. */
  async call(input: LlamaPaymentToolInput | string): Promise<string> {
    const parsed: LlamaPaymentToolInput =
      typeof input === "string" ? JSON.parse(input) : input;
    return JSON.stringify(await this.runPayment(parsed));
  }

  async runPayment(input: LlamaPaymentToolInput): Promise<LlamaPaymentToolResult> {
    const wallet = (input.walletProvider ?? this.cfg.defaultWalletProvider) as WalletProviderId;
    try {
      const sessionId = await this.ensureSession();
      const session = await this.cfg.manager.getPaymentSession(sessionId);
      if (!session) return this.err(wallet, input, "session_missing", "Session disappeared");

      const instrument = await this.cfg.manager.createPaymentInstrument(wallet, {
        userId: this.cfg.userId,
        metadata: { source: "llamaindex-plugin" },
      });

      const protocol = (await (this.cfg.resolveProtocolForWallet
        ? this.cfg.resolveProtocolForWallet(wallet)
        : "x402-v1")) as ProtocolId;
      const validBefore = Math.floor((this.cfg.now ?? Date.now)() / 1000) + 600;
      const amount: Money = (this.cfg.toMoney ?? defaultMoney)(input.amountUsd);
      const nonce = (this.cfg.generateNonce ?? defaultNonce)();
      const request: PaymentRequest = {
        protocol,
        amount,
        recipient: input.recipient,
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore,
        nonce,
        rawPayload: { source: "llamaindex-plugin", reason: input.reason },
        description: input.reason,
        ...(input.mandates && input.mandates.length > 0
          ? { mandates: input.mandates }
          : {}),
      };

      // Governance preCheck (Layer 3 + 5)
      if (this.cfg.governance) {
        const decision = await this.cfg.governance.preCheck({
          userId: this.cfg.userId,
          walletProvider: wallet,
          request,
          session,
          ...(this.cfg.recentPayments ? { recentPayments: this.cfg.recentPayments } : {}),
        });
        if (!decision.allowed) {
          return this.err(wallet, input, "policy_denied", decision.reason ?? "denied");
        }
      }

      const out = await this.cfg.manager.processPayment({
        sessionId,
        instrumentId: instrument.id as InstrumentId,
        request,
      });

      if (out.success && out.settlement.transactionRef) {
        if (this.cfg.governance) {
          await this.cfg.governance.recordSuccess({
            userId: this.cfg.userId,
            walletProvider: wallet,
            sessionId,
            instrumentId: instrument.id,
            recipient: input.recipient,
            amountAtomic: amount.amountAtomic,
            currency: amount.currency,
            chain: out.settlement.network,
            txHash: out.settlement.transactionRef,
            metadata: {
              reason: input.reason,
              hadMandates: (input.mandates?.length ?? 0) > 0,
            },
          });
        }
        if (this.cfg.recentPayments) {
          this.cfg.recentPayments.push({
            timestamp: (this.cfg.now ?? Date.now)(),
            amount,
            recipient: input.recipient,
            walletProvider: wallet,
            success: true,
          });
        }
        const raw = (out.settlement.raw as Record<string, string> | undefined) ?? {};
        return {
          success: true,
          txHash: out.settlement.transactionRef,
          ...(raw["explorerUrl"] !== undefined ? { explorerUrl: raw["explorerUrl"] } : {}),
          walletProvider: wallet,
          amountUsd: input.amountUsd,
          recipient: input.recipient,
          hadMandates: (input.mandates?.length ?? 0) > 0,
        };
      }

      // settlement failure
      if (this.cfg.governance) {
        await this.cfg.governance.recordFailure({
          userId: this.cfg.userId,
          walletProvider: wallet,
          sessionId,
          instrumentId: instrument.id,
          recipient: input.recipient,
          amountAtomic: amount.amountAtomic,
          currency: amount.currency,
          chain: out.settlement.network,
          ...(out.settlement.errorCode !== undefined
            ? { errorCode: out.settlement.errorCode }
            : {}),
          ...(out.settlement.errorMessage !== undefined
            ? { errorMessage: out.settlement.errorMessage }
            : {}),
        });
      }
      return this.err(
        wallet,
        input,
        out.settlement.errorCode ?? "unknown_error",
        out.settlement.errorMessage ?? "settlement failed"
      );
    } catch (err) {
      return this.err(wallet, input, "internal_error", (err as Error).message);
    }
  }

  private async ensureSession(): Promise<SessionId> {
    if (this.cachedSessionId) {
      const existing = await this.cfg.manager.getPaymentSession(this.cachedSessionId);
      if (
        existing &&
        new Date(existing.expiresAt).getTime() > (this.cfg.now ?? Date.now)()
      ) {
        return this.cachedSessionId;
      }
    }
    const s = await this.cfg.manager.createPaymentSession({
      userId: this.cfg.userId,
      budgetUsd: this.cfg.defaultSessionBudgetUsd ?? DEFAULT_BUDGET_USD,
      expiresMinutes: this.cfg.defaultSessionExpiryMinutes ?? DEFAULT_EXPIRY_MIN,
    });
    this.cachedSessionId = s.id;
    return s.id;
  }

  private err(
    walletProvider: WalletProviderId,
    input: LlamaPaymentToolInput,
    code: string,
    message: string
  ): LlamaPaymentToolResult {
    return {
      success: false,
      walletProvider,
      amountUsd: input.amountUsd,
      recipient: input.recipient,
      errorCode: code,
      errorMessage: message,
      hadMandates: (input.mandates?.length ?? 0) > 0,
    };
  }

  /** Test-only: peek/clear cached session. */
  __getCachedSessionId(): SessionId | null {
    return this.cachedSessionId;
  }
  __resetCachedSession(): void {
    this.cachedSessionId = null;
  }
}

// ============================================================================
//  Defaults
// ============================================================================

function defaultMoney(usd: number): Money {
  const atomic = BigInt(Math.round(usd * 1_000_000)).toString();
  return { amountAtomic: atomic, decimals: 6, currency: "USDC" };
}

function defaultNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Factory — preferred public API. */
export function createLlamaPaymentTool(
  cfg: CreateLlamaPaymentToolConfig
): OpenAgentPayLlamaTool {
  return new OpenAgentPayLlamaTool(cfg);
}
