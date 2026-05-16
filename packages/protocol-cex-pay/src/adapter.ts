/**
 * OpenAgentPay CEX Pay Protocol Adapter (OAP-CEX v0.1)
 * =====================================================
 *
 * Implements the {@link ProtocolAdapter} interface for the OAP-CEX v0.1 spec
 * defined in `../doc/SPEC.md`.
 *
 * Responsibilities:
 *   1. Detect 402 responses produced by an OAP-CEX-aware merchant
 *   2. Parse the response body into a wallet-agnostic {@link PaymentRequest}
 *   3. Build a retry envelope with the {@link X_PAYMENT_CEX_HEADER} header
 *
 * NOT responsible for:
 *   - Wallet-side signing (delegated to {@link WalletConnector})
 *   - Settlement at the merchant (the merchant decodes the token and submits
 *     to the wallet provider's API itself)
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

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID = "cex-pay-v0.1" as ProtocolId;
export const X_PAYMENT_CEX_HEADER = "X-PAYMENT-CEX";
export const SCHEME = "cex-pay";
export const SUPPORTED_OAP_CEX_VERSIONS = [1] as const;

// ============================================================================
//  Wire shapes — exact 1:1 with SPEC.md §4 and §5
// ============================================================================

/** A single entry inside the merchant's `accepts[]` array (SPEC.md §4.2). */
export interface OapCexAccept {
  readonly provider: string; // e.g., "binance-pay", "okx-pay"
  readonly asset: string; // e.g., "USDT", "USDC"
  readonly amount: string; // stringified atomic integer
  readonly amountDecimals: number;
  readonly recipient: string;
  readonly recipientType: "merchant_id" | "user_id" | "address";
  readonly validAfter?: number; // unix seconds
  readonly validBefore: number;
  readonly nonce: string; // 32-byte hex
  readonly metadata?: Record<string, unknown>;
}

/** The complete merchant 402 body (SPEC.md §4.1). */
export interface OapCex402Body {
  readonly oapCexVersion: number;
  readonly scheme: "cex-pay";
  readonly accepts: readonly OapCexAccept[];
  readonly description?: string;
}

/** The wire token decoded form (SPEC.md §5.1). */
export interface OapCexWireToken {
  readonly oapCexVersion: number;
  readonly scheme: "cex-pay";
  readonly provider: string;
  readonly authorization: {
    readonly asset: string;
    readonly amount: string;
    readonly amountDecimals: number;
    readonly from: string;
    readonly to: string;
    readonly nonce: string;
    readonly validBefore: number;
    readonly signedAt: number;
  };
  readonly signature: {
    readonly alg: "HMAC-SHA512" | "HMAC-SHA256" | "Ed25519" | "OAuth2-Bearer";
    readonly value: string;
  };
  readonly providerExtensions?: Record<string, unknown>;
}

// ============================================================================
//  Selection policy — when a merchant offers multiple `accepts[]`, decide which
//  one our wallet stack can satisfy.
// ============================================================================

/**
 * Default selection policy: pick the first `accepts[]` entry whose provider
 * matches a configured wallet provider. Override via {@link CexPayAdapterConfig}.
 */
export type AcceptSelector = (
  accepts: readonly OapCexAccept[]
) => OapCexAccept | undefined;

export interface CexPayAdapterConfig {
  /** Provider IDs this adapter is allowed to honor (in priority order). */
  readonly preferredProviders?: readonly string[];
  /** Custom selector — if set, overrides preferredProviders. */
  readonly selectAccept?: AcceptSelector;
  /** Now() impl — overridable for deterministic tests. */
  readonly now?: () => number;
}

// ============================================================================
//  Adapter implementation
// ============================================================================

