import { describe, expect, it } from "vitest";
import { SuiPayProtocolAdapter, PROTOCOL_ID, X_PAYMENT_SUI_HEADER, type SuiPay402Body } from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const baseBody: SuiPay402Body = {
  suiVersion: "1",
  recipient: "0xabcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
  coinType: "0x2::sui::SUI",
  amountAtomic: "1000000000",
  network: "testnet",
  reference: "ord_sui_001",
  description: "Buy compute time",
};

describe("SuiPayProtocolAdapter", () => {
  it("detects Sui body", () => {
    const a = new SuiPayProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: baseBody })).toBe(true);
  });

  it("rejects non-Sui body", () => {
    const a = new SuiPayProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });

  it("parses native SUI to PaymentRequest with 9 decimals", async () => {
    const a = new SuiPayProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.amount.currency).toBe("SUI");
    expect(r.amount.decimals).toBe(9);
    expect(r.amount.amountAtomic).toBe("1000000000");
    expect(r.recipient).toBe(baseBody.recipient);
    expect(r.asset.chain).toBe("sui:testnet");
    expect(r.nonce).toBe("ord_sui_001");
  });

  it("recognizes USDC coinType for testnet faucet pkg", async () => {
    const a = new SuiPayProtocolAdapter();
    const body = JSON.parse(JSON.stringify(baseBody));
    body.coinType = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body });
    expect(r.amount.currency).toBe("USDC");
    expect(r.amount.decimals).toBe(6);
  });

  it("handles unknown coin types as 'COIN' with default 9 decimals", async () => {
    const a = new SuiPayProtocolAdapter();
    const body = JSON.parse(JSON.stringify(baseBody));
    body.coinType = "0xdeadbeef::custom::TOKEN";
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body });
    expect(r.amount.currency).toBe("COIN");
    expect(r.amount.decimals).toBe(9);
  });

  it("rejects when network not preferred", async () => {
    const a = new SuiPayProtocolAdapter({ preferredNetworks: ["mainnet"] });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/preferred/);
  });

  it("rejects malformed Sui address", async () => {
    const a = new SuiPayProtocolAdapter();
    const broken = JSON.parse(JSON.stringify(baseBody));
    broken.recipient = "not-a-hex-address";
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/recipient/);
  });

  it("buildRetry emits X-PAYMENT-SUI tx digest", async () => {
    const a = new SuiPayProtocolAdapter();
    const env = await a.buildRetry({
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1000000000", decimals: 9, currency: "SUI" },
        recipient: baseBody.recipient,
        asset: { symbol: "SUI", decimals: 9 },
        validAfter: 0, validBefore: 9_999_999_999, nonce: "n", rawPayload: {},
      },
      signer: baseBody.recipient,
      signature: "9z3rEK4MN_SUI_DIGEST",
    } as SignedAuthorization);
    expect(env.headers[X_PAYMENT_SUI_HEADER]).toBe("9z3rEK4MN_SUI_DIGEST");
  });

  it("throws on missing required fields", async () => {
    const a = new SuiPayProtocolAdapter();
    const broken: any = JSON.parse(JSON.stringify(baseBody));
    delete broken.amountAtomic;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/amountAtomic/);
  });
});
