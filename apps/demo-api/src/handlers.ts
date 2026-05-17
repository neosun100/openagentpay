/**
 * Lambda-shaped handlers — pure async functions that take a parsed request and
 * return a structured response. Used by the local Express server (server.ts)
 * and will be wrapped by API Gateway / Lambda Function URL handlers later.
 *
 * Routes:
 *   GET  /api/wallet                → wallet status (address + balance)
 *   POST /api/session               → createPaymentSession
 *   POST /api/pay                   → processPayment
 *   GET  /api/session/:id           → getPaymentSession
 *
 * @license Apache-2.0
 */

import {
  type InstrumentId,
  type Money,
  type PaymentRequest,
  type SessionId,
  type UserId,
} from "@openagentpay/core";
import {
  HASHKEY_PROTOCOL,
  type HashKeyChainConnector,
  hashkeyChainTestnet,
  txExplorerUrl,
  addressExplorerUrl,
} from "@openagentpay/wallet-hashkey";
import {
  type InMemoryPaymentManager,
} from "@openagentpay/core";

import { context, type AppContext } from "./context.js";

// ============================================================================
//  Common types
// ============================================================================

export interface ApiError {
  readonly code: string;
  readonly message: string;
}

// ============================================================================
//  GET /api/wallet
// ============================================================================

export interface WalletStatus {
  readonly address: string;
  readonly addressExplorer: string;
  readonly network: string;
  readonly chainId: number;
  readonly token: string;
  readonly tokenAddress: string;
  readonly tokenExplorer: string;
  readonly decimals: number;
  readonly balance: number;
  readonly balanceRaw: string;
  readonly instrumentId: string;
  readonly walletProvider: string;
}

export async function getWalletStatus(
  ctx: AppContext = context()
): Promise<WalletStatus> {
  const userId = ctx.demoUserId;
  // Idempotent: repeated GET /api/wallet returns the same instrument
  const instrument = await ctx.manager.createPaymentInstrument(
    ctx.connector.getCapabilities().walletProvider,
    { userId }
  );
  const balance = await ctx.connector.getBalance(instrument.id);
  const decimals = balance.money.decimals;
  const balanceRaw = balance.money.amountAtomic;
  const balanceFloat = Number(balanceRaw) / 10 ** decimals;
  return {
    address: ctx.connector.agentAddress,
    addressExplorer: addressExplorerUrl(hashkeyChainTestnet, ctx.connector.agentAddress),
    network: hashkeyChainTestnet.name,
    chainId: hashkeyChainTestnet.id,
    token: balance.money.currency,
    tokenAddress: ctx.tokenAddress,
    tokenExplorer: addressExplorerUrl(hashkeyChainTestnet, ctx.tokenAddress),
    decimals,
    balance: balanceFloat,
    balanceRaw,
    instrumentId: instrument.id,
    walletProvider: instrument.walletProvider,
  };
}

// ============================================================================
//  POST /api/session
// ============================================================================

export interface CreateSessionBody {
  readonly budgetUsd: number;
  readonly expiryMinutes: number;
}

