/**
 * BinancePayConnector
 * ====================
 *
 * Implements {@link WalletConnector} for Binance Pay merchants.
 *
 * Responsibilities (mapped to the WalletConnector 5-method contract):
 *   1. getCapabilities()      — pure self-report
 *   2. createInstrument()     — bind a user to this merchant account
 *   3. getBalance()           — query Binance Pay merchant balance
 *   4. signAuthorization()    — produce an OAP-CEX wire token (HMAC SHA512)
 *   5. settle()               — submit the order via /v3/order, return tx ref
 *
 * Storage of (userId → instrumentId) is delegated to an InstrumentStore
 * implementation (DynamoDB in production, in-memory map in tests).
 *
 * @license Apache-2.0
 */

import { createHmac } from "node:crypto";
import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type ProtocolId,
  type SettlementResult,
  type SignAuthorizationInput,
  type SignedAuthorization,
  type TransactionRef,
  type UserId,
  type WalletCapabilities,
  type WalletConnector,
  type WalletProviderId,
} from "@openagentpay/core";
import {
  type OapCexWireToken,
  encodeWireToken,
  PROTOCOL_ID as OAP_CEX_PROTOCOL_ID,
} from "@openagentpay/protocol-cex-pay";

import {
  BinancePayClient,
  type BinancePayClientConfig,
} from "./binance-client.js";

// ============================================================================
//  Configuration
// ============================================================================

export const WALLET_PROVIDER_ID = "binance-pay" as WalletProviderId;

export interface BinancePayConnectorConfig
  extends Pick<BinancePayClientConfig, "apiKey" | "apiSecret" | "baseUrl" | "timeoutMs" | "fetchFn"> {
  /** Merchant ID assigned by Binance — appears as the recipient. */
  readonly merchantId: string;
  /**
   * Storage adapter for (userId → Instrument) bindings. In Lambda use a
   * DynamoDB-backed implementation; in tests use {@link MemoryInstrumentStore}.
   */
  readonly instrumentStore: InstrumentStore;
  /**
   * Optional clock — overridable for deterministic tests.
   */
  readonly now?: () => number;
}

// ============================================================================
//  InstrumentStore — minimal interface so we don't bind to DDB at this layer
// ============================================================================

export interface InstrumentStore {
  get(userId: UserId): Promise<Instrument | undefined>;
  put(instrument: Instrument): Promise<void>;
  getById(instrumentId: InstrumentId): Promise<Instrument | undefined>;
}

/** Pure in-memory store. For tests and local dev. */
export class MemoryInstrumentStore implements InstrumentStore {
  private readonly byUser = new Map<string, Instrument>();
  private readonly byId = new Map<string, Instrument>();
  async get(userId: UserId): Promise<Instrument | undefined> {
    return this.byUser.get(userId);
  }
  async put(instrument: Instrument): Promise<void> {
    this.byUser.set(instrument.userId, instrument);
    this.byId.set(instrument.id, instrument);
  }
  async getById(id: InstrumentId): Promise<Instrument | undefined> {
    return this.byId.get(id);
  }
}

// ============================================================================
//  Connector
// ============================================================================

/** Stable, well-known OAP-CEX protocol id for Binance Pay flows. */
const PROTOCOL_FOR_BINANCE: ProtocolId = OAP_CEX_PROTOCOL_ID;

const SUPPORTED_ASSETS: readonly Asset[] = [
  { symbol: "USDT", decimals: 6 },
  { symbol: "USDC", decimals: 6 },
  { symbol: "BUSD", decimals: 18 },
  { symbol: "BNB", decimals: 18 },
];

export class BinancePayConnector implements WalletConnector {
  private readonly client: BinancePayClient;
  private readonly store: InstrumentStore;
  private readonly merchantId: string;
  private readonly now: () => number;

  constructor(private readonly config: BinancePayConnectorConfig) {
    this.client = new BinancePayClient(config);
    this.store = config.instrumentStore;
    this.merchantId = config.merchantId;
    this.now = config.now ?? Date.now;
  }

  // ---- WalletConnector contract -------------------------------------------

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: WALLET_PROVIDER_ID,
      displayName: "Binance Pay",
      supportedAssets: SUPPORTED_ASSETS,
      supportedProtocols: [PROTOCOL_FOR_BINANCE],
      requiresUserApproval: false, // API-key based, fully autonomous
      settlesOnChain: false, // CEX-internal, off-chain settlement
      typicalLatencyMs: 800, // empirical: ~500-1200ms via /v3/order
      features: {
        gasFree: true,
        instantSettlement: true,
        sandboxAvailable: true,
      },
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    // Idempotent: same userId → same instrument
    const existing = await this.store.get(input.userId);
    if (existing) return existing;

