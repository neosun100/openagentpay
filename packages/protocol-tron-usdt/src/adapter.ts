/**
 * @openagentpay/protocol-tron-usdt — TRON USDT (TRC-20) payment protocol.
 *
 * USDT on TRON is the highest-volume stablecoin on earth (>$60B+ outstanding).
 * Cheap, fast (3s blocks), heavily used by Asian merchants.
 *
 * Wire format we accept (mirrors x402 shape):
 *   {
 *     tronUsdtVersion: "1",
 *     network: "mainnet" | "shasta" | "nile",
 *     contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",  // USDT on TRON mainnet
 *     amount: { value: "1000000", currency: "USDT", decimals: 6 },
 *     recipient: "T9zPxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
 *     validBefore: <unix>,
 *     nonce: "<hex>"
 *   }
 *
 * Settlement uses TIP-712 typed data signatures broadcast via TRON-Web.
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

export const PROTOCOL_ID = "tron-usdt-v1" as ProtocolId;
export const X_PAYMENT_TRON_HEADER = "X-PAYMENT-TRON";

export type TronNetwork = "mainnet" | "shasta" | "nile";

export interface TronUsdtBody {
  readonly tronUsdtVersion: string;
  readonly network: TronNetwork;
  readonly contract: string;
  readonly amount: { readonly value: string; readonly currency: string; readonly decimals: number };
  readonly recipient: string;
  readonly validBefore: number;
  readonly nonce: string;
  readonly description?: string;
}

export class TronUsdtProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    const v = body["tronUsdtVersion"];
    return typeof v === "string" && v.startsWith("1");
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    if (!isObject(response.body)) {
      throw new ProtocolError("TRON-USDT body not object", "malformed");
    }
    const b = response.body as unknown as TronUsdtBody;
    if (!b.contract || !b.recipient || !b.amount) {
      throw new ProtocolError("TRON-USDT missing contract/recipient/amount", "missing_field");
    }
    if (!b.recipient.startsWith("T") || b.recipient.length !== 34) {
      throw new ProtocolError("TRON-USDT recipient not a valid base58 address", "malformed");
    }
    const amount: Money = {
      amountAtomic: b.amount.value,
      decimals: b.amount.decimals,
      currency: b.amount.currency,
    };
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: b.recipient,
      asset: { symbol: b.amount.currency, decimals: b.amount.decimals, contract: b.contract },
      validAfter: 0,
      validBefore: b.validBefore || Math.floor(Date.now() / 1000) + 600,
      nonce: b.nonce,
      rawPayload: b,
      ...(b.description !== undefined ? { description: b.description } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    return {
      headers: {
        [X_PAYMENT_TRON_HEADER]: Buffer.from(
          JSON.stringify({ signer: signed.signer, signature: signed.signature, extra: signed.extra ?? {} })
        ).toString("base64url"),
      },
    };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
