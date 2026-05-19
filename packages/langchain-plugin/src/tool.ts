/**
 * OpenAgentPayTool — a LangChain `Tool` that lets an Agent autonomously
 * make a payment via OpenAgentPay's PaymentManager.
 *
 * Pipeline per call:
 *   1. (lazy) ensure or create a PaymentSession with caller's userId
 *   2. Build a PaymentRequest from { amountUsd, recipient, reason }
 *   3. Run governance preCheck if configured (Layer 3 + 5)
 *   4. Call manager.processPayment (signs + settles)
 *   5. Record success/failure with governance.recordSuccess/recordFailure
 *   6. Format result for the LLM (success + txHash + explorer, or failure reason)
 *
 * The tool returns a JSON string back to the LLM. The string is structured
 * (not free-form prose) so subsequent agent reasoning can parse it.
 */

import { StructuredTool } from "@langchain/core/tools";
import type { CallbackManagerForToolRun } from "@langchain/core/callbacks/manager";
import { z } from "zod";

import type {
  InstrumentId,
  PaymentRequest,
  ProtocolId,
  SessionId,
  WalletProviderId,
  Money,
} from "@openagentpay/core";

import {
  defaultAsset,
  defaultMoney,
  defaultNonce,
  DEFAULT_BUDGET_USD,
  DEFAULT_EXPIRY_MIN,
  type CreatePaymentToolConfig,
  type PaymentToolInput,
  type PaymentToolResult,
} from "./types.js";

const inputSchema = z.object({
  amountUsd: z
    .number()
    .positive()
    .describe(
      "Amount to pay in USD (we settle in USDC by default). Must be positive."
    ),
  recipient: z
    .string()
    .min(1)
    .describe(
      "Recipient address. EVM 0x... for x402 chains, or merchant id for CEX-Pay."
    ),
  reason: z
    .string()
    .min(1)
    .describe(
      "Short human-readable reason for the payment (e.g., 'Buy market analysis report from API X'). Logged to audit."
    ),
  walletProvider: z
    .string()
    .optional()
    .describe(
      "Optional wallet provider to use (e.g., 'coinbase-cdp', 'hashkey-chain'). Defaults to the agent's configured default wallet."
    ),
});

/** zod schema input type — what the tool's `_call` actually receives. */
type ToolInput = z.infer<typeof inputSchema>;

const TOOL_DESCRIPTION = `Make an autonomous payment from the agent's wallet via OpenAgentPay.

Use this tool when:
  - You encounter an HTTP 402 (Payment Required) response from an API
  - A user explicitly authorizes you to pay for a service
  - You need to buy access to a paid resource within your budget

Returns JSON:
  { "success": true,  "txHash": "0x...", "explorerUrl": "...", ... }   on success
  { "success": false, "errorCode": "policy_denied" | "rpc_error" | ..., "errorMessage": "..." }   on failure

The payment is enforced by a 7-layer Guardrail (Session budget, Policy
rules, On-chain immutability, Compliance/sanctions, Identity, Audit).
You CANNOT bypass these — the framework will deny payments that exceed
your session budget, hit rate limits, or target sanctioned addresses.`.trim();

/**
 * StructuredTool subclass — works with OpenAI Functions, Anthropic tools,
 * and any LangChain agent that accepts StructuredTool[].
 */
export class OpenAgentPayTool extends StructuredTool<typeof inputSchema> {
  readonly name = "openagentpay_pay";
  readonly description = TOOL_DESCRIPTION;
  readonly schema = inputSchema;

  // Ensure-once session handle (lazy)
  private cachedSessionId: SessionId | null = null;

  constructor(public readonly cfg: CreatePaymentToolConfig) {
    super();
    if (cfg.sharedSessionId) {
      this.cachedSessionId = cfg.sharedSessionId;
    }
  }

  /**
   * Lazily create a session if not already created. Returns sessionId.
   * Rebuilds (and warns) if previous session expired.
   */
  private async ensureSession(): Promise<SessionId> {
    if (this.cachedSessionId) {
      // Reuse if not expired
      const existing = await this.cfg.manager.getPaymentSession(
        this.cachedSessionId
      );
      if (existing && new Date(existing.expiresAt).getTime() > (this.cfg.now ?? Date.now)()) {
        return this.cachedSessionId;
      }
      // expired or gone — fall through to create
    }
    const session = await this.cfg.manager.createPaymentSession({
      userId: this.cfg.userId,
      budgetUsd: this.cfg.defaultSessionBudgetUsd ?? DEFAULT_BUDGET_USD,
      expiresMinutes: this.cfg.defaultSessionExpiryMinutes ?? DEFAULT_EXPIRY_MIN,
    });
    this.cachedSessionId = session.id;
    return session.id;
  }

  /**
   * Run a payment. Always returns a JSON string (LangChain ergonomics).
   *
   * The 2nd argument `_runManager` is a LangChain callback manager —
   * we accept it for API compatibility but don't use it.
   */
  protected async _call(
    raw: ToolInput,
    _runManager?: CallbackManagerForToolRun
  ): Promise<string> {
    const input: PaymentToolInput = {
      amountUsd: raw.amountUsd,
      recipient: raw.recipient,
      reason: raw.reason,
      ...(raw.walletProvider ? { walletProvider: raw.walletProvider } : {}),
    };
    const result = await this.runPayment(input);
    return JSON.stringify(result);
  }

