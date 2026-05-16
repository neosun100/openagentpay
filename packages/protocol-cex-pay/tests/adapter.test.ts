/**
 * Tests for CexPayAdapter (OAP-CEX v0.1).
 *
 * Coverage:
 *   - detect() positive/negative
 *   - parsePaymentRequired() success
 *   - parsePaymentRequired() rejects: wrong scheme / wrong version /
 *     missing fields / expired / no matching provider
 *   - buildRetry() requires encoded
 *   - encode/decode wire token roundtrips
 */

import { describe, expect, it } from "vitest";
import { ProtocolError } from "@openagentpay/core";
import {
  CexPayAdapter,
  PROTOCOL_ID,
  X_PAYMENT_CEX_HEADER,
  decodeWireToken,
  encodeWireToken,
  type OapCex402Body,
  type OapCexWireToken,
} from "../src/adapter.js";

const baseAccept = {
  provider: "binance-pay",
  asset: "USDT",
  amount: "1000",
  amountDecimals: 6,
  recipient: "merchant_28571234",
  recipientType: "merchant_id" as const,
  validBefore: 9_999_999_999, // year 2286, won't expire in test runs
  nonce: "0x1aef000000000000000000000000000000000000000000000000000000008d92",
};

const baseBody: OapCex402Body = {
  oapCexVersion: 1,
  scheme: "cex-pay",
  accepts: [baseAccept],
  description: "Premium analytics report",
};

describe("CexPayAdapter.detect", () => {
  it("accepts a valid OAP-CEX 402 body", () => {
    const a = new CexPayAdapter();
    expect(
      a.detect({ statusCode: 402, headers: {}, body: baseBody })
    ).toBe(true);
  });

  it("rejects an x402 body", () => {
    const a = new CexPayAdapter();
    expect(
      a.detect({
        statusCode: 402,
        headers: {},
        body: { x402Version: 1, scheme: "exact" },
      })
    ).toBe(false);
  });

  it("rejects when oapCexVersion is wrong type", () => {
    const a = new CexPayAdapter();
    expect(
      a.detect({
        statusCode: 402,
        headers: {},
        body: { oapCexVersion: "1", scheme: "cex-pay", accepts: [baseAccept] },
      })
    ).toBe(false);
  });

  it("rejects unsupported version", () => {
    const a = new CexPayAdapter();
    expect(
      a.detect({
        statusCode: 402,
        headers: {},
        body: { oapCexVersion: 99, scheme: "cex-pay", accepts: [baseAccept] },
      })
    ).toBe(false);
  });
});

describe("CexPayAdapter.parsePaymentRequired", () => {
  it("parses a valid body into a PaymentRequest", async () => {
    const a = new CexPayAdapter();
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: baseBody,
    });
    expect(r.protocol).toBe(PROTOCOL_ID);
    expect(r.amount.amountAtomic).toBe("1000");
    expect(r.amount.currency).toBe("USDT");
    expect(r.recipient).toBe("merchant_28571234");
    expect(r.nonce).toBe(baseAccept.nonce);
    expect(r.description).toBe("Premium analytics report");
  });

  it("preserves the raw payload for forensics", async () => {
    const a = new CexPayAdapter();
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: baseBody,
    });
    expect(r.rawPayload).toMatchObject({ selectedAccept: baseAccept });
  });

  it("throws on wrong scheme", async () => {
    const a = new CexPayAdapter();
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: { oapCexVersion: 1, scheme: "x402-exact", accepts: [baseAccept] },
      })
    ).rejects.toThrowError(ProtocolError);
  });

  it("throws on unsupported version", async () => {
    const a = new CexPayAdapter();
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: { oapCexVersion: 99, scheme: "cex-pay", accepts: [baseAccept] },
      })
    ).rejects.toThrowError(ProtocolError);
  });

  it("throws on missing field", async () => {
    const a = new CexPayAdapter();
    const { nonce: _drop, ...withoutNonce } = baseAccept;
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: {
          oapCexVersion: 1,
          scheme: "cex-pay",
          accepts: [withoutNonce as unknown as typeof baseAccept],
        },
      })
    ).rejects.toThrowError(/missing field: nonce/);
  });

  it("throws on empty accepts[]", async () => {
    const a = new CexPayAdapter();
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: { oapCexVersion: 1, scheme: "cex-pay", accepts: [] },
      })
    ).rejects.toThrowError(/non-empty array/);
  });

  it("throws when authorization already expired", async () => {
    const a = new CexPayAdapter({ now: () => 10_000_000_000_000 });
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: baseBody,
      })
    ).rejects.toThrowError(/already expired/);
  });

  it("picks the preferred provider when present", async () => {
    const a = new CexPayAdapter({ preferredProviders: ["okx-pay", "binance-pay"] });
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: {
        oapCexVersion: 1,
        scheme: "cex-pay",
        accepts: [
          baseAccept,
          { ...baseAccept, provider: "okx-pay", recipient: "okx_5172" },
        ],
      },
    });
    expect(r.recipient).toBe("okx_5172");
  });

  it("throws when no preferred provider matches", async () => {
    const a = new CexPayAdapter({ preferredProviders: ["bybit-pay"] });
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: baseBody,
      })
    ).rejects.toThrowError(/No supported provider/);
  });
});

describe("CexPayAdapter.buildRetry", () => {
  it("returns the encoded token in X-PAYMENT-CEX header", async () => {
    const a = new CexPayAdapter();
    const env = await a.buildRetry({
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
        recipient: "merchant_x",
        asset: { symbol: "USDT", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0xdead",
        rawPayload: {},
      },
      signer: "agent_1",
      signature: "abc",
      encoded: "ENCODED_TOKEN_HERE",
    });
    expect(env.headers[X_PAYMENT_CEX_HEADER]).toBe("ENCODED_TOKEN_HERE");
  });

  it("rejects when encoded is missing", async () => {
    const a = new CexPayAdapter();
    await expect(
      a.buildRetry({
        request: {
          protocol: PROTOCOL_ID,
          amount: { amountAtomic: "1000", decimals: 6, currency: "USDT" },
          recipient: "merchant_x",
          asset: { symbol: "USDT", decimals: 6 },
          validAfter: 0,
          validBefore: 9_999_999_999,
          nonce: "0xdead",
          rawPayload: {},
        },
        signer: "agent_1",
        signature: "abc",
      })
    ).rejects.toThrowError(/encoded is required/);
  });
});

describe("encodeWireToken / decodeWireToken", () => {
  const token: OapCexWireToken = {
    oapCexVersion: 1,
    scheme: "cex-pay",
    provider: "binance-pay",
    authorization: {
      asset: "USDT",
      amount: "1000",
      amountDecimals: 6,
      from: "agent_94821",
      to: "merchant_28571234",
      nonce: baseAccept.nonce,
      validBefore: 9_999_999_999,
      signedAt: 1778860654,
    },
    signature: { alg: "HMAC-SHA512", value: "9b3f1ae" },
    providerExtensions: { binancePayPrepayId: "P_TEST_1" },
  };

  it("roundtrips losslessly", () => {
    const encoded = encodeWireToken(token);
    const decoded = decodeWireToken(encoded);
    expect(decoded).toEqual(token);
  });

  it("emits base64url (no padding, no slash, no plus)", () => {
    const encoded = encodeWireToken(token);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("throws ProtocolError on garbage input", () => {
    expect(() => decodeWireToken("not-base64-or-json!!!@@@")).toThrowError();
  });
});
