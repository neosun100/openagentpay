/**
 * @openagentpay/protocol-skyfire — Skyfire KYA Adapter
 * =====================================================
 *
 * Skyfire's "Know Your Agent" model: agents present a signed identity token
 * (KYA) alongside a payment token (PAY) so a merchant receives BOTH identity
 * AND funds authorization in one HTTP request.
 *
 * Wire format:
 *   skyfire-kya-token: <jwt>      — KYA identity token (issued by Skyfire)
 *   skyfire-pay-token: <token>    — Payment authorization token
 *   OR (combined):
 *   Authorization: Bearer <kya>.<pay>
 *
 * Spec: https://docs.skyfire.xyz
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

export const PROTOCOL_ID = "skyfire-v1" as ProtocolId;
export const KYA_HEADER = "skyfire-kya-token";
export const PAY_HEADER = "skyfire-pay-token";

export interface SkyfireKYAClaims {
  readonly agentId: string;
  readonly ownerKyc: { readonly type: "human" | "org"; readonly id: string };
  readonly issuer: string;             // typically "https://api.skyfire.xyz"
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly scopes?: readonly string[];
  readonly spendLimit?: { readonly amountAtomic: string; readonly currency: string };
}

export interface SkyfireChallenge {
  readonly version: 1;
  readonly amount: { readonly amountAtomic: string; readonly currency: string; readonly decimals: number };
  readonly recipient: string;          // merchant ID
  readonly merchantUrl: string;
  readonly description?: string;
  readonly requireKya: boolean;
  readonly accepts: readonly string[]; // payment methods supported, e.g., ["usdc-base", "card"]
}

export interface Skyfire402Body {
  readonly skyfire: SkyfireChallenge;
}

export interface SkyfireAdapterConfig {
  /** Optional issuer allow-list — typically the official Skyfire prod issuer. */
  readonly trustedIssuers?: readonly string[];
  /** Optional accepted payment method hint (e.g., ['usdc-base']). */
  readonly preferredMethods?: readonly string[];
  readonly now?: () => number;
}

export class SkyfireProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly trustedIssuers: ReadonlySet<string> | undefined;
  private readonly preferredMethods: ReadonlySet<string> | undefined;
  private readonly now: () => number;

  constructor(cfg: SkyfireAdapterConfig = {}) {
    this.trustedIssuers = cfg.trustedIssuers ? new Set(cfg.trustedIssuers) : undefined;
    this.preferredMethods = cfg.preferredMethods ? new Set(cfg.preferredMethods) : undefined;
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    const sk = body["skyfire"];
    return isObject(sk) && (sk["version"] === 1 || sk["version"] === undefined);
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);
    const c = body.skyfire;

    if (this.preferredMethods && c.accepts.length > 0) {
      const has = c.accepts.some((m) => this.preferredMethods!.has(m));
      if (!has) {
        throw new ProtocolError(
          `Skyfire accepts [${c.accepts.join(",")}] doesn't include any preferred method`,
          "unsupported_scheme"
        );
      }
    }

    const amount: Money = {
      amountAtomic: c.amount.amountAtomic,
      decimals: c.amount.decimals,
      currency: c.amount.currency,
    };
    const validBefore = Math.floor(this.now() / 1000) + 600;

    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: c.recipient,
      asset: { symbol: c.amount.currency, decimals: c.amount.decimals },
      validAfter: 0,
      validBefore,
      nonce: generateNonce(),
      rawPayload: { skyfire: c },
      ...(c.description !== undefined ? { description: c.description } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("Skyfire retry requires PAY token in signature field", "missing_field");
    }
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const kyaToken = e["kyaToken"] as string | undefined;
    const headers: Record<string, string> = {
      [PAY_HEADER]: signed.signature, // PAY token issued by Skyfire after wallet authorizes
    };
    if (kyaToken) headers[KYA_HEADER] = kyaToken;
    return { headers };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  /**
   * Verify a KYA token (JWT) — pluggable. Default impl just checks structural
   * validity + expiry; production should verify Skyfire's signature.
   */
  verifyKya(token: string): { valid: boolean; reason?: string; claims?: SkyfireKYAClaims } {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false, reason: "not a JWT" };
    let claims: SkyfireKYAClaims;
    try {
      const payload = Buffer.from(parts[1]!, "base64url").toString("utf8");
      claims = JSON.parse(payload) as SkyfireKYAClaims;
    } catch {
      return { valid: false, reason: "invalid JWT payload" };
    }
    if (this.trustedIssuers && !this.trustedIssuers.has(claims.issuer)) {
      return { valid: false, reason: `untrusted issuer: ${claims.issuer}` };
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (claims.expiresAt < nowSec) {
      return { valid: false, reason: "KYA expired" };
    }
    return { valid: true, claims };
  }

  private assertBody(body: unknown): Skyfire402Body {
    if (!isObject(body))
      throw new ProtocolError("Skyfire body must be object", "malformed");
    const sk = body["skyfire"];
    if (!isObject(sk))
      throw new ProtocolError("Skyfire missing skyfire block", "missing_field");
    if (!isObject(sk["amount"]))
      throw new ProtocolError("Skyfire missing amount", "missing_field");
    if (typeof sk["recipient"] !== "string")
      throw new ProtocolError("Skyfire missing recipient", "missing_field");
    if (typeof sk["merchantUrl"] !== "string")
      throw new ProtocolError("Skyfire missing merchantUrl", "missing_field");
    return body as unknown as Skyfire402Body;
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
