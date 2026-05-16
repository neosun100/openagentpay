/**
 * Tests for BinancePayConnector — uses MemoryInstrumentStore + mocked fetch.
 *
 * Coverage:
 *   - getCapabilities is pure
 *   - createInstrument is idempotent
 *   - getBalance converts major-unit string to atomic correctly
 *   - signAuthorization produces a valid OAP-CEX wire token
 *   - settle creates a Binance Pay order and returns prepayId
 *   - settle maps Binance errors to structured codes
 *   - signAuthorization rejects wrong protocol id
 *   - atomic <-> major helpers are correct
 */
import { describe, expect, it, vi } from "vitest";
import {
  type CreateInstrumentInput,
  type Money,
  type PaymentRequest,
  type ProtocolId,
  type UserId,
} from "@openagentpay/core";
import {
  decodeWireToken,
  PROTOCOL_ID as OAP_CEX_PROTOCOL_ID,
} from "@openagentpay/protocol-cex-pay";
import {
  BinancePayConnector,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
  __internal,
} from "../src/connector.js";

const FIXED_NOW_MS = 1778860654_000;

function mockFetch(handler: (path: string, body: unknown) => unknown): typeof fetch {
  return vi.fn(async (url: unknown, init: RequestInit | undefined) => {
    const u = String(url);
    const path = u.replace(/^https?:\/\/[^/]+/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const response = handler(path, body);
    return {
      ok: true,
      status: 200,
      json: async () => response,
    } as Response;
  }) as unknown as typeof fetch;
}

function makeConnector(fetchFn?: typeof fetch): BinancePayConnector {
  return new BinancePayConnector({
    apiKey: "test_api_key",
    apiSecret: "test_api_secret",
    merchantId: "28571234",
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    fetchFn:
      fetchFn ??
      mockFetch((path) => {
        if (path.endsWith("/v3/order")) {
          return {
            status: "SUCCESS",
            code: "000000",
            data: {
              prepayId: "P_TEST_PREPAY",
              checkoutUrl: "https://pay.binance.com/checkout/X",
              expireTime: FIXED_NOW_MS + 600_000,
            },
          };
        }
        if (path.includes("balance/query")) {
          return {
            status: "SUCCESS",
            code: "000000",
            data: { balances: [{ asset: "USDT", free: "19.95800000", locked: "0.0" }] },
          };
        }
        return { status: "SUCCESS", code: "000000", data: {} };
      }),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

describe("BinancePayConnector.getCapabilities", () => {
  it("reports binance-pay provider with sandbox + gas-free features", () => {
    const c = makeConnector();
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(false);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDT")).toBeDefined();
    expect(caps.supportedProtocols).toContain(OAP_CEX_PROTOCOL_ID);
  });
});

describe("BinancePayConnector.createInstrument", () => {
  it("is idempotent — same userId returns same instrument", async () => {
    const c = makeConnector();
    const a = await c.createInstrument(createInput);
    const b = await c.createInstrument(createInput);
    expect(a.id).toBe(b.id);
    expect(a.userId).toBe("alice");
    expect(a.publicHandle).toBe("28571234");
  });

  it("derives a stable instrument id from (merchantId, userId)", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    expect(i.id).toMatch(/^payment-instrument-bnpay-[0-9a-f]{16}$/);
  });
});

describe("BinancePayConnector.getBalance", () => {
  it("converts major-unit string to atomic integer", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    const b = await c.getBalance(i.id);
    expect(b.money.currency).toBe("USDT");
    expect(b.money.decimals).toBe(6);
    expect(b.money.amountAtomic).toBe("19958000"); // 19.95800000 USDT
  });

  it("throws when instrument unknown", async () => {
    const c = makeConnector();
    // @ts-expect-error testing invalid input
    await expect(c.getBalance("payment-instrument-bnpay-nonexistent")).rejects.toThrow(
      /Instrument not found/
    );
  });
});

describe("BinancePayConnector.signAuthorization", () => {
  it("produces a valid OAP-CEX wire token", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    const session = makeSession();
    const req: PaymentRequest = {
      protocol: OAP_CEX_PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
      recipient: "merchant_99999",
      asset: { symbol: "USDT", decimals: 6 },
      validAfter: 0,
      validBefore: Math.floor(FIXED_NOW_MS / 1000) + 600,
      nonce: "0xabcd",
      rawPayload: {},
    };
    const signed = await c.signAuthorization({
      instrumentId: i.id,
      request: req,
      session,
    });
    expect(signed.signer).toBe("28571234");
    expect(signed.signature).toMatch(/^[0-9A-F]{128}$/); // SHA512 hex upper
    expect(signed.encoded).toBeDefined();
    const decoded = decodeWireToken(signed.encoded!);
    expect(decoded.scheme).toBe("cex-pay");
    expect(decoded.provider).toBe("binance-pay");
    expect(decoded.authorization.amount).toBe("1000");
    expect(decoded.authorization.to).toBe("merchant_99999");
    expect(decoded.signature.alg).toBe("HMAC-SHA512");
  });

  it("rejects wrong protocol id", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    const session = makeSession();
    await expect(
      c.signAuthorization({
        instrumentId: i.id,
        request: {
          protocol: "x402-v1" as ProtocolId,
          amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
          recipient: "x",
          asset: { symbol: "USDT", decimals: 6 },
          validAfter: 0,
          validBefore: 9_999_999_999,
          nonce: "0xa",
          rawPayload: {},
        },
        session,
      })
    ).rejects.toThrow(/only supports protocol/);
  });
});

