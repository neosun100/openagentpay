/**
 * Lambda-shaped handlers — pure async functions that take a parsed request and
 * return a structured response. Used by the local Express server (server.ts)
 * and wrapped by API Gateway / Lambda Function URL handlers.
 *
 * Path D Hybrid: every handler now accepts an optional `walletProvider`
 * parameter (passed from the UI dropdown) and routes to the right connector
 * bundle. Defaults to ctx.defaultProvider (HashKey) for backwards compat.
 *
 * Routes:
 *   GET  /api/wallet?walletProvider=...        → wallet status
 *   POST /api/session                          → createPaymentSession
 *   POST /api/pay         (body has walletProvider) → processPayment
 *   GET  /api/session/:id                      → getPaymentSession
 *   GET  /api/wallets                          → list available wallets
 *
 * @license Apache-2.0
 */

import {
  type InstrumentId,
  type Money,
  type PaymentRequest,
  type SessionId,
  type UserId,
  type ProtocolId,
} from "@openagentpay/core";
import { type InMemoryPaymentManager } from "@openagentpay/core";

import {
  context,
  getBundle,
  type AppContext,
  type ConnectorBundle,
} from "./context.js";

// ============================================================================
//  Common types
// ============================================================================

export interface ApiError {
  readonly code: string;
  readonly message: string;
}

// ============================================================================
//  GET /api/wallets — list all available wallet providers
// ============================================================================

export interface WalletListEntry {
  readonly walletProvider: string;
  readonly displayName: string;
  readonly chainName: string;
  readonly chainId: number;
  readonly tokenLabel: string;
  readonly tokenAddress: string;
  readonly agentAddress: string;
}

export async function listWallets(
  ctx: AppContext = context()
): Promise<{
  readonly wallets: readonly WalletListEntry[];
  readonly defaultProvider: string;
}> {
  const wallets: WalletListEntry[] = [];
  for (const b of ctx.connectors.values()) {
    wallets.push({
      walletProvider: b.walletProvider,
      displayName: b.displayName,
      chainName: b.chainName,
      chainId: b.chainId,
      tokenLabel: b.tokenLabel,
      tokenAddress: b.tokenAddress,
      agentAddress: b.agentAddress,
    });
  }
  return { wallets, defaultProvider: ctx.defaultProvider };
}

// ============================================================================
//  GET /api/wallet?walletProvider=...
// ============================================================================

export interface WalletStatus {
  readonly address: string;
  readonly addressExplorer: string;
  readonly network: string;
  readonly chainId: number;
  readonly token: string;
  readonly tokenAddress: string;
  readonly tokenLabel: string;
  readonly tokenExplorer: string;
  readonly decimals: number;
  readonly balance: number;
  readonly balanceRaw: string;
  readonly instrumentId: string;
  readonly walletProvider: string;
  readonly displayName: string;
}

