/**
 * @openagentpay/protocol-stellar — Stellar SEP-31 Cross-Border Payments Adapter
 * ================================================================================
 *
 * Stellar Ecosystem Proposal 31 defines anchor-to-anchor payments:
 *   sender wallet → sending anchor → receiving anchor → recipient
 *
 * Key features:
 *   - Asset issuer (e.g., Circle USDC on Stellar)
 *   - Sender + receiver KYC via SEP-12 (out of scope here)
 *   - Memo-based routing (SEP-29 memo_required check)
 *   - Optional FX quote via SEP-38
 *
 * Wire format (envelope on top of HTTP 402):
 *   {
 *     stellarVersion: "31",
 *     anchor: { domain, sendingAccount, receivingAccount, memoType, memo },
 *     amount: { value, asset_code, asset_issuer, decimals },
 *     description?: string
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

export const PROTOCOL_ID = "stellar-sep31-v1" as ProtocolId;
export const X_PAYMENT_STELLAR_HEADER = "X-PAYMENT-STELLAR";

export type StellarMemoType = "text" | "id" | "hash" | "return";

export interface StellarAnchor {
  readonly domain: string;            // e.g., "circle.com"
  readonly sendingAccount: string;    // G... pubkey
  readonly receivingAccount: string;  // G... pubkey (anchor's intake)
  readonly memoType: StellarMemoType;
  readonly memo: string;
}

export interface Stellar402Body {
  readonly stellarVersion: string;
  readonly anchor: StellarAnchor;
  readonly amount: {
    readonly value: string;
    readonly assetCode: string;        // "USDC"
    readonly assetIssuer: string;      // G... issuer pubkey
    readonly decimals: number;
  };
  readonly description?: string;
}

export interface StellarAdapterConfig {
  readonly trustedAnchors?: readonly string[];
  readonly trustedIssuers?: readonly string[];
  readonly now?: () => number;
}

export class StellarSep31ProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly trustedAnchors: ReadonlySet<string> | undefined;
  private readonly trustedIssuers: ReadonlySet<string> | undefined;
  private readonly now: () => number;

  constructor(cfg: StellarAdapterConfig = {}) {
    this.trustedAnchors = cfg.trustedAnchors ? new Set(cfg.trustedAnchors) : undefined;
    this.trustedIssuers = cfg.trustedIssuers ? new Set(cfg.trustedIssuers) : undefined;
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    return typeof body["stellarVersion"] === "string";
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);
    if (this.trustedAnchors && !this.trustedAnchors.has(body.anchor.domain)) {
      throw new ProtocolError(`Stellar anchor ${body.anchor.domain} not trusted`, "unsupported_scheme");
    }
    if (this.trustedIssuers && !this.trustedIssuers.has(body.amount.assetIssuer)) {
      throw new ProtocolError(`Stellar asset issuer ${body.amount.assetIssuer} not trusted`, "unsupported_scheme");
    }
    if (!body.anchor.memo) {
      throw new ProtocolError(
        "Stellar anchor missing memo (SEP-29 mandates memo for routing)",
        "missing_field"
      );
    }
    const amount: Money = {
      amountAtomic: body.amount.value,
      decimals: body.amount.decimals,
      currency: body.amount.assetCode,
    };
    const validBefore = Math.floor(this.now() / 1000) + 600;
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: body.anchor.receivingAccount,
      asset: {
        symbol: body.amount.assetCode,
        decimals: body.amount.decimals,
        contract: body.amount.assetIssuer,
        chain: "stellar:pubnet",
      },
      validAfter: 0,
      validBefore,
      nonce: body.anchor.memo, // memo doubles as nonce (per anchor it must be unique)
      rawPayload: { stellar: body },
      ...(body.description !== undefined ? { description: body.description } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("Stellar retry requires signed transaction", "missing_field");
    }
    const wire = {
      stellarVersion: "31",
      txEnvelope: signed.signature, // base64-encoded XDR
      memo: signed.request.nonce,
      signer: signed.signer,
    };
    return {
      headers: {
        [X_PAYMENT_STELLAR_HEADER]: Buffer.from(JSON.stringify(wire), "utf8").toString("base64url"),
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  private assertBody(body: unknown): Stellar402Body {
    if (!isObject(body)) throw new ProtocolError("Stellar body must be object", "malformed");
    if (typeof body["stellarVersion"] !== "string")
      throw new ProtocolError("Stellar missing stellarVersion", "missing_field");
    if (!isObject(body["anchor"])) throw new ProtocolError("Stellar missing anchor block", "missing_field");
    if (!isObject(body["amount"])) throw new ProtocolError("Stellar missing amount block", "missing_field");
    const a = body["anchor"] as Record<string, unknown>;
    for (const f of ["domain", "sendingAccount", "receivingAccount", "memoType", "memo"] as const) {
      if (typeof a[f] !== "string") {
        throw new ProtocolError(`Stellar anchor missing ${f}`, "missing_field");
      }
    }
    const am = body["amount"] as Record<string, unknown>;
    if (typeof am["value"] !== "string") throw new ProtocolError("Stellar amount.value required", "missing_field");
    if (typeof am["assetCode"] !== "string") throw new ProtocolError("Stellar amount.assetCode required", "missing_field");
    if (typeof am["assetIssuer"] !== "string") throw new ProtocolError("Stellar amount.assetIssuer required", "missing_field");
    return body as unknown as Stellar402Body;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
