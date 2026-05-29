import { describe, expect, it } from "vitest";
import { MppProtocolAdapter, PROTOCOL_ID, X_PAYMENT_MPP_HEADER, type Mpp402Body } from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const baseBody: Mpp402Body = {
  mppVersion: "0.1",
  merchant: { id: "stripe_acct_001", name: "Example Merchant", rails: ["tempo", "x402", "card"] },
  amount: { value: "1000", currency: "USDC", decimals: 6 },
  settlement: { rail: "tempo", details: { recipient: "tempo:merchant_001" } },
  description: "API access",
};

describe("MppProtocolAdapter", () => {
  it("detects MPP body", () => {
    const a = new MppProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: baseBody })).toBe(true);
  });
  it("rejects non-MPP body", () => {
    const a = new MppProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });

  it("parses to PaymentRequest", async () => {
    const a = new MppProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.amount.amountAtomic).toBe("1000");
    expect(r.amount.currency).toBe("USDC");
    expect(r.recipient).toBe("tempo:merchant_001");
  });

  it("rejects when rail not in preferred", async () => {
    const a = new MppProtocolAdapter({ preferredRails: ["card"] });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/preferred rails/);
  });

  it("rejects untrusted merchant", async () => {
    const a = new MppProtocolAdapter({ trustedMerchants: ["other_merchant"] });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/not trusted/);
  });

  it("rejects unsupported version", async () => {
    const a = new MppProtocolAdapter();
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { ...baseBody, mppVersion: "9.9" } })
    ).rejects.toThrowError(ProtocolError);
  });

  it("throws on missing merchant.id", async () => {
    const a = new MppProtocolAdapter();
    const broken: any = JSON.parse(JSON.stringify(baseBody));
    delete broken.merchant.id;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/merchant.id/);
  });

  it("buildRetry emits X-PAYMENT-MPP header", async () => {
    const a = new MppProtocolAdapter();
    const signed: SignedAuthorization = {
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
        recipient: "tempo:m1", asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0, validBefore: 9_999_999_999, nonce: "n", rawPayload: {},
      },
      signer: "agent",
      signature: "0xsig",
    };
    const env = await a.buildRetry(signed);
    const decoded = JSON.parse(Buffer.from(env.headers[X_PAYMENT_MPP_HEADER]!, "base64url").toString("utf8"));
    expect(decoded.mppVersion).toBe("0.1");
    expect(decoded.signature).toBe("0xsig");
  });
});
