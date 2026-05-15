/**
 * Binance Pay REST API client.
 * ===============================
 *
 * Wraps the Binance Pay v3 merchant API. This is the lowest layer — knows
 * nothing about OpenAgentPay types or AgentCore. It only knows how to:
 *
 *   1. Sign requests with HMAC SHA512 per Binance Pay spec
 *   2. POST orders / query orders / query merchant balance
 *   3. Surface errors with structured codes
 *
 * Reference: https://developers.binance.com/docs/binance-pay/api-create-order-v3
 *
 * Test environments:
 *   - Sandbox base URL: https://bpay.binanceapi.com  (Binance Pay does not have
 *     a separate sandbox host — sandbox is enabled per merchant account in the
 *     merchant portal at https://merchant-test.binance.com)
 *   - Production base URL: https://bpay.binanceapi.com
 *
 * ⚠️ NEVER log or persist `apiSecret`. Always pull from secret manager.
 *
 * @license Apache-2.0
 */

import { createHmac, randomBytes } from "node:crypto";

// ============================================================================
//  Configuration
// ============================================================================

export interface BinancePayClientConfig {
  /** Merchant API key (read from Secrets Manager). */
  readonly apiKey: string;
  /** Merchant API secret (read from Secrets Manager). NEVER logged. */
  readonly apiSecret: string;
  /** Base URL — same for sandbox and production; merchant flag is on account. */
  readonly baseUrl?: string;
  /** Optional override for fetch implementation (Node 18+ has native fetch). */
  readonly fetchFn?: typeof fetch;
  /** Request timeout in ms (default 15s). */
  readonly timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://bpay.binanceapi.com";
const DEFAULT_TIMEOUT_MS = 15_000;

// ============================================================================
//  Public API surface — three high-level methods
// ============================================================================

export interface CreateOrderInput {
  /** Merchant-side unique order ID (1-32 chars, [a-zA-Z0-9_-]). */
  readonly merchantTradeNo: string;
  /** Order amount in major units (e.g. "0.001"). Up to 8 decimal places. */
  readonly orderAmount: string;
  /** ISO 4217 / asset symbol — Binance Pay supports USDT, USDC, BUSD, BNB, ... */
  readonly currency: string;
  /** Goods information for compliance. */
  readonly goods: {
    readonly goodsType: "01" | "02"; // 01=tangible, 02=virtual
    readonly goodsCategory: string; // e.g., "D000" for Digital goods
    readonly referenceGoodsId: string;
    readonly goodsName: string;
    readonly goodsDetail?: string;
  };
  /** Webhook URL for asynchronous payment notifications. */
  readonly webhookUrl?: string;
  /** Return URL after user completes payment. */
  readonly returnUrl?: string;
  /** Buyer info (optional but recommended for compliance). */
  readonly buyer?: {
    readonly buyerEmail?: string;
    readonly buyerName?: { readonly firstName: string; readonly lastName: string };
    readonly buyerPhone?: { readonly phoneNumber: string; readonly phoneCountryCode: string };
  };
}

export interface CreateOrderResponse {
  /** Binance Pay assigns this — used in subsequent queries. */
  readonly prepayId: string;
  /** URL to redirect the user to (web flow). */
  readonly checkoutUrl: string;
  /** Universal link / deeplink for app-based flows. */
  readonly universalUrl?: string;
  /** Server-issued timestamp (ms). */
  readonly expireTime: number;
  /** Reference ID Binance assigns — useful for support tickets. */
  readonly terminalType?: string;
  /** Raw response body, kept verbatim for forensics. */
  readonly raw: unknown;
}

export interface QueryOrderInput {
  readonly merchantTradeNo?: string;
  readonly prepayId?: string;
}

export interface QueryOrderResponse {
  readonly tradeType: string;
  readonly status: "INITIAL" | "PENDING" | "PAID" | "CANCELED" | "ERROR" | "REFUNDING" | "REFUNDED" | "EXPIRED";
  readonly transactionId?: string;
  readonly transactTime?: number;
  readonly orderAmount?: string;
  readonly currency?: string;
  readonly raw: unknown;
}

export interface QueryBalanceInput {
  /** Asset symbol — when omitted, returns all assets. */
  readonly asset?: string;
  /** Wallet type, defaults to "FUNDING" for merchant operating wallet. */
  readonly walletType?: "FUNDING" | "SPOT";
}

export interface QueryBalanceResponse {
  readonly balances: ReadonlyArray<{
    readonly asset: string;
    readonly free: string; // major units, e.g., "19.95800000"
    readonly locked: string;
  }>;
  readonly raw: unknown;
}

// ============================================================================
//  Errors
// ============================================================================

export class BinancePayError extends Error {
  override readonly name = "BinancePayError";
  constructor(
    message: string,
    public readonly code:
      | "network"
      | "timeout"
      | "auth"
      | "validation"
      | "rate_limited"
      | "not_found"
      | "server"
      | "unknown",
    public readonly httpStatus?: number,
    public readonly bizCode?: string,
    public readonly raw?: unknown
  ) {
    super(message);
  }
}

// ============================================================================
//  Client
// ============================================================================

export class BinancePayClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: BinancePayClientConfig) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Create a payment order. The Agent or backend should redirect the buyer to
   * `response.checkoutUrl` (or call the C2C transfer flow for fully autonomous
   * Agent payments — see Binance Pay merchant docs section "C2C Transfer").
   */
  async createOrder(input: CreateOrderInput): Promise<CreateOrderResponse> {
    const body = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const data = (await this.post("/binancepay/openapi/v3/order", body)) as
      | {
          data: {
            prepayId: string;
            checkoutUrl: string;
            universalUrl?: string;
            expireTime: number;
            terminalType?: string;
          };
        }
      | unknown;
    const inner = (data as { data?: { prepayId?: string } }).data;
    if (!inner || typeof inner.prepayId !== "string") {
      throw new BinancePayError(
        "Binance Pay createOrder returned no prepayId",
        "validation",
        undefined,
        undefined,
        data
      );
    }
    const d = inner as CreateOrderResponse & { raw?: unknown };
    return { ...d, raw: data };
  }

  async queryOrder(input: QueryOrderInput): Promise<QueryOrderResponse> {
    if (!input.merchantTradeNo && !input.prepayId) {
      throw new BinancePayError(
        "queryOrder requires merchantTradeNo or prepayId",
        "validation"
      );
    }
    const data = (await this.post("/binancepay/openapi/v2/order/query", input)) as {
      data?: QueryOrderResponse;
    };
    if (!data.data) {
      throw new BinancePayError(
        "Binance Pay queryOrder returned no data",
        "validation",
        undefined,
        undefined,
        data
      );
    }
    return { ...data.data, raw: data };
  }

  async queryBalance(input: QueryBalanceInput = {}): Promise<QueryBalanceResponse> {
    const data = (await this.post(
      "/binancepay/openapi/v3/merchant/balance/query",
      input
    )) as { data?: { balances?: QueryBalanceResponse["balances"] } };
    return {
      balances: data.data?.balances ?? [],
      raw: data,
    };
  }

  // --------------------------------------------------------------------------
  //  Internals
  // --------------------------------------------------------------------------

  /**
   * Sign a Binance Pay request per spec.
   *
   * payloadToSign = `${timestamp}\n${nonce}\n${requestBody}\n`
   * signature = HMAC_SHA512(apiSecret, payloadToSign).hex.upper()
   *
   * Headers required:
   *   - BinancePay-Timestamp
   *   - BinancePay-Nonce (32 chars [a-zA-Z0-9])
   *   - BinancePay-Certificate-SN  (the merchant API key)
   *   - BinancePay-Signature
   *
   * Reference: https://developers.binance.com/docs/binance-pay/api-sign
   */
  private sign(requestBody: string): {
    timestamp: string;
    nonce: string;
    signature: string;
    apiKey: string;
  } {
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString("hex"); // 32 hex chars
    const payloadToSign = `${timestamp}\n${nonce}\n${requestBody}\n`;
    const signature = createHmac("sha512", this.config.apiSecret)
      .update(payloadToSign)
      .digest("hex")
      .toUpperCase();
    return {
      timestamp,
      nonce,
      signature,
      apiKey: this.config.apiKey,
    };
  }

  private async post(
    path: string,
    body: Record<string, unknown> | unknown
  ): Promise<unknown> {
    const requestBody = JSON.stringify(body);
    const { timestamp, nonce, signature, apiKey } = this.sign(requestBody);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "BinancePay-Timestamp": timestamp,
          "BinancePay-Nonce": nonce,
          "BinancePay-Certificate-SN": apiKey,
          "BinancePay-Signature": signature,
        },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new BinancePayError(
        `Binance Pay request failed: ${reason}`,
        controller.signal.aborted ? "timeout" : "network"
      );
    } finally {
      clearTimeout(timeout);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new BinancePayError(
        "Binance Pay response was not valid JSON",
        "server",
        res.status
      );
    }

    if (!res.ok) {
      throw new BinancePayError(
        `Binance Pay HTTP ${res.status}`,
        res.status === 429
          ? "rate_limited"
          : res.status >= 500
            ? "server"
            : "unknown",
        res.status,
        undefined,
        parsed
      );
    }

    // Binance Pay envelope: { status: "SUCCESS"|"FAIL", code, errorMessage, data }
    const env = parsed as { status?: string; code?: string; errorMessage?: string };
    if (env.status === "FAIL") {
      throw new BinancePayError(
        env.errorMessage ?? "Binance Pay business failure",
        env.code === "401" || env.code === "403"
          ? "auth"
          : env.code === "404"
            ? "not_found"
            : "validation",
        res.status,
        env.code,
        parsed
      );
    }

    return parsed;
  }
}
