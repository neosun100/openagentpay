/**
 * @openagentpay/protocol-hedera-hcs — Hedera Hashgraph + HCS micropayments.
 *
 * Hedera offers sub-cent fixed-fee transactions and aBFT consensus, making
 * it strong for streaming agent micropayments. We support two flavors:
 *
 *   1. Native HBAR transfer (HBAR has no token contract — direct CryptoTransfer)
 *   2. HTS USDC transfer (Hedera Token Service-issued USDC)
 *
 * 402 envelope:
 *   {
 *     hederaVersion: "1",
 *     network: "mainnet" | "testnet" | "previewnet",
 *     payee: "0.0.12345",      // shard.realm.account format
 *     token: "USDC" | "HBAR",
 *     tokenId?: "0.0.456858",  // HTS token id (omit for HBAR)
 *     amount: { value, currency, decimals },
 *     memo?: "...",
 *     validBefore: <unix>,
 *     nonce: "0x..."
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

export const PROTOCOL_ID = "hedera-hcs-v1" as ProtocolId;
export const X_PAYMENT_HEDERA_HEADER = "X-PAYMENT-HEDERA";

export type HederaNetwork = "mainnet" | "testnet" | "previewnet";

export interface HederaHcsBody {
  readonly hederaVersion: string;
  readonly network: HederaNetwork;
  readonly payee: string;
  readonly token: string;
  readonly tokenId?: string;
  readonly amount: { readonly value: string; readonly currency: string; readonly decimals: number };
  readonly memo?: string;
  readonly validBefore: number;
  readonly nonce: string;
}

export class HederaHcsProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    return typeof body["hederaVersion"] === "string";
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    if (!isObject(response.body)) {
      throw new ProtocolError("Hedera body not object", "malformed");
    }
    const b = response.body as unknown as HederaHcsBody;
    if (!b.payee || !b.amount || !b.token) {
      throw new ProtocolError("Hedera missing payee/amount/token", "missing_field");
    }
    if (!/^\d+\.\d+\.\d+$/.test(b.payee)) {
      throw new ProtocolError("Hedera payee not in shard.realm.account format", "malformed");
    }
    const amount: Money = {
      amountAtomic: b.amount.value,
      decimals: b.amount.decimals,
      currency: b.amount.currency,
    };
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: b.payee,
      asset: {
        symbol: b.amount.currency,
        decimals: b.amount.decimals,
        ...(b.tokenId !== undefined ? { contract: b.tokenId } : {}),
      },
      validAfter: 0,
      validBefore: b.validBefore || Math.floor(Date.now() / 1000) + 600,
      nonce: b.nonce,
      rawPayload: b,
      ...(b.memo !== undefined ? { description: b.memo } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    return {
      headers: {
        [X_PAYMENT_HEDERA_HEADER]: Buffer.from(
          JSON.stringify({ signer: signed.signer, signature: signed.signature, extra: signed.extra ?? {} })
        ).toString("base64url"),
      },
    };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
