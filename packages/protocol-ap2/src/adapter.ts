/**
 * @openagentpay/protocol-ap2 — Google AP2 Protocol Adapter
 * =========================================================
 *
 * Implements ProtocolAdapter for AP2 mandate envelopes. Compose with x402,
 * OAP-CEX, or any future settlement protocol — AP2 is an authorization
 * layer, not a settlement layer.
 *
 * @license Apache-2.0
 */

import {
  type HttpResponse402,
  type HttpRetryEnvelope,
  type Mandate,
  type Money,
  type PaymentRequest,
  ProtocolError,
  type ProtocolAdapter,
  type ProtocolId,
  type SignedAuthorization,
  type IntentMandateClaims,
  type CartMandateClaims,
  type PaymentMandateClaims,
} from "@openagentpay/core";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "ap2-v0.1" as ProtocolId;
export const X_PAYMENT_AP2_HEADER = "X-PAYMENT-AP2";
export const SUPPORTED_AP2_VERSIONS = ["0.1"] as const;

// ============================================================================
//  Wire shape (AP2 envelope on top of any 402 body)
// ============================================================================

export interface Ap2402Body {
  readonly ap2Version: string;
  /** Ordered chain: Intent → Cart → Payment. */
  readonly mandates: readonly Mandate[];
  /**
   * Optional inline settlement instructions when the merchant wants to
   * commit to a specific protocol. If absent, agent uses the
   * settlementProtocol field from the Payment Mandate claims.
   */
  readonly settlement?: {
    readonly protocol: ProtocolId;
    readonly payload: Record<string, unknown>;
  };
}

// ============================================================================
//  Pluggable signature verifier
// ============================================================================

/**
 * Verifies a single Mandate.proof. Implementations:
 *  - `NullMandateVerifier` (default — accepts any structurally valid proof)
 *  - W3C VC verifier (production — Ed25519/JWS/secp256k1)
 *  - DID-based verifier (resolves issuer DID)
 */
export interface MandateVerifier {
  readonly name: string;
  verify(mandate: Mandate): Promise<{
    readonly valid: boolean;
    readonly reason?: string;
  }>;
}

export class NullMandateVerifier implements MandateVerifier {
  readonly name = "NullMandateVerifier";
  async verify(_m: Mandate): Promise<{ valid: boolean }> {
    return { valid: true };
  }
}

// ============================================================================
//  Adapter config
// ============================================================================

export interface Ap2ProtocolAdapterConfig {
  /** Optional crypto verifier — default: structural-only NullVerifier. */
  readonly verifier?: MandateVerifier;
  /** Allowed inner settlement protocols — denylist the unsupported ones. */
  readonly allowedSettlementProtocols?: readonly ProtocolId[];
  /** Override clock for tests. */
  readonly now?: () => number;
}

// ============================================================================
//  Adapter implementation
// ============================================================================

