/**
 * Tests for X402ProtocolAdapter.
 *
 * Coverage:
 *   - detect() positive/negative
 *   - parsePaymentRequired() success
 *   - rejects malformed body / missing fields / wrong version
 *   - selectAccept picks first matching scheme+network
 *   - assetRegistry resolves known token addresses to symbol+decimals
 *   - buildRetry emits X-PAYMENT base64url JSON
 *   - decodePaymentHeader round-trips
 *   - CAIP-2 chain mapping
 */

import { describe, expect, it } from "vitest";
import {
  X402ProtocolAdapter,
  decodePaymentHeader,
  PROTOCOL_ID_V1,
  X_PAYMENT_HEADER,
  type X402AcceptEntry,
} from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const baseAccept: X402AcceptEntry = {
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: "1000",
  resource: "https://api.example.com/data",
  description: "Premium data access",
  mimeType: "application/json",
  payTo: "0x000000000000000000000000000000000000dead",
  maxTimeoutSeconds: 60,
  asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  extra: { name: "USDC", version: "2" },
};

const baseBody = (accepts: X402AcceptEntry[] = [baseAccept]) => ({
  x402Version: 1,
  accepts,
});

// ----------------------------------------------------------------------------
//  detect()
// ----------------------------------------------------------------------------

describe("X402ProtocolAdapter.detect", () => {
  it("accepts a valid x402 v1 body", () => {
    const a = new X402ProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: baseBody() })).toBe(true);
  });

  it("accepts x402 v2", () => {
    const a = new X402ProtocolAdapter();
    expect(
      a.detect({
        statusCode: 402,
        headers: {},
        body: { x402Version: 2, accepts: [baseAccept] },
      })
    ).toBe(true);
  });

  it("rejects unsupported versions", () => {
    const a = new X402ProtocolAdapter();
    expect(
      a.detect({
        statusCode: 402,
        headers: {},
        body: { x402Version: 99, accepts: [baseAccept] },
      })
    ).toBe(false);
  });

  it("rejects bodies without x402Version", () => {
    const a = new X402ProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { ap2Version: "0.1" } })).toBe(false);
  });

  it("rejects empty accepts[]", () => {
    const a = new X402ProtocolAdapter();
    expect(
      a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1, accepts: [] } })
    ).toBe(false);
  });

  it("rejects non-object bodies", () => {
    const a = new X402ProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: "not-an-object" })).toBe(false);
  });
});

// ----------------------------------------------------------------------------
//  parsePaymentRequired()
// ----------------------------------------------------------------------------

describe("X402ProtocolAdapter.parsePaymentRequired", () => {
  it("parses a valid body into a PaymentRequest with USDC + 6 decimals", async () => {
    const a = new X402ProtocolAdapter();
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: baseBody(),
    });
    expect(r.protocol).toBe(PROTOCOL_ID_V1);
    expect(r.amount.amountAtomic).toBe("1000");
    expect(r.amount.currency).toBe("USDC");
    expect(r.amount.decimals).toBe(6);
    expect(r.recipient).toBe(baseAccept.payTo);
    expect(r.asset.contract).toBe(baseAccept.asset);
    expect(r.asset.chain).toBe("eip155:84532"); // CAIP-2 mapping
    expect(r.description).toBe("Premium data access");
  });

  it("uses asset registry for known USDC contracts", async () => {
    const a = new X402ProtocolAdapter();
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: baseBody([
        { ...baseAccept, asset: "0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913" }, // Base mainnet USDC
      ]),
    });
    expect(r.amount.currency).toBe("USDC");
    expect(r.amount.decimals).toBe(6);
  });

  it("falls back to extra.decimals when asset not in registry", async () => {
    const a = new X402ProtocolAdapter();
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: baseBody([
        {
          ...baseAccept,
          asset: "0xUNKNOWNTOKEN1234567890",
          extra: { decimals: 18, name: "WHSK" },
        },
      ]),
    });
    expect(r.amount.decimals).toBe(18);
    expect(r.amount.currency).toBe("WHSK");
  });

  it("picks the first matching scheme+network", async () => {
    const a = new X402ProtocolAdapter({
      preferredNetworks: ["base", "base-sepolia"],
    });
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: baseBody([
        { ...baseAccept, network: "ethereum" },
        { ...baseAccept, network: "base-sepolia", payTo: "0xWINNER" },
        { ...baseAccept, network: "base", payTo: "0xLATER" },
      ]),
    });
    expect(r.recipient).toBe("0xWINNER"); // first preferredNetwork match
  });

  it("throws when no scheme+network matches", async () => {
    const a = new X402ProtocolAdapter({ preferredNetworks: ["polygon"] });
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: baseBody(),
      })
    ).rejects.toThrowError(/No supported \(scheme,network\)/);
  });

  it("throws on missing required field", async () => {
    const a = new X402ProtocolAdapter();
    const { payTo: _drop, ...withoutPayTo } = baseAccept;
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: { x402Version: 1, accepts: [withoutPayTo as unknown as X402AcceptEntry] },
      })
    ).rejects.toThrowError(/missing field: payTo/);
  });

  it("throws on unsupported version", async () => {
    const a = new X402ProtocolAdapter();
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: { x402Version: 99, accepts: [baseAccept] },
      })
    ).rejects.toThrowError(ProtocolError);
  });

  it("respects maxTimeoutSeconds for validBefore calculation", async () => {
    const a = new X402ProtocolAdapter({ now: () => 1_000_000_000_000 });
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: baseBody([{ ...baseAccept, maxTimeoutSeconds: 300 }]),
    });
    expect(r.validBefore).toBe(1_000_000_000 + 300);
  });

  it("custom selector overrides preferredNetworks", async () => {
    const a = new X402ProtocolAdapter({
      preferredNetworks: ["base"],
      selectAccept: (accepts) => accepts[accepts.length - 1], // pick last
    });
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: baseBody([
        { ...baseAccept, payTo: "0xFIRST" },
        { ...baseAccept, payTo: "0xLAST", network: "polygon" },
      ]),
    });
    expect(r.recipient).toBe("0xLAST");
  });
});

