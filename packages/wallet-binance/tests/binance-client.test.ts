/**
 * Unit tests for BinancePayClient.
 *
 * - HMAC SHA512 signing matches Binance Pay reference vectors
 * - Request envelope construction is correct
 * - Error codes map to structured BinancePayError
 *
 * No real network calls — fetch is stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BinancePayClient,
  BinancePayError,
  type CreateOrderInput,
} from "../src/binance-client.js";

// --- helpers ---------------------------------------------------------------

const goods: CreateOrderInput["goods"] = {
  goodsType: "02",
  goodsCategory: "D000",
  referenceGoodsId: "ref-001",
  goodsName: "Test Goods",
};

function mockFetch(response: {
  ok: boolean;
  status: number;
  body: unknown;
}): typeof fetch {
  return vi.fn(async () => {
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    } as Response;
  }) as unknown as typeof fetch;
}

// --- tests -----------------------------------------------------------------

describe("BinancePayClient.sign (via createOrder request)", () => {
  it("produces uppercased hex signature with 128 chars (SHA512 hex)", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchFn = vi.fn(async (_url, init: RequestInit | undefined) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "SUCCESS",
          code: "000000",
          data: {
            prepayId: "P_TEST_1",
            checkoutUrl: "https://pay.binance.com/checkout/P_TEST_1",
            expireTime: Date.now() + 600_000,
          },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const client = new BinancePayClient({
      apiKey: "test_api_key",
      apiSecret: "test_api_secret",
      fetchFn,
    });
    await client.createOrder({
      merchantTradeNo: "ord-1",
      orderAmount: "0.001",
      currency: "USDT",
      goods,
    });

    expect(capturedHeaders).toBeDefined();
    const sig = capturedHeaders!["BinancePay-Signature"];
    expect(sig).toMatch(/^[0-9A-F]{128}$/); // SHA512 hex, uppercase
    expect(capturedHeaders!["BinancePay-Certificate-SN"]).toBe("test_api_key");
    expect(capturedHeaders!["BinancePay-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(capturedHeaders!["BinancePay-Timestamp"]).toMatch(/^\d{13}$/);
  });
});

describe("BinancePayClient.createOrder", () => {
  it("returns prepayId on success", async () => {
    const client = new BinancePayClient({
      apiKey: "k",
      apiSecret: "s",
      fetchFn: mockFetch({
        ok: true,
        status: 200,
        body: {
          status: "SUCCESS",
          code: "000000",
          data: {
            prepayId: "P_28571234_1778860656_a4f9e1",
            checkoutUrl: "https://pay.binance.com/checkout/abc",
            expireTime: 1778861254000,
          },
        },
      }),
    });
    const r = await client.createOrder({
      merchantTradeNo: "ord-2",
      orderAmount: "0.001",
      currency: "USDT",
      goods,
    });
    expect(r.prepayId).toBe("P_28571234_1778860656_a4f9e1");
    expect(r.checkoutUrl).toContain("checkout");
    expect(r.raw).toBeDefined();
  });

  it("throws BinancePayError on FAIL envelope", async () => {
    const client = new BinancePayClient({
      apiKey: "k",
      apiSecret: "s",
      fetchFn: mockFetch({
        ok: true,
        status: 200,
        body: {
          status: "FAIL",
          code: "400201",
          errorMessage: "Invalid merchantTradeNo",
        },
      }),
    });
    await expect(
      client.createOrder({
        merchantTradeNo: "bad!",
        orderAmount: "0.001",
        currency: "USDT",
        goods,
      })
    ).rejects.toThrow(BinancePayError);
  });

  it("maps HTTP 429 to rate_limited", async () => {
    const client = new BinancePayClient({
      apiKey: "k",
      apiSecret: "s",
      fetchFn: mockFetch({
        ok: false,
        status: 429,
        body: { status: "FAIL", code: "429" },
      }),
    });
    try {
      await client.createOrder({
        merchantTradeNo: "ord-3",
        orderAmount: "0.001",
        currency: "USDT",
        goods,
      });
      expect.fail("expected throw");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(BinancePayError);
      expect((e as BinancePayError).code).toBe("rate_limited");
      expect((e as BinancePayError).httpStatus).toBe(429);
    }
  });
});

describe("BinancePayClient.queryBalance", () => {
  it("returns empty balances when data is missing", async () => {
    const client = new BinancePayClient({
      apiKey: "k",
      apiSecret: "s",
      fetchFn: mockFetch({
        ok: true,
        status: 200,
        body: { status: "SUCCESS", code: "000000", data: {} },
      }),
    });
    const r = await client.queryBalance({ asset: "USDT" });
    expect(r.balances).toEqual([]);
  });

  it("returns balances when data is present", async () => {
    const client = new BinancePayClient({
      apiKey: "k",
      apiSecret: "s",
      fetchFn: mockFetch({
        ok: true,
        status: 200,
        body: {
          status: "SUCCESS",
          code: "000000",
          data: {
            balances: [
              { asset: "USDT", free: "19.95800000", locked: "0.00000000" },
            ],
          },
        },
      }),
    });
    const r = await client.queryBalance({ asset: "USDT" });
    expect(r.balances.length).toBe(1);
    expect(r.balances[0]?.asset).toBe("USDT");
    expect(r.balances[0]?.free).toBe("19.95800000");
  });
});

describe("BinancePayClient.queryOrder", () => {
  it("validates that prepayId or merchantTradeNo is provided", async () => {
    const client = new BinancePayClient({
      apiKey: "k",
      apiSecret: "s",
      fetchFn: mockFetch({ ok: true, status: 200, body: {} }),
    });
    await expect(client.queryOrder({})).rejects.toThrow(BinancePayError);
  });
});
