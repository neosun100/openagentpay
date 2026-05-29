/**
 * @openagentpay/protocol-nevermined — Subscription/credit-based AI payments
 * ==========================================================================
 *
 * Nevermined uses tokenized subscriptions (NFTs) and usage-credits for AI
 * services. A 402 envelope can carry either:
 *   - planId  — agent must mint/buy a subscription NFT
 *   - creditPrice — agent debits prepaid credits
 *
 * Spec: https://nevermined.io
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

export const PROTOCOL_ID = "nevermined-v1" as ProtocolId;
export const X_PAYMENT_NVM_HEADER = "X-PAYMENT-NVM";

export interface NeverminedSubscription {
  readonly planId: string;            // NFT plan id
  readonly tokenContract: string;     // ERC-721/1155 contract
  readonly chain: string;              // CAIP-2
  readonly priceAtomic: string;
  readonly currency: string;
  readonly decimals: number;
  readonly durationDays?: number;
  readonly creditAmount?: number;     // for credit-based plans
}

export interface NeverminedCharge {
  readonly creditsRequired: number;
  readonly serviceId: string;
}

export interface Nevermined402Body {
  readonly nvmVersion: 1;
  readonly mode: "subscription" | "credit";
  readonly subscription?: NeverminedSubscription;
  readonly charge?: NeverminedCharge;
  readonly description?: string;
}

export interface NeverminedAdapterConfig {
  readonly trustedContracts?: readonly string[];
  readonly now?: () => number;
}

export class NeverminedProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly trustedContracts: ReadonlySet<string> | undefined;
  private readonly now: () => number;

  constructor(cfg: NeverminedAdapterConfig = {}) {
    this.trustedContracts = cfg.trustedContracts
      ? new Set(cfg.trustedContracts.map((c) => c.toLowerCase()))
      : undefined;
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    return body["nvmVersion"] === 1;
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);

    if (body.mode === "subscription") {
      const sub = body.subscription;
      if (!sub) throw new ProtocolError("Nevermined subscription mode missing subscription block", "missing_field");
      if (
        this.trustedContracts &&
        !this.trustedContracts.has(sub.tokenContract.toLowerCase())
      ) {
        throw new ProtocolError(
          `Nevermined contract ${sub.tokenContract} not trusted`,
          "unsupported_scheme"
        );
      }
      const amount: Money = {
        amountAtomic: sub.priceAtomic,
        decimals: sub.decimals,
        currency: sub.currency,
      };
      const validBefore = Math.floor(this.now() / 1000) + 600;
      return {
        protocol: PROTOCOL_ID,
        amount,
        recipient: sub.tokenContract, // funds go to subscription contract
        asset: { symbol: sub.currency, decimals: sub.decimals, contract: sub.tokenContract, chain: sub.chain },
        validAfter: 0,
        validBefore,
        nonce: sub.planId,
        rawPayload: { mode: "subscription", subscription: sub },
        ...(body.description !== undefined ? { description: body.description } : {}),
      };
    }

    // credit mode
    const c = body.charge;
    if (!c) throw new ProtocolError("Nevermined credit mode missing charge block", "missing_field");
    // Credit payments have no on-chain cost — atomic units = credits
    const amount: Money = {
      amountAtomic: String(c.creditsRequired),
      decimals: 0,
      currency: "NVMCREDIT",
    };
    const validBefore = Math.floor(this.now() / 1000) + 600;
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: c.serviceId,
      asset: { symbol: "NVMCREDIT", decimals: 0 },
      validAfter: 0,
      validBefore,
      nonce: c.serviceId + ":" + c.creditsRequired,
      rawPayload: { mode: "credit", charge: c },
      ...(body.description !== undefined ? { description: body.description } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("Nevermined retry requires signature", "missing_field");
    }
    const wire = {
      nvmVersion: 1,
      signer: signed.signer,
      nonce: signed.request.nonce,
      signature: signed.signature,
      encoded: signed.encoded ?? null,
    };
    return {
      headers: {
        [X_PAYMENT_NVM_HEADER]: Buffer.from(JSON.stringify(wire), "utf8").toString("base64url"),
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  private assertBody(body: unknown): Nevermined402Body {
    if (!isObject(body)) throw new ProtocolError("Nevermined body must be object", "malformed");
    if (body["nvmVersion"] !== 1) throw new ProtocolError("Nevermined version must be 1", "unsupported_version");
    const mode = body["mode"];
    if (mode !== "subscription" && mode !== "credit") {
      throw new ProtocolError(`Nevermined mode must be 'subscription' or 'credit', got '${String(mode)}'`, "missing_field");
    }
    return body as unknown as Nevermined402Body;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