// ----------------------------------------------------------------------------
//  buildRetry()
// ----------------------------------------------------------------------------

describe("X402ProtocolAdapter.buildRetry", () => {
  it("emits X-PAYMENT header with base64url-encoded payload", async () => {
    const a = new X402ProtocolAdapter();
    const signed: SignedAuthorization = {
      request: {
        protocol: PROTOCOL_ID_V1,
        amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
        recipient: "0xRECIPIENT",
        asset: { symbol: "USDC", decimals: 6, chain: "eip155:84532" },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0xabc",
        rawPayload: {},
      },
      signer: "0xSIGNER",
      signature: "0xSIG",
    };
    const env = await a.buildRetry(signed);
    expect(env.headers[X_PAYMENT_HEADER]).toBeTypeOf("string");
    expect(env.headers[X_PAYMENT_HEADER]).not.toMatch(/[+/=]/); // base64url

    const decoded = decodePaymentHeader(env.headers[X_PAYMENT_HEADER]!);
    expect(decoded.x402Version).toBe(1);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("base-sepolia"); // mapped from CAIP-2
    expect(decoded.payload.signature).toBe("0xSIG");
    expect(decoded.payload.authorization.from).toBe("0xSIGNER");
    expect(decoded.payload.authorization.to).toBe("0xRECIPIENT");
    expect(decoded.payload.authorization.value).toBe("1000");
    expect(decoded.payload.authorization.nonce).toBe("0xabc");
  });

  it("uses signed.extra.network when provided", async () => {
    const a = new X402ProtocolAdapter();
    const env = await a.buildRetry({
      request: {
        protocol: PROTOCOL_ID_V1,
        amount: { amountAtomic: "100", decimals: 6, currency: "USDC" },
        recipient: "0xR",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 999,
        nonce: "0xn",
        rawPayload: {},
      },
      signer: "0xS",
      signature: "0xsig",
      extra: { network: "polygon" },
    });
    const decoded = decodePaymentHeader(env.headers[X_PAYMENT_HEADER]!);
    expect(decoded.network).toBe("polygon");
  });

  it("rejects when signature missing", async () => {
    const a = new X402ProtocolAdapter();
    await expect(
      a.buildRetry({
        request: {
          protocol: PROTOCOL_ID_V1,
          amount: { amountAtomic: "1", decimals: 6, currency: "USDC" },
          recipient: "0xR",
          asset: { symbol: "USDC", decimals: 6 },
          validAfter: 0,
          validBefore: 1,
          nonce: "0x0",
          rawPayload: {},
        },
        signer: "0xS",
        signature: "",
      })
    ).rejects.toThrowError(/signature/);
  });

  it("rejects when network cannot be inferred", async () => {
    const a = new X402ProtocolAdapter();
    await expect(
      a.buildRetry({
        request: {
          protocol: PROTOCOL_ID_V1,
          amount: { amountAtomic: "1", decimals: 6, currency: "USDC" },
          recipient: "0xR",
          asset: { symbol: "USDC", decimals: 6 }, // no chain
          validAfter: 0,
          validBefore: 1,
          nonce: "0x0",
          rawPayload: {},
        },
        signer: "0xS",
        signature: "0xsig",
        // no extra.network either
      })
    ).rejects.toThrowError(/network/);
  });
});

// ----------------------------------------------------------------------------
//  decodePaymentHeader
// ----------------------------------------------------------------------------

describe("decodePaymentHeader", () => {
  it("round-trips with buildRetry", async () => {
    const a = new X402ProtocolAdapter();
    const env = await a.buildRetry({
      request: {
        protocol: PROTOCOL_ID_V1,
        amount: { amountAtomic: "5000", decimals: 6, currency: "USDC" },
        recipient: "0xMERCHANT",
        asset: { symbol: "USDC", decimals: 6, chain: "eip155:8453" },
        validAfter: 100,
        validBefore: 200,
        nonce: "0xff",
        rawPayload: {},
      },
      signer: "0xPAYER",
      signature: "0x" + "a".repeat(130),
    });
    const decoded = decodePaymentHeader(env.headers[X_PAYMENT_HEADER]!);
    expect(decoded.network).toBe("base");
    expect(decoded.payload.authorization.value).toBe("5000");
  });

  it("throws ProtocolError on garbage input", () => {
    expect(() => decodePaymentHeader("!!!not-base64!!!")).toThrowError(ProtocolError);
  });
});

// ----------------------------------------------------------------------------
//  Integration with ProtocolRouter (sanity)
// ----------------------------------------------------------------------------

import { ProtocolRouter } from "@openagentpay/core";

describe("X402ProtocolAdapter — integrates with ProtocolRouter", () => {
  it("ProtocolRouter dispatches x402 bodies to this adapter", async () => {
    const x402 = new X402ProtocolAdapter();
    const router = new ProtocolRouter({ adapters: [x402] });
    const r = await router.route({
      statusCode: 402,
      headers: {},
      body: baseBody(),
    });
    expect(r.adapter.id).toBe(PROTOCOL_ID_V1);
    expect(r.request.protocol).toBe(PROTOCOL_ID_V1);
    expect(r.request.amount.currency).toBe("USDC");
  });
});
