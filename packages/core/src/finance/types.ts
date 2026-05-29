/**
 * Financial primitives missing from v0.x — Receipt / Refund / Subscription /
 * Idempotency / FxOracle / PaymentSponsor.
 *
 * These types extend the core PaymentManager surface with the semantics every
 * production payment system needs:
 *
 *   - Receipt           — merchant-attested record of a settled payment
 *   - RefundRequest     — initiate a refund of a prior payment
 *   - Subscription      — pre-paid credit ledger / recurring billing
 *   - IdempotencyKey    — client-supplied dedupe key with TTL
 *   - FxQuote           — multi-asset / multi-currency conversion
 *   - PaymentSponsor    — gas paymaster / facilitator (decoupled role)
 *
 * Every type uses the same atomic-string Money representation as core/types.ts
 * — no float drift across the API.
 *
 * @license Apache-2.0
 */

import type {
  Money,
  SessionId,
  TransactionRef,
  UserId,
  WalletProviderId,
} from "../types.js";

// ============================================================================
//  Receipt — what a merchant signs after settlement
// ============================================================================

export interface Receipt {
  /** Globally unique receipt id (urn:uuid:... preferred). */
  readonly id: string;
  /** Original payment session this receipt belongs to. */
  readonly sessionId: SessionId;
  /** Settlement transaction reference (tx hash / order id / paymentIntent id). */
  readonly transactionRef: TransactionRef;
  /** ISO 8601. Set by merchant at receipt issuance. */
  readonly issuedAt: string;
  /** Merchant identity (DID / domain / on-chain address). */
  readonly merchant: string;
  /** Itemized lines — drives accounting / VAT integrations. */
  readonly lineItems: ReadonlyArray<ReceiptLineItem>;
  /** Total — must equal sum of lineItems.amount. */
  readonly total: Money;
  /** Settlement network (base-sepolia / hashkey-testnet / binance-pay-sandbox). */
  readonly network: string;
  /** Merchant signature over the canonical JSON. Optional but recommended. */
  readonly signature?: ReceiptSignature;
  /** Free-form merchant-private metadata (order id, customer id, etc). */
  readonly metadata?: Record<string, string>;
}

export interface ReceiptLineItem {
  readonly sku: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly amount: Money;
  /** Optional VAT / sales tax breakdown. */
  readonly tax?: Money;
}

export interface ReceiptSignature {
  /** Signature suite — match AP2's `MandateProof.type`. */
  readonly type:
    | "EcdsaSecp256k1Signature2019"
    | "Ed25519Signature2020"
    | "JsonWebSignature2020"
    | "HMAC-SHA256";
  readonly created: string;
  readonly verificationMethod: string;
  readonly proofValue: string;
}

// ============================================================================
//  Refund — undo a prior settlement
// ============================================================================

export interface RefundRequest {
  /** Original transactionRef being refunded. */
  readonly originalTransactionRef: TransactionRef;
  /** How much to refund — must be ≤ original amount. */
  readonly amount: Money;
  /** Reason — surfaces in audit log. */
  readonly reason:
    | "duplicate"
    | "fraudulent"
    | "merchant_error"
    | "customer_request"
    | "agent_error"
    | "other";
  readonly initiatedBy: UserId;
  /** Optional human-readable note. */
  readonly note?: string;
  /** Idempotency key — duplicate (originalTransactionRef, refundIdemKey)
   *  pairs become no-ops returning the existing refund. */
  readonly idempotencyKey?: string;
}

export interface RefundResult {
  readonly success: boolean;
  /** New transactionRef of the refund settlement. */
  readonly refundTransactionRef?: TransactionRef;
  readonly refundedAmount?: Money;
  readonly settledAt?: string;
  readonly errorCode?:
    | "not_supported"
    | "exceeds_original"
    | "already_refunded"
    | "original_not_found"
    | "rpc_error"
    | "rate_limited"
    | "compliance_blocked"
    | "unknown";
  readonly errorMessage?: string;
}

/** Pluggable refund executor — wallet/protocol-specific. */
export interface RefundExecutor {
  refund(req: RefundRequest): Promise<RefundResult>;
}

// ============================================================================
//  Subscription — credit ledger for prepaid agent services
// ============================================================================

export interface Subscription {
  readonly id: string;
  readonly userId: UserId;
  readonly walletProvider: WalletProviderId;
  readonly plan: SubscriptionPlan;
  /** Atomic credit balance — burned per call. */
  readonly creditsRemainingAtomic: string;
  readonly creditsTotalAtomic: string;
  readonly creditDecimals: number;
  readonly creditCurrency: string;
  readonly status: "active" | "paused" | "expired" | "cancelled";
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly metadata?: Record<string, string>;
}

export interface SubscriptionPlan {
  readonly id: string;
  readonly name: string;
  readonly priceUsd: number;
  readonly creditsAtomic: string;
  readonly creditDecimals: number;
  readonly periodDays: number;
  /** If true, balance auto-tops-up at period rollover. */
  readonly autoRenew: boolean;
}

export interface BurnCreditsInput {
  readonly subscriptionId: string;
  readonly amountAtomic: string;
  readonly reason: string;
  readonly idempotencyKey?: string;
}

export interface BurnCreditsResult {
  readonly success: boolean;
  readonly creditsRemainingAtomic: string;
  readonly errorCode?:
    | "insufficient_credits"
    | "subscription_expired"
    | "subscription_paused"
    | "subscription_not_found"
    | "unknown";
}