export interface CreateSessionResponse {
  readonly sessionId: string;
  readonly budgetUsd: number;
  readonly expiryMinutes: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export async function createSession(
  body: CreateSessionBody,
  ctx: AppContext = context()
): Promise<CreateSessionResponse> {
  const userId = ctx.demoUserId;
  if (typeof body.budgetUsd !== "number" || body.budgetUsd <= 0) {
    throw apiError("VALIDATION", "budgetUsd must be a positive number");
  }
  if (
    typeof body.expiryMinutes !== "number" ||
    body.expiryMinutes <= 0 ||
    body.expiryMinutes > 24 * 60
  ) {
    throw apiError("VALIDATION", "expiryMinutes must be between 1 and 1440");
  }
  const session = await ctx.manager.createPaymentSession({
    userId,
    budgetUsd: body.budgetUsd,
    expiresMinutes: body.expiryMinutes,
  });
  return {
    sessionId: session.id,
    budgetUsd: body.budgetUsd,
    expiryMinutes: body.expiryMinutes,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

// ============================================================================
//  GET /api/session/:id
// ============================================================================

export interface SessionStatus {
  readonly sessionId: string;
  readonly status: string;
  readonly budgetAtomic: string;
  readonly spentAtomic: string;
  readonly currency: string;
  readonly decimals: number;
  readonly expiresAt: string;
}

export async function getSession(
  id: SessionId,
  ctx: AppContext = context()
): Promise<SessionStatus | null> {
  const s = await ctx.manager.getPaymentSession(id);
  if (!s) return null;
  return {
    sessionId: s.id,
    status: s.status,
    budgetAtomic: s.budget.amountAtomic,
    spentAtomic: s.spent.amountAtomic,
    currency: s.budget.currency,
    decimals: s.budget.decimals,
    expiresAt: s.expiresAt,
  };
}

// ============================================================================
//  POST /api/pay
// ============================================================================

export interface PayBody {
  readonly sessionId: string;
  readonly amountUsdc: number;
  readonly recipient?: string; // optional override; defaults to throwaway merchant
}

export interface PayResponse {
  readonly success: boolean;
  readonly txHash?: string;
  readonly explorerUrl?: string;
  readonly amountUsdc: number;
  readonly amountAtomic: string;
  readonly payer: string;
  readonly recipient: string;
  readonly network: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  /** Stripped-down payment payload + sig — useful for "what just happened" UI */
  readonly paymentPayload: {
    readonly chainId: number;
    readonly verifyingContract: string;
    readonly authorization: {
      readonly from: string;
      readonly to: string;
      readonly value: string;
      readonly validAfter: number;
      readonly validBefore: number;
      readonly nonce: string;
    };
    readonly signature: string;
    readonly v: number;
    readonly r: string;
    readonly s: string;
  };
  readonly verifyResult: { readonly isValid: boolean; readonly payer: string };
  readonly settleResult: {
    readonly success: boolean;
    readonly transaction: string;
    readonly network: string;
    readonly payer: string;
    readonly blockNumber?: string;
    readonly gasUsed?: string;
  };
}

/** Generate a throwaway recipient EOA on the fly. */
function generateRecipient(connector: HashKeyChainConnector): string {
  // We can't access viem here without making it a peer dep — but the connector
  // already has access. Use a deterministic-but-random nonce-style address
  // so each request sends to a different target.
  const nonce = connector.generateNonce();
  // Use first 40 hex chars of nonce as pseudo-address (fine for testnet demo).
  return ("0x" + nonce.slice(2, 42)) as `0x${string}`;
}

export async function processPayment(
  body: PayBody,
  ctx: AppContext = context()
): Promise<PayResponse> {
  if (typeof body.sessionId !== "string" || !body.sessionId) {
    throw apiError("VALIDATION", "sessionId is required");
  }
  if (typeof body.amountUsdc !== "number" || body.amountUsdc <= 0) {
    throw apiError("VALIDATION", "amountUsdc must be a positive number");
  }
  const userId = ctx.demoUserId;
  const instrument = await ctx.manager.createPaymentInstrument(
    ctx.connector.getCapabilities().walletProvider,
    { userId }
  );
  const decimals = ctx.tokenDecimals;
  const amountAtomic = BigInt(Math.round(body.amountUsdc * 10 ** decimals)).toString();
  const recipient = body.recipient ?? generateRecipient(ctx.connector);
  const validBefore = Math.floor(Date.now() / 1000) + 600;
  const amount: Money = {
    amountAtomic,
    decimals,
    currency: "USDC",
  };
  const request: PaymentRequest = {
    protocol: HASHKEY_PROTOCOL,
    amount,
    recipient,
    asset: { symbol: "USDC", decimals },
    validAfter: 0,
    validBefore,
    nonce: ctx.connector.generateNonce(),
    rawPayload: { source: "demo-api" },
    description: `OpenAgentPay micropayment (${body.amountUsdc} USDC on HashKey Chain Testnet)`,
  };
  const result = await ctx.manager.processPayment({
    sessionId: body.sessionId as SessionId,
    instrumentId: instrument.id as InstrumentId,
    request,
  });

  if (!result.success || !result.settlement.transactionRef) {
    return {
      success: false,
      amountUsdc: body.amountUsdc,
      amountAtomic,
      payer: ctx.connector.agentAddress,
      recipient,
      network: result.settlement.network,
      ...(result.settlement.errorCode !== undefined
        ? { errorCode: result.settlement.errorCode }
        : {}),
      ...(result.settlement.errorMessage !== undefined
        ? { errorMessage: result.settlement.errorMessage }
        : {}),
      paymentPayload: extractPayload(result.signed!),
      verifyResult: { isValid: false, payer: ctx.connector.agentAddress },
      settleResult: {
        success: false,
        transaction: "",
        network: result.settlement.network,
        payer: ctx.connector.agentAddress,
      },
    };
  }
  const tx = result.settlement.transactionRef;
  const explorer = txExplorerUrl(hashkeyChainTestnet, tx);
  const raw = result.settlement.raw as Record<string, string> | undefined;
  return {
    success: true,
    txHash: tx,
    explorerUrl: explorer,
    amountUsdc: body.amountUsdc,
    amountAtomic,
    payer: ctx.connector.agentAddress,
    recipient,
    network: result.settlement.network,
    paymentPayload: extractPayload(result.signed!),
    verifyResult: { isValid: true, payer: ctx.connector.agentAddress },
    settleResult: {
      success: true,
      transaction: tx,
      network: result.settlement.network,
      payer: ctx.connector.agentAddress,
      ...(raw?.["blockNumber"] !== undefined ? { blockNumber: raw["blockNumber"] } : {}),
      ...(raw?.["gasUsed"] !== undefined ? { gasUsed: raw["gasUsed"] } : {}),
    },
  };
}

// ============================================================================
//  Helpers
// ============================================================================

function extractPayload(signed: NonNullable<Awaited<ReturnType<InMemoryPaymentManager["processPayment"]>>["signed"]>): PayResponse["paymentPayload"] {
  const e = signed.extra as Record<string, unknown>;
  const wire = e["signed"] as {
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: number;
      validBefore: number;
      nonce: string;
    };
    signature: string;
    v: number;
    r: string;
    s: string;
    chainId: number;
    verifyingContract: string;
  };
  return {
    chainId: wire.chainId,
    verifyingContract: wire.verifyingContract,
    authorization: {
      from: wire.authorization.from,
      to: wire.authorization.to,
      value: wire.authorization.value,
      validAfter: wire.authorization.validAfter,
      validBefore: wire.authorization.validBefore,
      nonce: wire.authorization.nonce,
    },
    signature: wire.signature,
    v: wire.v,
    r: wire.r,
    s: wire.s,
  };
}

function apiError(code: string, message: string): Error & ApiError {
  const e = new Error(message) as Error & ApiError;
  (e as unknown as Record<string, string>)["code"] = code;
  (e as unknown as Record<string, string>)["message"] = message;
  return e;
}

// Avoid unused import warning
export const _UNUSED_USER_ID: UserId = "demo" as UserId;
