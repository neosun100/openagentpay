import { describe, it, expect } from "vitest";
import { Erc7777ProtocolAdapter, PROTOCOL_ID } from "../src/adapter.js";

const validBody = {
  erc7777Version: "1.0",
  identityRegistry: "0xRegistry",
  agentId: "0xAgent01",
  ruleSet: "0xRules01",
  attestation: "0xAttest01",
  settlement: {
    amount: { value: "1000000", currency: "USDC", decimals: 6 },
    recipient: "0xMerchant",
    chain: "eip155:1",
  },
};

describe("Erc7777ProtocolAdapter", () => {
  it("has stable id", () => {
    const a = new Erc7777ProtocolAdapter();
    expect(a.id).toBe(PROTOCOL_ID);
  });

  it("detects valid 402 envelope", () => {
    const a = new Erc7777ProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: validBody })).toBe(true);
  });

  it("rejects non-402", () => {
    const a = new Erc7777ProtocolAdapter();
    expect(a.detect({ statusCode: 200 as 402, headers: {}, body: validBody })).toBe(false);
  });

  it("rejects bodies missing erc7777Version", () => {
    const a = new Erc7777ProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { foo: "bar" } })).toBe(false);
  });

  it("parses to PaymentRequest", async () => {
    const a = new Erc7777ProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: validBody });
    expect(r.protocol).toBe(PROTOCOL_ID);
    expect(r.amount.amountAtomic).toBe("1000000");
    expect(r.recipient).toBe("0xMerchant");
  });

  it("throws on malformed body", async () => {
    const a = new Erc7777ProtocolAdapter();
    await expect(
      (async () =>
        a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { erc7777Version: "1" } }))()
    ).rejects.toThrow();
  });

  it("buildRetry returns base64url envelope", async () => {
    const a = new Erc7777ProtocolAdapter();
    const env = await a.buildRetry({
      request: await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: validBody }),
      signer: "0xSigner",
      signature: "0xsig",
    });
    expect(typeof env.headers["X-PAYMENT-ERC7777"]).toBe("string");
    expect((env.headers["X-PAYMENT-ERC7777"] as string).length).toBeGreaterThan(10);
  });
});
