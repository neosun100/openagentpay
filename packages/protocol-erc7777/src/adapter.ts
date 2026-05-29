/**
 * @openagentpay/protocol-erc7777 — Governance for Human-Robot Societies
 *
 * ERC-7777 defines an on-chain registry of identities + rule sets that govern
 * autonomous agents (humans, robots, AI agents). For payments, it surfaces the
 * agent identity + governance rules that apply to a transaction.
 *
 * Wire shape carried alongside any settlement:
 *   {
 *     erc7777Version: "1",
 *     identityRegistry: "0x...",
 *     agentId: "0x...",
 *     ruleSet: "0x...",
 *     attestation: "0x...",
 *     settlement: { ... }
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

export const PROTOCOL_ID = "erc7777-v1" as ProtocolId;
export const X_PAYMENT_ERC7777_HEADER = "X-PAYMENT-ERC7777";

export interface Erc7777Body {
  readonly erc7777Version: string;
  readonly identityRegistry: string;
  readonly agentId: string;
  readonly ruleSet: string;
  readonly attestation?: string;
  readonly settlement: {
    readonly amount: { readonly value: string; readonly currency: string; readonly decimals: number };
    readonly recipient: string;
    readonly chain?: string;
  };
}

export class Erc7777ProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    const v = body["erc7777Version"];
    return typeof v === "string" && v.startsWith("1");
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    if (!isObject(response.body)) {
      throw new ProtocolError("ERC-7777 body not object", "malformed");
    }
    const b = response.body as unknown as Erc7777Body;
    if (!b.identityRegistry || !b.agentId || !b.ruleSet) {
      throw new ProtocolError("ERC-7777 missing identity/registry/ruleSet", "missing_field");
    }
    if (!b.settlement?.amount || !b.settlement?.recipient) {
      throw new ProtocolError("ERC-7777 missing settlement.amount/recipient", "missing_field");
    }
    const amount: Money = {
      amountAtomic: b.settlement.amount.value,
      decimals: b.settlement.amount.decimals,
      currency: b.settlement.amount.currency,
    };
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: b.settlement.recipient,
      asset: { symbol: b.settlement.amount.currency, decimals: b.settlement.amount.decimals },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0x" + (b.agentId + b.ruleSet).slice(2, 66).padEnd(64, "0"),
      rawPayload: b,
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    return {
      headers: {
        [X_PAYMENT_ERC7777_HEADER]: encodeBase64Json({
          signature: signed.signature,
          signer: signed.signer,
          extra: signed.extra ?? {},
        }),
      },
    };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function encodeBase64Json(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