    const id = this.makeInstrumentId(input.userId);
    const instrument: Instrument = {
      id,
      userId: input.userId,
      walletProvider: WALLET_PROVIDER_ID,
      publicHandle: this.merchantId, // for Binance Pay, instrument == merchant binding
      createdAt: nowIso(this.now()),
      providerMetadata: {
        merchantId: this.merchantId,
        ...input.metadata,
      },
    };
    await this.store.put(instrument);
    return instrument;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    const instrument = await this.requireInstrument(instrumentId);
    const r = await this.client.queryBalance({ asset: "USDT" });
    const usdt = r.balances.find((b) => b.asset === "USDT");
    const free = usdt?.free ?? "0";
    // free is "19.95800000" (major units) — convert to atomic
    const decimals = 6;
    const atomicAtomic = toAtomic(free, decimals);
    return {
      instrumentId: instrument.id,
      asset: { symbol: "USDT", decimals },
      money: {
        amountAtomic: atomicAtomic,
        decimals,
        currency: "USDT",
      },
      fetchedAt: nowIso(this.now()),
    };
  }

  /**
   * Sign an OAP-CEX authorization for a payment request. Produces the wire
   * token that goes in X-PAYMENT-CEX header — the actual Binance Pay
   * `/v3/order` call happens in {@link settle}.
   */
  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    const instrument = await this.requireInstrument(input.instrumentId);
    if (input.request.protocol !== PROTOCOL_FOR_BINANCE) {
      throw new Error(
        `BinancePayConnector only supports protocol ${PROTOCOL_FOR_BINANCE}, got ${input.request.protocol}`
      );
    }

    const signedAt = Math.floor(this.now() / 1000);

    // Build canonical authorization string (deterministic for HMAC)
    const authPayload = {
      asset: input.request.asset.symbol,
      amount: input.request.amount.amountAtomic,
      amountDecimals: input.request.amount.decimals,
      from: instrument.publicHandle, // our merchantId acts as buyer in this MVP
      to: input.request.recipient,
      nonce: input.request.nonce,
      validBefore: input.request.validBefore,
      signedAt,
    };

    // Sign canonical JSON with merchant API secret (HMAC SHA512)
    const canonical = JSON.stringify(authPayload);
    const signatureValue = createHmac("sha512", this.config.apiSecret)
      .update(canonical)
      .digest("hex")
      .toUpperCase();

    const wireToken: OapCexWireToken = {
      oapCexVersion: 1,
      scheme: "cex-pay",
      provider: "binance-pay",
      authorization: authPayload,
      signature: { alg: "HMAC-SHA512", value: signatureValue },
    };

    return {
      request: input.request,
      signer: instrument.publicHandle,
      signature: signatureValue,
      encoded: encodeWireToken(wireToken),
      extra: { wireToken },
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    const wireToken = (signed.extra?.["wireToken"] ?? null) as OapCexWireToken | null;
    if (!wireToken) {
      return failure("missing wire token in signed.extra", "signature_invalid");
    }

    const merchantTradeNo = `oap_${wireToken.authorization.nonce.slice(2, 18)}_${Math.floor(this.now() / 1000)}`;
    const orderAmount = atomicToMajor(
      wireToken.authorization.amount,
      wireToken.authorization.amountDecimals
    );

    try {
      const order = await this.client.createOrder({
        merchantTradeNo,
        orderAmount,
        currency: wireToken.authorization.asset,
        goods: {
          goodsType: "02",
          goodsCategory: "D000",
          referenceGoodsId: wireToken.authorization.nonce.slice(0, 32),
          goodsName: "OpenAgentPay micropayment",
          goodsDetail: signed.request.description ?? "agent payment",
        },
      });

      return {
        success: true,
        transactionRef: order.prepayId as TransactionRef,
        network: this.isSandbox() ? "binance-pay-sandbox" : "binance-pay",
        settledAt: nowIso(this.now()),
        settledAmount: signed.request.amount,
        raw: order.raw,
      };
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string; httpStatus?: number; raw?: unknown };
      return {
        success: false,
        network: this.isSandbox() ? "binance-pay-sandbox" : "binance-pay",
        settledAt: nowIso(this.now()),
        errorCode: mapBinanceErrorToCode(e.code),
        errorMessage: e.message ?? "binance-pay settlement error",
        raw: e.raw,
      };
    }
  }

  // ---- internals -----------------------------------------------------------

  private async requireInstrument(id: InstrumentId): Promise<Instrument> {
    const i = await this.store.getById(id);
    if (!i) {
      throw new Error(`Instrument not found: ${id}`);
    }
    return i;
  }

  private makeInstrumentId(userId: UserId): InstrumentId {
    const hash = createHmac("sha256", this.merchantId).update(userId).digest("hex").slice(0, 16);
    return `payment-instrument-bnpay-${hash}` as InstrumentId;
  }

  private isSandbox(): boolean {
    // Binance Pay doesn't have a separate host; sandbox is a property of the
    // merchant account. We surface the flag via env in the smoke script and
    // surface it here for telemetry only.
    return (process.env["BINANCE_PAY_SANDBOX"] ?? "true").toLowerCase() === "true";
  }
}

// ============================================================================
//  helpers
// ============================================================================

function nowIso(t: number): string {
  return new Date(t).toISOString();
}

/** "19.95800000", 6 → "19958000" (atomic, stringified bigint) */
function toAtomic(major: string, decimals: number): string {
  const [whole = "0", frac = ""] = major.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

/** "1000", 6 → "0.001000" */
function atomicToMajor(atomic: string, decimals: number): string {
  if (decimals === 0) return atomic;
  const padded = atomic.padStart(decimals + 1, "0");
  const cut = padded.length - decimals;
  return `${padded.slice(0, cut)}.${padded.slice(cut)}`;
}

function failure(
  msg: string,
  errorCode: NonNullable<SettlementResult["errorCode"]>
): SettlementResult {
  return {
    success: false,
    network: "binance-pay-sandbox",
    settledAt: new Date().toISOString(),
    errorMessage: msg,
    errorCode,
  };
}

function mapBinanceErrorToCode(
  code?: string
): NonNullable<SettlementResult["errorCode"]> {
  switch (code) {
    case "auth":
      return "signature_invalid";
    case "rate_limited":
      return "rate_limited";
    case "validation":
      return "expired_authorization";
    case "network":
    case "timeout":
      return "rpc_error";
    case "not_found":
      return "unknown";
    default:
      return "unknown";
  }
}

// also expose helpers for unit testing
export const __internal = { toAtomic, atomicToMajor };
