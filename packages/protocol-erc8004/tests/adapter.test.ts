import { describe, expect, it } from "vitest";
import {
  Erc8004ProtocolAdapter,
  PROTOCOL_ID,
  X_PAYMENT_ERC8004_HEADER,
  type Erc8004402Body,
} from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const baseBody: Erc8004402Body = {
  erc8004: {
    version: 1,
    identity: {
      agentId: "did:eth:0xabc123",
      chain: "eip155:1",
      identityRegistry: "0xRegistry000000000000000000000000000000000",
    },
    reputation: { registry: "0xReputation0000000000000000000000000000000", score: 75 },
  },
  settlement: {
    protocol: "x402-v1" as any,
    payload: {
      recipient: "0xMERCHANT00000000000000000000000000000000",
      amount: "1000",
      decimals: 6,
      currency: "USDC",
      nonce: "0xabc",
      validBefore: 9_999_999_999,
    },
  },
  description: "Buy data",
};

describe("Erc8004ProtocolAdapter.detect", () => {
  it("detects valid erc8004 block", () => {
    const a = new Erc8004ProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: baseBody })).toBe(true);
  });
  it("rejects bodies without erc8004 block", () => {
    const a = new Erc8004ProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });
});

describe("Erc8004ProtocolAdapter.parsePaymentRequired", () => {
  it("extracts settlement protocol + amount", async () => {
    const a = new Erc8004ProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.protocol).toBe("x402-v1"); // settlement protocol
    expect(r.amount.amountAtomic).toBe("1000");
    expect(r.amount.currency).toBe("USDC");
    expect(r.recipient).toBe("0xMERCHANT00000000000000000000000000000000");
  });

  it("rejects when registry not in trust list", async () => {
    const a = new Erc8004ProtocolAdapter({
      trustedRegistries: ["0xOTHER0000000000000000000000000000000000000"],
    });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/not in trust list/);
  });

  it("rejects when reputation score below minimum", async () => {
    const a = new Erc8004ProtocolAdapter({ minReputation: 90 });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/below required/);
  });

  it("accepts when reputation meets minimum", async () => {
    const a = new Erc8004ProtocolAdapter({ minReputation: 70 });
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.protocol).toBe("x402-v1");
  });

  it("throws on missing identity.agentId", async () => {
    const a = new Erc8004ProtocolAdapter();
    const broken = JSON.parse(JSON.stringify(baseBody));
    delete broken.erc8004.identity.agentId;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/agentId/);
  });

  it("throws on missing settlement", async () => {
    const a = new Erc8004ProtocolAdapter();
    const broken: any = { ...baseBody };
    delete broken.settlement;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/settlement block/);
  });

  it("throws on missing settlement.payload.recipient", async () => {
    const a = new Erc8004ProtocolAdapter();
    const broken = JSON.parse(JSON.stringify(baseBody));
    delete broken.settlement.payload.recipient;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/recipient/);
  });
});

describe("Erc8004ProtocolAdapter.buildRetry", () => {
  it("emits X-PAYMENT-ERC8004 header with base64url payload", async () => {
    const a = new Erc8004ProtocolAdapter();
    const signed: SignedAuthorization = {
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
        recipient: "0xR",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0xn",
        rawPayload: {},
      },
      signer: "0xS",
      signature: "0xsig",
      encoded: "INNER",
    };
    const env = await a.buildRetry(signed);
    expect(env.headers[X_PAYMENT_ERC8004_HEADER]).toBeTypeOf("string");
    const decoded = JSON.parse(
      Buffer.from(env.headers[X_PAYMENT_ERC8004_HEADER]!, "base64url").toString("utf8")
    );
    expect(decoded.version).toBe(1);
    expect(decoded.settlement.signature).toBe("0xsig");
    expect(decoded.settlement.encoded).toBe("INNER");
  });

  it("rejects when signature missing", async () => {
    const a = new Erc8004ProtocolAdapter();
    await expect(
      a.buildRetry({
        request: {
          protocol: PROTOCOL_ID,
          amount: { amountAtomic: "1", decimals: 6, currency: "USDC" },
          recipient: "0xR",
          asset: { symbol: "USDC", decimals: 6 },
          validAfter: 0, validBefore: 1, nonce: "0x0", rawPayload: {},
        },
        signer: "0xS",
        signature: "",
      })
    ).rejects.toThrowError(/signature/);
  });
});
