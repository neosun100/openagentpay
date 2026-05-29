/**
 * @openagentpay/protocol-cosmos-ibc — Cosmos IBC cross-chain payments.
 *
 * Cosmos IBC (Inter-Blockchain Communication) lets sovereign Cosmos zones
 * exchange tokens. For agent payments we recognize a 402 envelope shaped
 * like:
 *
 *   {
 *     cosmosIbcVersion: "1",
 *     sourceChain: "cosmoshub-4",
 *     destChain: "osmosis-1",
 *     sourcePort: "transfer",
 *     sourceChannel: "channel-141",
 *     payee: "cosmos1abc...",
 *     denom: "uatom" | "ibc/27...",
 *     amount: { value, currency, decimals },
 *     memo?: "...",
 *     timeoutHeight?: { revisionNumber, revisionHeight },
 *     timeoutTimestamp?: <ns>,
 *     nonce: "0x..."
 *   }
 *
 * Settlement is via MsgTransfer on the source chain.
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

export const PROTOCOL_ID = "cosmos-ibc-v1" as ProtocolId;
export const X_PAYMENT_COSMOS_HEADER = "X-PAYMENT-COSMOS";

export interface CosmosIbcBody {
  readonly cosmosIbcVersion: string;
  readonly sourceChain: string;
  readonly destChain: string;
  readonly sourcePort: string;
  readonly sourceChannel: string;
  readonly payee: string;
  readonly denom: string;
  readonly amount: { readonly value: string; readonly currency: string; readonly decimals: number };
  readonly memo?: string;
  readonly timeoutHeight?: { readonly revisionNumber: number; readonly revisionHeight: number };
  readonly timeoutTimestamp?: number;
  readonly nonce: string;
}

export class CosmosIbcProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    return typeof body["cosmosIbcVersion"] === "string";
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    if (!isObject(response.body)) {
      throw new ProtocolError("Cosmos IBC body not object", "malformed");
    }
    const b = response.body as unknown as CosmosIbcBody;
    if (!b.payee || !b.denom || !b.sourceChannel) {
      throw new ProtocolError("Cosmos IBC missing payee/denom/sourceChannel", "missing_field");
    }
    if (!/^[a-z0-9]+1[a-z0-9]+$/.test(b.payee)) {
      throw new ProtocolError("Cosmos IBC payee not bech32-shaped", "malformed");
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
      asset: { symbol: b.amount.currency, decimals: b.amount.decimals, contract: b.denom },
      validAfter: 0,
      validBefore: b.timeoutTimestamp
        ? Math.floor(b.timeoutTimestamp / 1_000_000_000)
        : Math.floor(Date.now() / 1000) + 600,
      nonce: b.nonce,
      rawPayload: b,
      ...(b.memo !== undefined ? { description: b.memo } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    return {
      headers: {
        [X_PAYMENT_COSMOS_HEADER]: Buffer.from(
          JSON.stringify({ signer: signed.signer, signature: signed.signature, extra: signed.extra ?? {} })
        ).toString("base64url"),
      },
    };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