  /**
   * Programmatic API — same logic as _call but returns the structured object.
   * Useful for testing without forcing a JSON.parse round-trip.
   */
  async runPayment(input: PaymentToolInput): Promise<PaymentToolResult> {
    const walletProvider = (input.walletProvider ??
      this.cfg.defaultWalletProvider) as WalletProviderId;
    const reason = input.reason;

    try {
      // 1. Ensure session
      const sessionId = await this.ensureSession();
      const session = await this.cfg.manager.getPaymentSession(sessionId);
      if (!session) {
        return errorResult(
          walletProvider,
          input,
          "session_missing",
          `Session ${sessionId} disappeared`
        );
      }

      // 2. Ensure instrument for this wallet
      const instrument = await this.cfg.manager.createPaymentInstrument(
        walletProvider,
        { userId: this.cfg.userId, metadata: { source: "langchain-plugin" } }
      );

      // 3. Build PaymentRequest
      const moneyFn = this.cfg.toMoney ?? defaultMoney;
      const assetFn = this.cfg.toAsset ?? defaultAsset;
      const nonceFn = this.cfg.generateNonce ?? defaultNonce;
      const protocol =
        (this.cfg.resolveProtocolForWallet
          ? await this.cfg.resolveProtocolForWallet(walletProvider)
          : "x402-v1") as ProtocolId;
      const validAfter = 0;
      const validBefore = Math.floor(((this.cfg.now ?? Date.now)()) / 1000) + 600;
      const amount: Money = moneyFn(input.amountUsd);
      const request: PaymentRequest = {
        protocol,
        amount,
        recipient: input.recipient,
        asset: assetFn(),
        validAfter,
        validBefore,
        nonce: nonceFn(),
        rawPayload: { source: "langchain-plugin", reason },
        description: reason,
      };

      // 4. Layer 3 + 5 governance pre-check (optional)
      if (this.cfg.governance) {
        const decision = await this.cfg.governance.preCheck({
          userId: this.cfg.userId,
          walletProvider,
          request,
          session,
          ...(this.cfg.recentPayments
            ? { recentPayments: this.cfg.recentPayments }
            : {}),
        });
        if (!decision.allowed) {
          // governance.preCheck already wrote audit event(s) for the deny
          return errorResult(
            walletProvider,
            input,
            "policy_denied",
            decision.reason ?? "governance denied this payment"
          );
        }
      }

      // 5. Execute payment via manager
      const out = await this.cfg.manager.processPayment({
        sessionId,
        instrumentId: instrument.id as InstrumentId,
        request,
      });

      // 6. Layer 7 audit + recent buffer
      if (out.success && out.settlement.transactionRef) {
        if (this.cfg.governance) {
          await this.cfg.governance.recordSuccess({
            userId: this.cfg.userId,
            walletProvider,
            sessionId,
            instrumentId: instrument.id,
            recipient: input.recipient,
            amountAtomic: amount.amountAtomic,
            currency: amount.currency,
            chain: out.settlement.network,
            txHash: out.settlement.transactionRef,
            metadata: { reason },
          });
        }
        if (this.cfg.recentPayments) {
          this.cfg.recentPayments.push({
            timestamp: (this.cfg.now ?? Date.now)(),
            amount,
            recipient: input.recipient,
            walletProvider,
            success: true,
          });
        }
        const raw = (out.settlement.raw as Record<string, string> | undefined) ?? {};
        return {
          success: true,
          txHash: out.settlement.transactionRef,
          ...(raw["explorerUrl"] !== undefined
            ? { explorerUrl: raw["explorerUrl"] }
            : {}),
          walletProvider,
          amountUsd: input.amountUsd,
          recipient: input.recipient,
        };
      }

      // settlement failure
      if (this.cfg.governance) {
        await this.cfg.governance.recordFailure({
          userId: this.cfg.userId,
          walletProvider,
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
      if (this.cfg.recentPayments) {
        this.cfg.recentPayments.push({
          timestamp: (this.cfg.now ?? Date.now)(),
          amount,
          recipient: input.recipient,
          walletProvider,
          success: false,
        });
      }
      return errorResult(
        walletProvider,
        input,
        out.settlement.errorCode ?? "unknown_error",
        out.settlement.errorMessage ?? "settlement failed"
      );
    } catch (err) {
      const e = err as Error;
      return errorResult(
        walletProvider,
        input,
        "internal_error",
        e.message ?? "internal error"
      );
    }
  }

  /** Test-only: peek at internal session id state. */
  __getCachedSessionId(): SessionId | null {
    return this.cachedSessionId;
  }

  /** Test-only: clear cached session (e.g., simulate cold start). */
  __resetCachedSession(): void {
    this.cachedSessionId = null;
  }
}

function errorResult(
  walletProvider: WalletProviderId,
  input: PaymentToolInput,
  code: string,
  message: string
): PaymentToolResult {
  return {
    success: false,
    walletProvider,
    amountUsd: input.amountUsd,
    recipient: input.recipient,
    errorCode: code,
    errorMessage: message,
  };
}

/** Factory function — preferred public API. */
export function createPaymentTool(
  cfg: CreatePaymentToolConfig
): OpenAgentPayTool {
  return new OpenAgentPayTool(cfg);
}
