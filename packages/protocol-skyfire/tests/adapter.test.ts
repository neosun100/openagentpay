import { describe, expect, it } from "vitest";
import {
  SkyfireProtocolAdapter,
  PROTOCOL_ID,
  KYA_HEADER,
  PAY_HEADER,
  type Skyfire402Body,
} from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const baseBody: Skyfire402Body = {
  skyfire: {
    version: 1,
    amount: { amountAtomic: "1000", currency: "USDC", decimals: 6 },
    recipient: "merchant_skyfire_001",
    merchantUrl: "https://api.example.com/data",
    requireKya: true,
    accepts: ["usdc-base", "card"],
    description: "Premium API",
  },
};

function makeKyaJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = "fake-signature";
  return `${header}.${body}.${sig}`;
}

describe("SkyfireProtocolAdapter.detect", () => {
  it("detects skyfire body", () => {
    const a = new SkyfireProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: baseBody })).toBe(true);
  });
  it("rejects non-skyfire body", () => {
    const a = new SkyfireProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });
});

describe("SkyfireProtocolAdapter.parsePaymentRequired", () => {
  it("extracts amount + recipient", async () => {
    const a = new SkyfireProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.amount.amountAtomic).toBe("1000");
    expect(r.amount.currency).toBe("USDC");
    expect(r.recipient).toBe("merchant_skyfire_001");
    expect(r.description).toBe("Premium API");
  });

  it("rejects when no preferred method matches", async () => {
    const a = new SkyfireProtocolAdapter({ preferredMethods: ["bank-transfer"] });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/preferred method/);
  });

  it("accepts when preferred method matches", async () => {
    const a = new SkyfireProtocolAdapter({ preferredMethods: ["usdc-base"] });
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.protocol).toBe(PROTOCOL_ID);
  });

  it("throws on missing recipient", async () => {
    const a = new SkyfireProtocolAdapter();
    const broken = JSON.parse(JSON.stringify(baseBody));
    delete broken.skyfire.recipient;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/recipient/);
  });

  it("throws on missing amount", async () => {
    const a = new SkyfireProtocolAdapter();
    const broken = JSON.parse(JSON.stringify(baseBody));
    delete broken.skyfire.amount;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/amount/);
  });
});

describe("SkyfireProtocolAdapter.buildRetry", () => {
  it("emits both KYA + PAY headers when kyaToken provided", async () => {
    const a = new SkyfireProtocolAdapter();
    const signed: SignedAuthorization = {
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
        recipient: "merchant",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0, validBefore: 9_999_999_999, nonce: "n", rawPayload: {},
      },
      signer: "agent",
      signature: "PAY_TOKEN_xyz",
      extra: { kyaToken: "KYA_JWT_abc" },
    };
    const env = await a.buildRetry(signed);
    expect(env.headers[PAY_HEADER]).toBe("PAY_TOKEN_xyz");
    expect(env.headers[KYA_HEADER]).toBe("KYA_JWT_abc");
  });

  it("emits only PAY when no kyaToken", async () => {
    const a = new SkyfireProtocolAdapter();
    const env = await a.buildRetry({
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1", decimals: 6, currency: "USDC" },
        recipient: "x", asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0, validBefore: 1, nonce: "n", rawPayload: {},
      },
      signer: "agent",
      signature: "PAY_only",
    });
    expect(env.headers[PAY_HEADER]).toBe("PAY_only");
    expect(env.headers[KYA_HEADER]).toBeUndefined();
  });

  it("rejects when PAY signature missing", async () => {
    const a = new SkyfireProtocolAdapter();
    await expect(
      a.buildRetry({
        request: { protocol: PROTOCOL_ID, amount: { amountAtomic: "1", decimals: 6, currency: "USDC" }, recipient: "x", asset: { symbol: "USDC", decimals: 6 }, validAfter: 0, validBefore: 1, nonce: "n", rawPayload: {} },
        signer: "agent",
        signature: "",
      })
    ).rejects.toThrowError(/PAY token/);
  });
});

describe("SkyfireProtocolAdapter.verifyKya", () => {
  it("accepts a structurally valid JWT", () => {
    const a = new SkyfireProtocolAdapter({ now: () => 1_700_000_000_000 });
    const token = makeKyaJwt({
      agentId: "did:agent:abc",
      ownerKyc: { type: "human", id: "user-001" },
      issuer: "https://api.skyfire.xyz",
      issuedAt: 1_700_000_000,
      expiresAt: 9_999_999_999,
    });
    const v = a.verifyKya(token);
    expect(v.valid).toBe(true);
    expect(v.claims?.agentId).toBe("did:agent:abc");
  });

  it("rejects expired KYA", () => {
    const a = new SkyfireProtocolAdapter({ now: () => 9_999_999_999_000 });
    const token = makeKyaJwt({
      agentId: "x",
      ownerKyc: { type: "human", id: "u" },
      issuer: "https://api.skyfire.xyz",
      issuedAt: 1, expiresAt: 100,
    });
    const v = a.verifyKya(token);
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("expired");
  });

  it("rejects untrusted issuer", () => {
    const a = new SkyfireProtocolAdapter({
      trustedIssuers: ["https://api.skyfire.xyz"],
      now: () => 1_700_000_000_000,
    });
    const token = makeKyaJwt({
      agentId: "x", ownerKyc: { type: "human", id: "u" },
      issuer: "https://evil.example", issuedAt: 1, expiresAt: 9_999_999_999,
    });
    const v = a.verifyKya(token);
    expect(v.valid).toBe(false);
    expect(v.reason).toContain("untrusted");
  });

  it("rejects garbage tokens", () => {
    const a = new SkyfireProtocolAdapter();
    expect(a.verifyKya("not-a-jwt").valid).toBe(false);
    expect(a.verifyKya("a.b").valid).toBe(false);
  });
});
