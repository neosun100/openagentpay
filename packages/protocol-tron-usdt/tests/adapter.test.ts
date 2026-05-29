import { describe, it, expect } from "vitest";
import { TronUsdtProtocolAdapter, PROTOCOL_ID } from "../src/adapter.js";

const valid = {
  tronUsdtVersion: "1.0",
  network: "shasta" as const,
  contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  amount: { value: "1000000", currency: "USDT", decimals: 6 },
  recipient: "TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY",  // 34-char base58 starting with T
  validBefore: Math.floor(Date.now() / 1000) + 600,
  nonce: "0xnoncedeadbeef",
};

describe("TronUsdtProtocolAdapter", () => {
  it("detects valid envelope", () => {
    const a = new TronUsdtProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: valid })).toBe(true);
  });

  it("rejects non-402", () => {
    const a = new TronUsdtProtocolAdapter();
    expect(a.detect({ statusCode: 200 as 402, headers: {}, body: valid })).toBe(false);
  });

  it("parses PaymentRequest with contract field", async () => {
    const a = new TronUsdtProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: valid });
    expect(r.protocol).toBe(PROTOCOL_ID);
    expect(r.recipient).toBe(valid.recipient);
    expect(r.asset.contract).toBe(valid.contract);
  });

  it("rejects malformed recipient (not 34-char base58)", async () => {
    const a = new TronUsdtProtocolAdapter();
    await expect(
      (async () =>
        a.parsePaymentRequired({
          statusCode: 402,
          headers: {},
          body: { ...valid, recipient: "0xnotTron" },
        }))()
    ).rejects.toThrow();
  });

  it("buildRetry produces base64url-encoded header", async () => {
    const a = new TronUsdtProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: valid });
    const env = await a.buildRetry({
      request: r,
      signer: "TSigner1234567890123456789012345678",
      signature: "0xsig",
    });
    expect(typeof env.headers["X-PAYMENT-TRON"]).toBe("string");
  });
});
