import { describe, expect, it } from "vitest";
import { AptosPayProtocolAdapter, PROTOCOL_ID, X_PAYMENT_APTOS_HEADER, type AptosPay402Body } from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const baseBody: AptosPay402Body = {
  aptosVersion: "1",
  recipient: "0xabcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
  coinType: "0x1::aptos_coin::AptosCoin",
  amountAtomic: "10000000",
  network: "testnet",
  reference: "ord_aptos_001",
};

describe("AptosPayProtocolAdapter", () => {
  it("detects Aptos body", () => {
    const a = new AptosPayProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: baseBody })).toBe(true);
  });
  it("rejects non-Aptos body", () => {
    const a = new AptosPayProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });

  it("parses native APT to 8 decimals", async () => {
    const a = new AptosPayProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.amount.currency).toBe("APT");
    expect(r.amount.decimals).toBe(8);
    expect(r.recipient).toBe(baseBody.recipient);
    expect(r.asset.chain).toBe("aptos:testnet");
  });

  it("recognizes Aptos USDC coinType", async () => {
    const a = new AptosPayProtocolAdapter();
    const body = JSON.parse(JSON.stringify(baseBody));
    body.coinType = "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b::usdc::USDC";
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body });
    expect(r.amount.currency).toBe("USDC");
    expect(r.amount.decimals).toBe(6);
  });

  it("rejects when network not preferred", async () => {
    const a = new AptosPayProtocolAdapter({ preferredNetworks: ["mainnet"] });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/preferred/);
  });

  it("rejects malformed Aptos address", async () => {
    const a = new AptosPayProtocolAdapter();
    const broken = JSON.parse(JSON.stringify(baseBody));
    broken.recipient = "not-an-aptos-address";
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/recipient/);
  });

  it("buildRetry emits X-PAYMENT-APTOS tx hash", async () => {
    const a = new AptosPayProtocolAdapter();
    const env = await a.buildRetry({
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "10000000", decimals: 8, currency: "APT" },
        recipient: baseBody.recipient, asset: { symbol: "APT", decimals: 8 },
        validAfter: 0, validBefore: 9_999_999_999, nonce: "n", rawPayload: {},
      },
      signer: baseBody.recipient,
      signature: "0xAPTOS_TX_HASH_xyz",
    } as SignedAuthorization);
    expect(env.headers[X_PAYMENT_APTOS_HEADER]).toBe("0xAPTOS_TX_HASH_xyz");
  });

  it("throws on missing field", async () => {
    const a = new AptosPayProtocolAdapter();
    const broken: any = JSON.parse(JSON.stringify(baseBody));
    delete broken.coinType;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/coinType/);
  });
});