export class CexPayAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly preferredProviders: readonly string[];
  private readonly selectAccept: AcceptSelector;
  private readonly now: () => number;

  constructor(config: CexPayAdapterConfig = {}) {
    this.preferredProviders = config.preferredProviders ?? [];
    this.now = config.now ?? Date.now;
    this.selectAccept =
      config.selectAccept ??
      ((accepts) => {
        if (this.preferredProviders.length === 0) return accepts[0];
        for (const wantedProvider of this.preferredProviders) {
          const hit = accepts.find((a) => a.provider === wantedProvider);
          if (hit) return hit;
        }
        return undefined;
      });
  }

  // ---- ProtocolAdapter -----------------------------------------------------

  /**
   * Detect whether a 402 response was produced by an OAP-CEX merchant.
   *
   * Cheap structural check — no exceptions, no parsing the whole body.
   */
  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    if (body["scheme"] !== SCHEME) return false;
    const v = body["oapCexVersion"];
    return typeof v === "number" && SUPPORTED_OAP_CEX_VERSIONS.includes(v as 1);
  }

  /**
   * Parse a 402 response into a {@link PaymentRequest}. Throws
   * {@link ProtocolError} for malformed input — callers must handle it.
   */
  async parsePaymentRequired(
    response: HttpResponse402
  ): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);
    const accept = this.selectAccept(body.accepts);
    if (!accept) {
      throw new ProtocolError(
        `No supported provider in accepts[]: got [${body.accepts.map((a) => a.provider).join(", ")}], wanted [${this.preferredProviders.join(", ") || "any"}]`,
        "unsupported_scheme"
      );
    }

    const nowSec = Math.floor(this.now() / 1000);
    if (accept.validBefore <= nowSec) {
      throw new ProtocolError(
        `Authorization already expired: validBefore=${accept.validBefore}, now=${nowSec}`,
        "malformed"
      );
    }

    const amount: Money = {
      amountAtomic: accept.amount,
      decimals: accept.amountDecimals,
      currency: accept.asset,
    };

    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: accept.recipient,
      asset: {
        symbol: accept.asset,
        decimals: accept.amountDecimals,
      },
      validAfter: accept.validAfter ?? 0,
      validBefore: accept.validBefore,
      nonce: accept.nonce,
      rawPayload: { selectedAccept: accept, fullBody: body },
      ...(body.description !== undefined && { description: body.description }),
    };
  }

  /**
   * Build the retry envelope (HTTP headers and optional body) given a
   * SignedAuthorization. The signed.encoded MUST be the base64-url string
   * that the wallet connector produced per SPEC.md §5.3.
   */
  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.encoded) {
      throw new ProtocolError(
        "SignedAuthorization.encoded is required for OAP-CEX retry (no fallback re-encoding to keep signing logic out of the protocol layer)",
        "missing_field"
      );
    }
    return {
      headers: {
        [X_PAYMENT_CEX_HEADER]: signed.encoded,
      },
    };
  }

  /** No facilitator pre-submit step in OAP-CEX MVP. */
  async preSubmit(
    _signed: SignedAuthorization
  ): Promise<undefined> {
    return undefined;
  }

  // ---- internals -----------------------------------------------------------

  private assertBody(body: unknown): OapCex402Body {
    if (!isObject(body)) {
      throw new ProtocolError("OAP-CEX 402 body is not an object", "malformed");
    }
    if (body["scheme"] !== SCHEME) {
      throw new ProtocolError(
        `OAP-CEX scheme mismatch: expected "${SCHEME}", got "${String(body["scheme"])}"`,
        "unsupported_scheme"
      );
    }
    if (typeof body["oapCexVersion"] !== "number") {
      throw new ProtocolError("OAP-CEX missing oapCexVersion", "missing_field");
    }
    if (!SUPPORTED_OAP_CEX_VERSIONS.includes(body["oapCexVersion"] as 1)) {
      throw new ProtocolError(
        `OAP-CEX version ${body["oapCexVersion"]} not supported (this adapter speaks v${SUPPORTED_OAP_CEX_VERSIONS.join(",")})`,
        "unsupported_version"
      );
    }
    if (!Array.isArray(body["accepts"]) || body["accepts"].length === 0) {
      throw new ProtocolError(
        "OAP-CEX accepts[] must be a non-empty array",
        "missing_field"
      );
    }
    for (const a of body["accepts"]) {
      if (!isObject(a)) throw new ProtocolError("accepts[] item not an object", "malformed");
      for (const f of [
        "provider",
        "asset",
        "amount",
        "amountDecimals",
        "recipient",
        "recipientType",
        "validBefore",
        "nonce",
      ] as const) {
        if (a[f] === undefined) {
          throw new ProtocolError(
            `accepts[] item missing field: ${f}`,
            "missing_field"
          );
        }
      }
    }
    return body as unknown as OapCex402Body;
  }
}

// ============================================================================
//  Token encoding / decoding helpers (used by wallet connectors)
// ============================================================================

/**
 * Encode a {@link OapCexWireToken} into the X-PAYMENT-CEX header value.
 *
 * Per SPEC.md §5.3: base64url, no padding, on the canonical JSON serialization
 * with no whitespace.
 */
export function encodeWireToken(token: OapCexWireToken): string {
  const json = JSON.stringify(token);
  return Buffer.from(json, "utf8").toString("base64url");
}

/** Decode a header value back into a token (used by merchant-side validators). */
export function decodeWireToken(headerValue: string): OapCexWireToken {
  const json = Buffer.from(headerValue, "base64url").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ProtocolError("X-PAYMENT-CEX is not valid base64-url JSON", "malformed");
  }
  return parsed as OapCexWireToken;
}

// ============================================================================
//  Helpers
// ============================================================================

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
