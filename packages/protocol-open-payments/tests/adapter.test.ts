import { describe, it, expect } from "vitest";
import { OpenPaymentsProtocolAdapter, PROTOCOL_ID } from "../src/adapter.js";

const valid = {
  openPaymentsVersion: "1.0",
  incomingPayment: {
    id: "https://wallet.example/incoming-payments/abc",
    walletAddress: "https://wallet.example/alice",
    incomingAmount: { value: "1000", assetCode: "USD", assetScale: 2 },
    description: "API access",
  },
  quote: {
    id: "https://wallet.example/quotes/xyz",
    debitAmount: { value: "1010", assetCode: "USD", assetScale: 2 },
    receiveAmount: { value: "1000", assetCode: "USD", assetScale: 2 },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  },
  authServer: "https://auth.example/",
  resourceServer: "https://wallet.example/",
};

describe("OpenPaymentsProtocolAdapter", () => {
  it("detects valid", () => {
    const a = new OpenPaymentsProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: valid })).toBe(true);
  });

  it("rejects non-402", () => {
    const a = new OpenPaymentsProtocolAdapter();
    expect(a.detect({ statusCode: 200 as 402, headers: {}, body: valid })).toBe(false);
  });

  it("parses to PaymentRequest with debitAmount", async () => {
    const a = new OpenPaymentsProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: valid });
    expect(r.protocol).toBe(PROTOCOL_ID);
    expect(r.amount.amountAtomic).toBe("1010");
    expect(r.amount.currency).toBe("USD");
  });

  it("uses quote.id as nonce", async () => {
    const a = new OpenPaymentsProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: valid });
    expect(r.nonce).toBe(valid.quote.id);
  });

  it("rejects body missing authServer", async () => {
    const a = new OpenPaymentsProtocolAdapter();
    await expect(
      (async () => {
        const { authServer: _, ...broken } = valid;
        await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken });
      })()
    ).rejects.toThrow();
  });

  it("buildRetry returns GNAP-prefixed header", async () => {
    const a = new OpenPaymentsProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: valid });
    const env = await a.buildRetry({ request: r, signer: "alice", signature: "abc" });
    expect(env.headers["X-PAYMENT-OPENPAYMENTS"]).toMatch(/^GNAP /);
  });
});
