/**
 * @openagentpay/protocol-mpp — Merchant Payments Protocol (Stripe + Tempo)
 * =========================================================================
 *
 * MPP is an IETF-style merchant payment protocol jointly developed by Stripe
 * + Tempo for AI agents to pay merchants in stablecoins. Backward-compatible
 * with x402 (it can carry x402 envelopes inside MPP for chain settlement).
 *
 * Wire format (v0.1):
 *   {
 *     "mppVersion": "0.1",
 *     "merchant": { "id": "...", "name": "...", "rails": ["stablecoin", "card"] },
 *     "amount": { "value": "...", "currency": "USDC", "decimals": 6 },
 *     "settlement": { "rail": "tempo" | "x402" | "card", "details": {...} }
 *   }
 *
 * @license Apache-2.0
 */

import {
  type HttpResponse402,
  type HttpRetryEnvelope,
  type Money,
  type PaymentRequest,
  ProtocolError,
  type ProtocolAdapter,
  type ProtocolId,
  type SignedAuthorization,
} from "@openagentpay/core";

export const PROTOCOL_ID = "mpp-v0.1" as ProtocolId;
export const X_PAYMENT_MPP_HEADER = "X-PAYMENT-MPP";

export type MppRail = "tempo" | "x402" | "card" | "ach";

export interface MppMerchant {
  readonly id: string;
  readonly name: string;
  readonly rails: readonly MppRail[];
}

export interface MppSettlement {
  readonly rail: MppRail;
  readonly details: Record<string, unknown>;
  readonly recipient?: string;
}

export interface Mpp402Body {
  readonly mppVersion: string;
  readonly merchant: MppMerchant;
  readonly amount: { readonly value: string; readonly currency: string; readonly decimals: number };
  readonly settlement: MppSettlement;
  readonly description?: string;
}

export interface MppAdapterConfig {
  readonly preferredRails?: readonly MppRail[];
  readonly trustedMerchants?: readonly string[];
  readonly now?: () => number;
}

export class MppProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly preferredRails: ReadonlySet<MppRail> | undefined;
  private readonly trustedMerchants: ReadonlySet<string> | undefined;
  private readonly now: () => number;

  constructor(cfg: MppAdapterConfig = {}) {
    this.preferredRails = cfg.preferredRails ? new Set(cfg.preferredRails) : undefined;
    this.trustedMerchants = cfg.trustedMerchants ? new Set(cfg.trustedMerchants) : undefined;
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    const v = body["mppVersion"];
    return typeof v === "string" && v.startsWith("0.");
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);
    if (this.preferredRails && !this.preferredRails.has(body.settlement.rail)) {
      throw new ProtocolError(
        `MPP rail '${body.settlement.rail}' not in preferred rails`,
        "unsupported_scheme"
      );
    }
    if (this.trustedMerchants && !this.trustedMerchants.has(body.merchant.id)) {
      throw new ProtocolError(
        `MPP merchant '${body.merchant.id}' not trusted`,
        "unsupported_scheme"
      );
    }
    const amount: Money = {
      amountAtomic: body.amount.value,
      decimals: body.amount.decimals,
      currency: body.amount.currency,
    };
    const recipient =
      body.settlement.recipient ??
      (body.settlement.details["recipient"] as string | undefined) ??
      body.merchant.id;
    const validBefore = Math.floor(this.now() / 1000) + 600;
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient,
      asset: { symbol: body.amount.currency, decimals: body.amount.decimals },
      validAfter: 0,
      validBefore,
      nonce: generateNonce(),
      rawPayload: { mpp: body },
      ...(body.description !== undefined ? { description: body.description } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("MPP retry requires signature", "missing_field");
    }
    const wire = {
      mppVersion: "0.1",
      signer: signed.signer,
      signature: signed.signature,
      encoded: signed.encoded ?? null,
    };
    return {
      headers: {
        [X_PAYMENT_MPP_HEADER]: Buffer.from(JSON.stringify(wire), "utf8").toString("base64url"),
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  private assertBody(body: unknown): Mpp402Body {
    if (!isObject(body)) throw new ProtocolError("MPP body must be object", "malformed");
    const v = body["mppVersion"];
    if (typeof v !== "string") throw new ProtocolError("MPP missing mppVersion", "missing_field");
    if (!v.startsWith("0.")) throw new ProtocolError(`MPP version ${v} not supported`, "unsupported_version");
    if (!isObject(body["merchant"])) throw new ProtocolError("MPP missing merchant block", "missing_field");
    if (!isObject(body["amount"])) throw new ProtocolError("MPP missing amount block", "missing_field");
    if (!isObject(body["settlement"])) throw new ProtocolError("MPP missing settlement block", "missing_field");
    const m = body["merchant"] as Record<string, unknown>;
    if (typeof m["id"] !== "string") throw new ProtocolError("MPP merchant.id required", "missing_field");
    if (typeof m["name"] !== "string") throw new ProtocolError("MPP merchant.name required", "missing_field");
    if (!Array.isArray(m["rails"])) throw new ProtocolError("MPP merchant.rails must be array", "missing_field");
    return body as unknown as Mpp402Body;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function generateNonce(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