export class Ap2ProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly verifier: MandateVerifier;
  private readonly allowedSettlement: ReadonlySet<string> | undefined;
  private readonly now: () => number;

  constructor(config: Ap2ProtocolAdapterConfig = {}) {
    this.verifier = config.verifier ?? new NullMandateVerifier();
    this.allowedSettlement = config.allowedSettlementProtocols
      ? new Set(config.allowedSettlementProtocols)
      : undefined;
    this.now = config.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  //  ProtocolAdapter contract
  // -------------------------------------------------------------------------

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    const v = body["ap2Version"];
    return typeof v === "string" && SUPPORTED_AP2_VERSIONS.includes(v as "0.1");
  }

  async parsePaymentRequired(
    response: HttpResponse402
  ): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);
    const chain = this.assertMandateChain(body.mandates);
    const paymentMandate = chain.payment;
    const cartMandate = chain.cart;
    const claims = paymentMandate.credentialSubject.mandate as PaymentMandateClaims;
    const cartClaims = cartMandate.credentialSubject.mandate as CartMandateClaims;

    if (
      this.allowedSettlement &&
      !this.allowedSettlement.has(claims.settlementProtocol)
    ) {
      throw new ProtocolError(
        `Settlement protocol ${claims.settlementProtocol} not in allow-list`,
        "unsupported_scheme"
      );
    }

    // Verify each mandate proof (best-effort — null verifier is structural-only)
    for (const m of body.mandates) {
      const v = await this.verifier.verify(m);
      if (!v.valid) {
        throw new ProtocolError(
          `Mandate ${m.id} failed verification: ${v.reason ?? "unknown"}`,
          "malformed"
        );
      }
    }

    // Recipient + nonce must come from the inline settlement payload —
    // it's the inner protocol's responsibility to define those.
    const settlementPayload = body.settlement?.payload ?? claims.settlementPayload;
    const recipient = (settlementPayload["recipient"] ??
      settlementPayload["to"] ??
      "") as string;
    if (!recipient) {
      throw new ProtocolError(
        "AP2 Payment Mandate has no settlement recipient — settlementPayload must include `recipient` or `to`",
        "missing_field"
      );
    }
    const nonce =
      (settlementPayload["nonce"] as string | undefined) ??
      ("0x" + bytesToHex(randomBytes(32)));
    const validBefore =
      (settlementPayload["validBefore"] as number | undefined) ??
      Math.floor(this.now() / 1000) + 600;

    const amount: Money = {
      amountAtomic: cartClaims.totalAtomic,
      decimals: cartClaims.decimals,
      currency: cartClaims.currency,
    };

    return {
      protocol: claims.settlementProtocol, // ⚠️ inner settlement, not "ap2-v0.1"
      amount,
      recipient,
      asset: { symbol: cartClaims.currency, decimals: cartClaims.decimals },
      validAfter: 0,
      validBefore,
      nonce,
      rawPayload: { ap2Body: body, settlementPayload },
      ...(cartClaims.lineItems[0]?.description !== undefined
        ? { description: cartClaims.lineItems[0].description }
        : {}),
      mandates: body.mandates,
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    // The wallet has signed the inner settlement protocol. AP2 just carries
    // the mandates back in the retry header for the merchant to verify.
    const mandates = signed.request.mandates ?? [];
    const wireToken = {
      ap2Version: "0.1",
      mandates,
      settlement: {
        protocol: signed.request.protocol,
        // Pass through whatever the inner adapter put in `signed.encoded`
        encoded: signed.encoded ?? null,
        signature: signed.signature,
      },
    };
    const json = JSON.stringify(wireToken);
    const encoded = base64urlEncode(json);
    return {
      headers: {
        [X_PAYMENT_AP2_HEADER]: encoded,
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  // -------------------------------------------------------------------------
  //  Public utility — verifyMandateChain (used by Compliance + Audit)
  // -------------------------------------------------------------------------

  /**
   * Walk Intent → Cart → Payment Mandate verifying:
   *   - All three present (or Intent omitted for human-present flow)
   *   - Cart.intentMandateId matches Intent.id (when both present)
   *   - Payment.cartMandateId matches Cart.id
   *   - Cart.totalAtomic ≤ Intent.maxAmountAtomic
   *   - Cart.merchant ∈ Intent.allowedMerchants (if specified)
   *   - All mandates within their expirationDate
   *   - All mandates pass MandateVerifier
   */
  async verifyMandateChain(mandates: ReadonlyArray<Mandate>): Promise<{
    readonly valid: boolean;
    readonly reasons: string[];
    readonly chain: ReturnType<Ap2ProtocolAdapter["assertMandateChain"]>;
  }> {
    const reasons: string[] = [];
    let chain: ReturnType<Ap2ProtocolAdapter["assertMandateChain"]>;
    try {
      chain = this.assertMandateChain(mandates);
    } catch (err) {
      return {
        valid: false,
        reasons: [(err as Error).message],
        chain: { intent: undefined as any, cart: undefined as any, payment: undefined as any },
      };
    }

    const nowSec = Math.floor(this.now() / 1000);

    // Expiration check
    for (const m of mandates) {
      if (m.expirationDate) {
        const exp = Math.floor(new Date(m.expirationDate).getTime() / 1000);
        if (exp < nowSec) reasons.push(`Mandate ${m.id} expired at ${m.expirationDate}`);
      }
    }

    // Linkage checks
    if (chain.intent) {
      const intentClaims = chain.intent.credentialSubject.mandate as IntentMandateClaims;
      const cartClaims = chain.cart.credentialSubject.mandate as CartMandateClaims;
      if (cartClaims.intentMandateId !== chain.intent.id) {
        reasons.push(
          `Cart Mandate references intentMandateId ${cartClaims.intentMandateId}, expected ${chain.intent.id}`
        );
      }
      if (BigInt(cartClaims.totalAtomic) > BigInt(intentClaims.maxAmountAtomic)) {
        reasons.push(
          `Cart total ${cartClaims.totalAtomic} exceeds Intent max ${intentClaims.maxAmountAtomic}`
        );
      }
      if (cartClaims.currency !== intentClaims.currency) {
        reasons.push(
          `Cart currency ${cartClaims.currency} differs from Intent ${intentClaims.currency}`
        );
      }
      if (
        intentClaims.allowedMerchants &&
        !intentClaims.allowedMerchants.includes(cartClaims.merchant)
      ) {
        reasons.push(
          `Cart merchant ${cartClaims.merchant} not in Intent allowedMerchants`
        );
      }
    }
    const paymentClaims = chain.payment.credentialSubject.mandate as PaymentMandateClaims;
    if (paymentClaims.cartMandateId !== chain.cart.id) {
      reasons.push(
        `Payment Mandate references cartMandateId ${paymentClaims.cartMandateId}, expected ${chain.cart.id}`
      );
    }

    // Cryptographic verification
    for (const m of mandates) {
      const v = await this.verifier.verify(m);
      if (!v.valid) reasons.push(`Mandate ${m.id} signature invalid: ${v.reason ?? "?"}`);
    }

    return { valid: reasons.length === 0, reasons, chain };
  }

  // -------------------------------------------------------------------------
  //  Internals
  // -------------------------------------------------------------------------

  private assertBody(body: unknown): Ap2402Body {
    if (!isObject(body))
      throw new ProtocolError("AP2 body must be an object", "malformed");
    if (typeof body["ap2Version"] !== "string")
      throw new ProtocolError("AP2 missing ap2Version", "missing_field");
    if (!SUPPORTED_AP2_VERSIONS.includes(body["ap2Version"] as "0.1")) {
      throw new ProtocolError(
        `AP2 version ${body["ap2Version"]} not supported (this adapter speaks ${SUPPORTED_AP2_VERSIONS.join(",")})`,
        "unsupported_version"
      );
    }
    if (!Array.isArray(body["mandates"]) || body["mandates"].length < 2) {
      throw new ProtocolError(
        "AP2 mandates[] must contain at least Cart + Payment Mandate",
        "missing_field"
      );
    }
    return body as unknown as Ap2402Body;
  }

  private assertMandateChain(mandates: ReadonlyArray<Mandate>): {
    readonly intent?: Mandate;
    readonly cart: Mandate;
    readonly payment: Mandate;
  } {
    const byKind = new Map<string, Mandate>();
    for (const m of mandates) {
      if (!isObject(m) || !Array.isArray(m.type) || m.type.length < 2) {
        throw new ProtocolError("Malformed mandate in chain", "malformed");
      }
      const kind = m.type[1];
      byKind.set(kind, m);
    }
    const cart = byKind.get("ap2.CartMandate");
    const payment = byKind.get("ap2.PaymentMandate");
    if (!cart) throw new ProtocolError("Missing CartMandate", "missing_field");
    if (!payment)
      throw new ProtocolError("Missing PaymentMandate", "missing_field");
    const intent = byKind.get("ap2.IntentMandate");
    return intent ? { intent, cart, payment } : { cart, payment };
  }
}

// ============================================================================
//  Helpers
// ============================================================================

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function base64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

// ============================================================================
//  Mandate helpers (factory + validation)
// ============================================================================

/** Build a structurally valid Intent Mandate (proof must be supplied separately). */
export function buildIntentMandate(opts: {
  readonly id: string;
  readonly issuer: string;
  readonly subjectId: string;
  readonly description: string;
  readonly maxAmountAtomic: string;
  readonly currency: string;
  readonly decimals: number;
  readonly issuanceDate: string;
  readonly expirationDate?: string;
  readonly allowedMerchants?: readonly string[];
  readonly maxUses?: number;
  readonly proof: Mandate["proof"];
}): Mandate {
  const claims: IntentMandateClaims = {
    kind: "ap2.IntentMandate",
    description: opts.description,
    maxAmountAtomic: opts.maxAmountAtomic,
    currency: opts.currency,
    decimals: opts.decimals,
    ...(opts.allowedMerchants ? { allowedMerchants: opts.allowedMerchants } : {}),
    ...(opts.maxUses !== undefined ? { maxUses: opts.maxUses } : {}),
  };
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    id: opts.id,
    type: ["VerifiableCredential", "ap2.IntentMandate"],
    issuer: opts.issuer,
    issuanceDate: opts.issuanceDate,
    ...(opts.expirationDate ? { expirationDate: opts.expirationDate } : {}),
    credentialSubject: { id: opts.subjectId, mandate: claims },
    proof: opts.proof,
  };
}

export function buildCartMandate(opts: {
  readonly id: string;
  readonly issuer: string;          // merchant DID/URL
  readonly subjectId: string;
  readonly intentMandateId: string;
  readonly totalAtomic: string;
  readonly currency: string;
  readonly decimals: number;
  readonly merchant: string;
  readonly lineItems: ReadonlyArray<{
    readonly sku: string;
    readonly description: string;
    readonly quantity: number;
    readonly unitPriceAtomic: string;
  }>;
  readonly issuanceDate: string;
  readonly expirationDate?: string;
  readonly proof: Mandate["proof"];
}): Mandate {
  const claims: CartMandateClaims = {
    kind: "ap2.CartMandate",
    intentMandateId: opts.intentMandateId,
    totalAtomic: opts.totalAtomic,
    currency: opts.currency,
    decimals: opts.decimals,
    lineItems: opts.lineItems,
    merchant: opts.merchant,
  };
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    id: opts.id,
    type: ["VerifiableCredential", "ap2.CartMandate"],
    issuer: opts.issuer,
    issuanceDate: opts.issuanceDate,
    ...(opts.expirationDate ? { expirationDate: opts.expirationDate } : {}),
    credentialSubject: { id: opts.subjectId, mandate: claims },
    proof: opts.proof,
  };
}

export function buildPaymentMandate(opts: {
  readonly id: string;
  readonly issuer: string;          // PSP / issuer
  readonly subjectId: string;
  readonly cartMandateId: string;
  readonly settlementProtocol: ProtocolId;
  readonly settlementPayload: Record<string, unknown>;
  readonly presence: PaymentMandateClaims["presence"];
  readonly issuanceDate: string;
  readonly expirationDate?: string;
  readonly proof: Mandate["proof"];
}): Mandate {
  const claims: PaymentMandateClaims = {
    kind: "ap2.PaymentMandate",
    cartMandateId: opts.cartMandateId,
    settlementProtocol: opts.settlementProtocol,
    settlementPayload: opts.settlementPayload,
    presence: opts.presence,
  };
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    id: opts.id,
    type: ["VerifiableCredential", "ap2.PaymentMandate"],
    issuer: opts.issuer,
    issuanceDate: opts.issuanceDate,
    ...(opts.expirationDate ? { expirationDate: opts.expirationDate } : {}),
    credentialSubject: { id: opts.subjectId, mandate: claims },
    proof: opts.proof,
  };
}