describe("BinancePayConnector.settle", () => {
  it("creates an order and returns prepayId as transactionRef", async () => {
    const c = makeConnector();
    const i = await c.createInstrument(createInput);
    const req: PaymentRequest = {
      protocol: OAP_CEX_PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
      recipient: "merchant_99999",
      asset: { symbol: "USDT", decimals: 6 },
      validAfter: 0,
      validBefore: Math.floor(FIXED_NOW_MS / 1000) + 600,
      nonce: "0xabcd",
      rawPayload: {},
      description: "test order",
    };
    const session = makeSession();
    const signed = await c.signAuthorization({ instrumentId: i.id, request: req, session });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toBe("P_TEST_PREPAY");
    expect(result.network).toMatch(/binance-pay/);
    expect(result.settledAmount).toEqual<Money>(req.amount);
  });

  it("maps Binance auth error to signature_invalid", async () => {
    const c = makeConnector(
      mockFetch((path) => {
        if (path.endsWith("/v3/order")) {
          return { status: "FAIL", code: "401", errorMessage: "Invalid signature" };
        }
        return { status: "SUCCESS", code: "000000", data: {} };
      })
    );
    const i = await c.createInstrument(createInput);
    const req: PaymentRequest = {
      protocol: OAP_CEX_PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
      recipient: "merchant_99999",
      asset: { symbol: "USDT", decimals: 6 },
      validAfter: 0,
      validBefore: Math.floor(FIXED_NOW_MS / 1000) + 600,
      nonce: "0xabcd",
      rawPayload: {},
    };
    const session = makeSession();
    const signed = await c.signAuthorization({ instrumentId: i.id, request: req, session });
    const result = await c.settle(signed);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });
});

describe("__internal.atomicToMajor / toAtomic", () => {
  it("toAtomic: 19.95800000 / 6 → 19958000", () => {
    expect(__internal.toAtomic("19.95800000", 6)).toBe("19958000");
  });

  it("toAtomic: 0 / 6 → 0", () => {
    expect(__internal.toAtomic("0", 6)).toBe("0");
  });

  it("atomicToMajor: 1000 / 6 → 0.001000", () => {
    expect(__internal.atomicToMajor("1000", 6)).toBe("0.001000");
  });

  it("atomicToMajor: 19958000 / 6 → 19.958000", () => {
    expect(__internal.atomicToMajor("19958000", 6)).toBe("19.958000");
  });
});

// ---- helpers ---------------------------------------------------------------

function makeSession() {
  const usd: Money = { amountAtomic: "1000000", decimals: 6, currency: "USDC" };
  return {
    id: "sess-1" as never,
    userId: userAlice,
    budget: usd,
    spent: { amountAtomic: "0", decimals: 6, currency: "USDC" } as Money,
    expiresAt: new Date(FIXED_NOW_MS + 3_600_000).toISOString(),
    createdAt: new Date(FIXED_NOW_MS).toISOString(),
    updatedAt: new Date(FIXED_NOW_MS).toISOString(),
    status: "active" as const,
  };
}