export async function getWalletStatus(
  walletProvider: string | undefined,
  ctx: AppContext = context()
): Promise<WalletStatus> {
  const bundle = getBundle(ctx, walletProvider);
  const userId = ctx.demoUserId;
  const instrument = await ctx.manager.createPaymentInstrument(
    bundle.walletProvider,
    { userId }
  );
  const balance = await bundle.connector.getBalance(instrument.id);
  const decimals = balance.money.decimals;
  const balanceRaw = balance.money.amountAtomic;
  const balanceFloat = Number(balanceRaw) / 10 ** decimals;
  return {
    address: bundle.agentAddress,
    addressExplorer: bundle.addressExplorer(bundle.agentAddress),
    network: bundle.chainName,
    chainId: bundle.chainId,
    token: balance.money.currency,
    tokenAddress: bundle.tokenAddress,
    tokenLabel: bundle.tokenLabel,
    tokenExplorer: bundle.addressExplorer(bundle.tokenAddress),
    decimals,
    balance: balanceFloat,
    balanceRaw,
    instrumentId: instrument.id,
    walletProvider: instrument.walletProvider,
    displayName: bundle.displayName,
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
  readonly recipient?: string;
  readonly walletProvider?: string;
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
  readonly walletProvider: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
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

/** Generate a throwaway recipient EOA on the fly (using the bundle's connector). */
function generateRecipient(bundle: ConnectorBundle): string {
  const c = bundle.connector as any;
  if (typeof c.generateNonce === "function") {
    const nonce = c.generateNonce();
    return ("0x" + nonce.slice(2, 42)) as `0x${string}`;
  }
  // Fallback: random
  const rnd = new Uint8Array(20);
  crypto.getRandomValues(rnd);
  return ("0x" +
    Array.from(rnd)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")) as `0x${string}`;
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
  const bundle = getBundle(ctx, body.walletProvider);
  const userId = ctx.demoUserId;
  const instrument = await ctx.manager.createPaymentInstrument(
    bundle.walletProvider,
    { userId }
  );
  const decimals = bundle.tokenDecimals;
  const amountAtomic = BigInt(
    Math.round(body.amountUsdc * 10 ** decimals)
  ).toString();
  const recipient = body.recipient ?? generateRecipient(bundle);
  const validBefore = Math.floor(Date.now() / 1000) + 600;
  const amount: Money = {
    amountAtomic,
    decimals,
    currency: "USDC",
  };

  // Both connectors advertise the same protocol id (x402-v1)
  const protocol = bundle.connector
    .getCapabilities()
    .supportedProtocols[0] as ProtocolId;

  const c = bundle.connector as any;
  const nonce =
    typeof c.generateNonce === "function"
      ? c.generateNonce()
      : "0x" + Array.from({ length: 64 }, () => "0").join("");

  const request: PaymentRequest = {
    protocol,
    amount,
    recipient,
    asset: { symbol: "USDC", decimals },
    validAfter: 0,
    validBefore,
    nonce,
    rawPayload: { source: "demo-api", walletProvider: bundle.walletProvider },
    description: `OpenAgentPay micropayment (${body.amountUsdc} USDC on ${bundle.chainName})`,
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
      payer: bundle.agentAddress,
      recipient,
      network: result.settlement.network,
      walletProvider: bundle.walletProvider,
      ...(result.settlement.errorCode !== undefined
        ? { errorCode: result.settlement.errorCode }
        : {}),
      ...(result.settlement.errorMessage !== undefined
        ? { errorMessage: result.settlement.errorMessage }
        : {}),
      paymentPayload: extractPayload(result.signed!, bundle),
      verifyResult: { isValid: false, payer: bundle.agentAddress },
      settleResult: {
        success: false,
        transaction: "",
        network: result.settlement.network,
        payer: bundle.agentAddress,
      },
    };
  }
  const tx = result.settlement.transactionRef;
  const explorer = bundle.txExplorer(tx);
  const raw = result.settlement.raw as Record<string, string> | undefined;
  return {
    success: true,
    txHash: tx,
    explorerUrl: explorer,
    amountUsdc: body.amountUsdc,
    amountAtomic,
    payer: bundle.agentAddress,
    recipient,
    network: result.settlement.network,
    walletProvider: bundle.walletProvider,
    paymentPayload: extractPayload(result.signed!, bundle),
    verifyResult: { isValid: true, payer: bundle.agentAddress },
    settleResult: {
      success: true,
      transaction: tx,
      network: result.settlement.network,
      payer: bundle.agentAddress,
      ...(raw?.["blockNumber"] !== undefined
        ? { blockNumber: raw["blockNumber"] }
        : {}),
      ...(raw?.["gasUsed"] !== undefined
        ? { gasUsed: raw["gasUsed"] }
        : {}),
    },
  };
}

// ============================================================================
//  Helpers
// ============================================================================

/**
 * Extract on-wire payment payload from `signed.extra`.
 *
 * Two shapes supported:
 *   - HashKey: signed.extra = { signed: { authorization, signature, v, r, s, chainId, verifyingContract } }
 *   - Coinbase CDP: signed.extra = { chainId, verifyingContract, v, r, s }
 *     + outer signed has `request` (with auth fields) and `signature`
 */
function extractPayload(
  signed: NonNullable<
    Awaited<ReturnType<InMemoryPaymentManager["processPayment"]>>["signed"]
  >,
  bundle: ConnectorBundle
): PayResponse["paymentPayload"] {
  const e = (signed.extra ?? {}) as Record<string, unknown>;

  // HashKey shape: extra.signed.{ authorization, signature, v, r, s, chainId, verifyingContract }
  const hkWire = e["signed"] as
    | {
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
      }
    | undefined;
  if (hkWire) {
    return {
      chainId: hkWire.chainId,
      verifyingContract: hkWire.verifyingContract,
      authorization: {
        from: hkWire.authorization.from,
        to: hkWire.authorization.to,
        value: hkWire.authorization.value,
        validAfter: hkWire.authorization.validAfter,
        validBefore: hkWire.authorization.validBefore,
        nonce: hkWire.authorization.nonce,
      },
      signature: hkWire.signature,
      v: hkWire.v,
      r: hkWire.r,
      s: hkWire.s,
    };
  }

  // CDP shape: outer { request, signature, signer, extra: { chainId, vc, v, r, s } }
  const chainId = (e["chainId"] as number) ?? bundle.chainId;
  const verifyingContract =
    (e["verifyingContract"] as string) ?? bundle.tokenAddress;
  const v = (e["v"] as number) ?? 0;
  const r = (e["r"] as string) ?? "0x";
  const s = (e["s"] as string) ?? "0x";
  return {
    chainId,
    verifyingContract,
    authorization: {
      from: signed.signer,
      to: signed.request.recipient,
      value: signed.request.amount.amountAtomic,
      validAfter: signed.request.validAfter,
      validBefore: signed.request.validBefore,
      nonce: signed.request.nonce,
    },
    signature: signed.signature,
    v,
    r,
    s,
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
