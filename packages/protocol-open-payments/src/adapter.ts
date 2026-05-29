/**
 * @openagentpay/protocol-open-payments — Open Payments / Interledger
 *
 * Open Payments is the open API standard maintained by the Interledger
 * Foundation, providing a uniform Resource-Server / Auth-Server surface
 * for sending payments between digital wallets — works across fiat banks,
 * stablecoin issuers, and crypto exchanges via the Interledger Protocol (ILP).
 *
 * Specs:
 *   https://openpayments.dev/
 *   https://interledger.org/rfcs/0027-interledger-protocol/
 *
 * For agent payments we recognize a 402 envelope shaped like:
 *   {
 *     openPaymentsVersion: "1.0",
 *     incomingPayment: { id, walletAddress, incomingAmount: { value, assetCode, assetScale } },
 *     quote: { id, debitAmount, receiveAmount, expiresAt },
 *     authServer: "https://...",
 *     resourceServer: "https://..."
 *   }
 *
 * The agent obtains an interactive grant from authServer, then POSTs the
 * outgoing payment to resourceServer.
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

export const PROTOCOL_ID = "open-payments-v1" as ProtocolId;
export const X_PAYMENT_OP_HEADER = "X-PAYMENT-OPENPAYMENTS";

export interface OpenPaymentsAmount {
  readonly value: string;
  readonly assetCode: string;
  readonly assetScale: number; // ≈ decimals
}

export interface OpenPaymentsBody {
  readonly openPaymentsVersion: string;
  readonly incomingPayment: {
    readonly id: string;
    readonly walletAddress: string;
    readonly incomingAmount: OpenPaymentsAmount;
    readonly description?: string;
    readonly expiresAt?: string;
  };
  readonly quote: {
    readonly id: string;
    readonly debitAmount: OpenPaymentsAmount;
    readonly receiveAmount: OpenPaymentsAmount;
    readonly expiresAt: string;
  };
  readonly authServer: string;
  readonly resourceServer: string;
}

export class OpenPaymentsProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    return typeof body["openPaymentsVersion"] === "string";
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    if (!isObject(response.body)) {
      throw new ProtocolError("Open Payments body not object", "malformed");
    }
    const b = response.body as unknown as OpenPaymentsBody;
    if (!b.incomingPayment?.walletAddress || !b.quote?.id || !b.authServer) {
      throw new ProtocolError(
        "Open Payments missing incomingPayment/quote/authServer",
        "missing_field"
      );
    }
    const debit = b.quote.debitAmount;
    const amount: Money = {
      amountAtomic: debit.value,
      decimals: debit.assetScale,
      currency: debit.assetCode,
    };
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: b.incomingPayment.walletAddress,
      asset: { symbol: debit.assetCode, decimals: debit.assetScale },
      validAfter: 0,
      validBefore: b.quote.expiresAt
        ? Math.floor(new Date(b.quote.expiresAt).getTime() / 1000)
        : Math.floor(Date.now() / 1000) + 600,
      nonce: b.quote.id,
      rawPayload: b,
      ...(b.incomingPayment.description !== undefined
        ? { description: b.incomingPayment.description }
        : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    return {
      headers: {
        [X_PAYMENT_OP_HEADER]: `GNAP ${signed.signature}`,
      },
    };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