// ============================================================================
//  Idempotency — defense against duplicate retries
// ============================================================================

export interface IdempotencyEntry {
  /** Client-supplied key — typically request.nonce or `<userId>:<requestHash>`. */
  readonly key: string;
  /** ISO 8601. */
  readonly seenAt: string;
  readonly expiresAt: string;
  /** Cached response — replayed on retry. */
  readonly cachedResult?: unknown;
}

export interface IdempotencyStore {
  /** Returns existing entry if present and not expired. */
  get(key: string): Promise<IdempotencyEntry | undefined>;
  /** Insert with TTL. Throws if `key` already exists (use replace for upsert). */
  put(entry: IdempotencyEntry): Promise<void>;
  /** Upsert / replace existing. */
  replace(entry: IdempotencyEntry): Promise<void>;
}

/** In-memory implementation for tests / single-instance dev. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly store = new Map<string, IdempotencyEntry>();

  async get(key: string): Promise<IdempotencyEntry | undefined> {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (new Date(e.expiresAt).getTime() < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async put(entry: IdempotencyEntry): Promise<void> {
    if (this.store.has(entry.key)) {
      throw new Error(`idempotency: key already seen: ${entry.key}`);
    }
    this.store.set(entry.key, entry);
  }

  async replace(entry: IdempotencyEntry): Promise<void> {
    this.store.set(entry.key, entry);
  }
}

// ============================================================================
//  FxOracle — multi-currency / multi-asset conversion
// ============================================================================

export interface FxQuote {
  readonly base: string;
  readonly quote: string;
  /** Exchange rate as a decimal string (e.g., "1.0023"). */
  readonly rate: string;
  /** Expiry — quotes are short-lived. */
  readonly expiresAt: string;
  /** Source — for audit ("chainlink" / "coinbase" / "binance" / "manual"). */
  readonly source: string;
}

export interface FxOracle {
  /** Get a fresh quote for `base` → `quote`. */
  quote(base: string, quote: string): Promise<FxQuote>;
  /** Convert atomic units. base/quote decimals are looked up internally. */
  convert(
    amount: Money,
    targetCurrency: string,
    targetDecimals: number
  ): Promise<Money>;
}

/**
 * Static FxOracle — returns hard-coded rates. Useful for tests or for
 * stablecoin-only deployments where USDC=USDT=USD=1.0.
 */
export class StaticFxOracle implements FxOracle {
  constructor(
    private readonly rates: ReadonlyMap<string, string>,
    private readonly source: string = "static",
    private readonly ttlMs: number = 60_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Compose key as `${base}:${quote}` (case-insensitive). */
  private rateOf(base: string, quote: string): string {
    if (base.toUpperCase() === quote.toUpperCase()) return "1";
    const direct = this.rates.get(`${base}:${quote}`.toUpperCase());
    if (direct) return direct;
    const inverse = this.rates.get(`${quote}:${base}`.toUpperCase());
    if (inverse) {
      const n = Number(inverse);
      if (Number.isFinite(n) && n !== 0) return (1 / n).toString();
    }
    throw new Error(`StaticFxOracle: no rate for ${base}→${quote}`);
  }

  async quote(base: string, quote: string): Promise<FxQuote> {
    const rate = this.rateOf(base, quote);
    return {
      base,
      quote,
      rate,
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      source: this.source,
    };
  }

  async convert(
    amount: Money,
    targetCurrency: string,
    targetDecimals: number
  ): Promise<Money> {
    const q = await this.quote(amount.currency, targetCurrency);
    const rate = Number(q.rate);
    if (!Number.isFinite(rate)) throw new Error(`bad rate: ${q.rate}`);
    const baseAtomic = Number(BigInt(amount.amountAtomic));
    const baseValue = baseAtomic / Math.pow(10, amount.decimals);
    const quoteValue = baseValue * rate;
    const quoteAtomic = Math.round(quoteValue * Math.pow(10, targetDecimals));
    return {
      amountAtomic: BigInt(quoteAtomic).toString(),
      decimals: targetDecimals,
      currency: targetCurrency,
    };
  }
}

// ============================================================================
//  PaymentSponsor — gas paymaster / facilitator role
// ============================================================================

/**
 * Decouples "who signs the authorization" from "who pays gas / who broadcasts".
 *
 * Today most of our wallet connectors collapse the two roles (the agent's EOA
 * pays gas + broadcasts). Production deployments split them:
 *
 *   - Agent signs EIP-712 (no gas, no chain access)
 *   - PaymentSponsor broadcasts via its own wallet, pays gas, possibly
 *     consuming a daily sponsorship budget
 *
 * This is the model behind Pimlico, Circle Gas Station, Coinbase x402
 * facilitators. We make it pluggable.
 */
export interface PaymentSponsor {
  readonly name: string;
  /**
   * Submit an already-signed authorization. Returns the broadcast tx ref.
   * The sponsor pays gas / takes any fee out of its own wallet.
   */
  broadcast(input: {
    readonly signedPayload: unknown;
    readonly chain: string;
    readonly walletProvider: WalletProviderId;
  }): Promise<{ readonly transactionRef: TransactionRef; readonly settledAt: string }>;
  /** Optional: report sponsor's remaining budget. */
  budget?(): Promise<{ remainingUsd: number; spentTodayUsd: number }>;
}
