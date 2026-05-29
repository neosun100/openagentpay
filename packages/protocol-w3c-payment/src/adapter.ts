/**
 * @openagentpay/protocol-w3c-payment — W3C Payment Request + SPC Adapter
 * =======================================================================
 *
 * Bridges the W3C Payment Request API + Secure Payment Confirmation (SPC)
 * to OpenAgentPay's ProtocolAdapter interface. Used when an agent runs
 * inside a browser (or browser-controlled environment) and merchants gate
 * resources via the standard W3C payment flow.
 *
 * Specs:
 *   - https://www.w3.org/TR/payment-request/
 *   - https://www.w3.org/TR/secure-payment-confirmation/
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

export const PROTOCOL_ID = "w3c-payment-v1" as ProtocolId;
export const X_PAYMENT_W3C_HEADER = "X-PAYMENT-W3C";

export interface PaymentMethodData {
  readonly supportedMethods: string;       // e.g., "basic-card", "https://apple.com/apple-pay", "secure-payment-confirmation"
  readonly data?: Record<string, unknown>;
}

export interface PaymentDetailsTotal {
  readonly label: string;
  readonly amount: { readonly currency: string; readonly value: string };
}

export interface PaymentDetails {
  readonly id?: string;
  readonly total: PaymentDetailsTotal;
  readonly displayItems?: readonly { readonly label: string; readonly amount: PaymentDetailsTotal["amount"] }[];
}

export interface W3cPayment402Body {
  readonly w3cPaymentVersion: 1;
  readonly methodData: readonly PaymentMethodData[];
  readonly details: PaymentDetails;
  readonly merchantOrigin: string;
  readonly description?: string;
}

export interface W3cAdapterConfig {
  readonly preferredMethods?: readonly string[];
  readonly defaultDecimals?: number;
  readonly now?: () => number;
}

export class W3cPaymentRequestProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly preferredMethods: ReadonlySet<string> | undefined;
  private readonly defaultDecimals: number;
  private readonly now: () => number;

  constructor(cfg: W3cAdapterConfig = {}) {
    this.preferredMethods = cfg.preferredMethods ? new Set(cfg.preferredMethods) : undefined;
    this.defaultDecimals = cfg.defaultDecimals ?? 2;
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    return body["w3cPaymentVersion"] === 1 && Array.isArray(body["methodData"]);
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);
    if (this.preferredMethods) {
      const has = body.methodData.some((m) => this.preferredMethods!.has(m.supportedMethods));
      if (!has) {
        throw new ProtocolError(
          `W3C: no method in [${body.methodData.map((m) => m.supportedMethods).join(",")}] is preferred`,
          "unsupported_scheme"
        );
      }
    }
    const value = body.details.total.amount.value; // decimal string e.g. "1.99"
    const currency = body.details.total.amount.currency; // ISO 4217 e.g. "USD"
    const decimals = inferDecimalsFromCurrency(currency, this.defaultDecimals);
    const amountAtomic = decimalToAtomic(value, decimals);
    const amount: Money = {
      amountAtomic,
      decimals,
      currency,
    };
    const validBefore = Math.floor(this.now() / 1000) + 600;
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: body.merchantOrigin,
      asset: { symbol: currency, decimals },
      validAfter: 0,
      validBefore,
      nonce: body.details.id ?? generateNonce(),
      rawPayload: { w3c: body },
      ...(body.description !== undefined ? { description: body.description } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("W3C retry requires PaymentResponse details (in signature)", "missing_field");
    }
    const wire = {
      w3cPaymentVersion: 1,
      methodName: (signed.extra ?? {})["methodName"] ?? "unknown",
      details: signed.signature,             // serialized PaymentResponse details
      payerName: (signed.extra ?? {})["payerName"] ?? null,
      spcAttestation: (signed.extra ?? {})["spcAttestation"] ?? null,
    };
    return {
      headers: {
        [X_PAYMENT_W3C_HEADER]: Buffer.from(JSON.stringify(wire), "utf8").toString("base64url"),
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  private assertBody(body: unknown): W3cPayment402Body {
    if (!isObject(body)) throw new ProtocolError("W3C body must be object", "malformed");
    if (body["w3cPaymentVersion"] !== 1)
      throw new ProtocolError("W3C version must be 1", "unsupported_version");
    if (!Array.isArray(body["methodData"]) || body["methodData"].length === 0)
      throw new ProtocolError("W3C methodData must be non-empty array", "missing_field");
    if (!isObject(body["details"]))
      throw new ProtocolError("W3C details required", "missing_field");
    const d = body["details"] as Record<string, unknown>;
    if (!isObject(d["total"]))
      throw new ProtocolError("W3C details.total required", "missing_field");
    const t = d["total"] as Record<string, unknown>;
    if (!isObject(t["amount"]))
      throw new ProtocolError("W3C details.total.amount required", "missing_field");
    if (typeof body["merchantOrigin"] !== "string")
      throw new ProtocolError("W3C merchantOrigin required", "missing_field");
    return body as unknown as W3cPayment402Body;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function decimalToAtomic(decimal: string, decimals: number): string {
  if (!/^-?\d+(\.\d+)?$/.test(decimal)) {
    throw new ProtocolError(`W3C invalid decimal amount: ${decimal}`, "malformed");
  }
  const negative = decimal.startsWith("-");
  const abs = negative ? decimal.slice(1) : decimal;
  const [whole = "0", frac = ""] = abs.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = (whole + fracPadded).replace(/^0+(?=\d)/, "");
  const result = combined === "" ? "0" : combined;
  return negative ? "-" + result : result;
}

function inferDecimalsFromCurrency(code: string, defaultDecimals: number): number {
  const c = code.toUpperCase();
  // 0-decimal currencies (ISO-defined)
  if (["JPY", "KRW", "VND", "CLP"].includes(c)) return 0;
  // 3-decimal currencies
  if (["BHD", "JOD", "KWD", "OMR", "TND"].includes(c)) return 3;
  // Crypto stablecoins commonly used
  if (["USDC", "USDT", "USDP", "BUSD", "FDUSD"].includes(c)) return 6;
  if (c === "BTC") return 8;
  if (c === "ETH") return 18;
  // Default: ISO 4217 fiat
  return defaultDecimals;
}

function generateNonce(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
