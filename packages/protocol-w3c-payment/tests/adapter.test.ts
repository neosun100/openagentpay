import { describe, expect, it } from "vitest";
import { W3cPaymentRequestProtocolAdapter, PROTOCOL_ID, X_PAYMENT_W3C_HEADER, type W3cPayment402Body } from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const baseBody: W3cPayment402Body = {
  w3cPaymentVersion: 1,
  methodData: [
    { supportedMethods: "basic-card" },
    { supportedMethods: "https://apple.com/apple-pay" },
  ],
  details: {
    id: "order-001",
    total: { label: "Total", amount: { currency: "USD", value: "1.99" } },
  },
  merchantOrigin: "https://merchant.example",
  description: "Premium article",
};

describe("W3cPaymentRequestProtocolAdapter", () => {
  it("detects W3C body", () => {
    const a = new W3cPaymentRequestProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: baseBody })).toBe(true);
  });

  it("rejects non-W3C body", () => {
    const a = new W3cPaymentRequestProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });

  it("converts USD 1.99 to atomic 199 (decimals=2)", async () => {
    const a = new W3cPaymentRequestProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.amount.currency).toBe("USD");
    expect(r.amount.decimals).toBe(2);
    expect(r.amount.amountAtomic).toBe("199");
    expect(r.recipient).toBe("https://merchant.example");
    expect(r.nonce).toBe("order-001");
  });

  it("infers JPY decimals = 0", async () => {
    const a = new W3cPaymentRequestProtocolAdapter();
    const body = JSON.parse(JSON.stringify(baseBody));
    body.details.total.amount = { currency: "JPY", value: "300" };
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body });
    expect(r.amount.decimals).toBe(0);
    expect(r.amount.amountAtomic).toBe("300");
  });

  it("infers USDC decimals = 6", async () => {
    const a = new W3cPaymentRequestProtocolAdapter();
    const body = JSON.parse(JSON.stringify(baseBody));
    body.details.total.amount = { currency: "USDC", value: "0.001" };
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body });
    expect(r.amount.decimals).toBe(6);
    expect(r.amount.amountAtomic).toBe("1000");
  });

  it("rejects when preferred method not present", async () => {
    const a = new W3cPaymentRequestProtocolAdapter({ preferredMethods: ["secure-payment-confirmation"] });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/preferred/);
  });

  it("accepts when preferred method present", async () => {
    const a = new W3cPaymentRequestProtocolAdapter({ preferredMethods: ["basic-card"] });
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.protocol).toBe(PROTOCOL_ID);
  });

  it("throws on missing total amount", async () => {
    const a = new W3cPaymentRequestProtocolAdapter();
    const broken: any = JSON.parse(JSON.stringify(baseBody));
    delete broken.details.total.amount;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/amount/);
  });

  it("buildRetry emits X-PAYMENT-W3C base64url payload", async () => {
    const a = new W3cPaymentRequestProtocolAdapter();
    const signed: SignedAuthorization = {
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "199", decimals: 2, currency: "USD" },
        recipient: "https://x", asset: { symbol: "USD", decimals: 2 },
        validAfter: 0, validBefore: 9_999_999_999, nonce: "order-001", rawPayload: {},
      },
      signer: "browser-payment-handler",
      signature: '{"cardNumber":"...masked..."}',
      extra: { methodName: "basic-card", spcAttestation: "AT_BASE64" },
    };
    const env = await a.buildRetry(signed);
    const decoded = JSON.parse(Buffer.from(env.headers[X_PAYMENT_W3C_HEADER]!, "base64url").toString("utf8"));
    expect(decoded.w3cPaymentVersion).toBe(1);
    expect(decoded.methodName).toBe("basic-card");
    expect(decoded.spcAttestation).toBe("AT_BASE64");
  });

  it("rejects malformed decimal in value field", async () => {
    const a = new W3cPaymentRequestProtocolAdapter();
    const body = JSON.parse(JSON.stringify(baseBody));
    body.details.total.amount.value = "1,99";
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body })
    ).rejects.toThrowError(/decimal/);
  });
});
