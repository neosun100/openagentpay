import { describe, expect, it } from "vitest";
import { NeverminedProtocolAdapter, PROTOCOL_ID, X_PAYMENT_NVM_HEADER, type Nevermined402Body } from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const subBody: Nevermined402Body = {
  nvmVersion: 1,
  mode: "subscription",
  subscription: {
    planId: "plan-pro-001",
    tokenContract: "0xPlanContract000000000000000000000000000000",
    chain: "eip155:8453",
    priceAtomic: "10000000",
    currency: "USDC",
    decimals: 6,
    durationDays: 30,
  },
  description: "Pro plan: 30 days unlimited",
};

const creditBody: Nevermined402Body = {
  nvmVersion: 1,
  mode: "credit",
  charge: { creditsRequired: 5, serviceId: "svc_research_v1" },
};

describe("NeverminedProtocolAdapter", () => {
  it("detects nvm body", () => {
    const a = new NeverminedProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: subBody })).toBe(true);
    expect(a.detect({ statusCode: 402, headers: {}, body: creditBody })).toBe(true);
  });

  it("rejects non-nvm body", () => {
    const a = new NeverminedProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });

  it("parses subscription mode", async () => {
    const a = new NeverminedProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: subBody });
    expect(r.amount.amountAtomic).toBe("10000000");
    expect(r.amount.currency).toBe("USDC");
    expect(r.recipient).toBe(subBody.subscription!.tokenContract);
    expect(r.nonce).toBe("plan-pro-001");
  });

  it("parses credit mode with NVMCREDIT currency", async () => {
    const a = new NeverminedProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: creditBody });
    expect(r.amount.amountAtomic).toBe("5");
    expect(r.amount.currency).toBe("NVMCREDIT");
    expect(r.amount.decimals).toBe(0);
    expect(r.recipient).toBe("svc_research_v1");
  });

  it("rejects untrusted contract", async () => {
    const a = new NeverminedProtocolAdapter({
      trustedContracts: ["0xOTHER0000000000000000000000000000000000000"],
    });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: subBody })
    ).rejects.toThrowError(/not trusted/);
  });

  it("rejects subscription mode without subscription block", async () => {
    const a = new NeverminedProtocolAdapter();
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { nvmVersion: 1, mode: "subscription" } })
    ).rejects.toThrowError(/subscription block/);
  });

  it("rejects credit mode without charge block", async () => {
    const a = new NeverminedProtocolAdapter();
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { nvmVersion: 1, mode: "credit" } })
    ).rejects.toThrowError(/charge block/);
  });

  it("rejects unknown mode", async () => {
    const a = new NeverminedProtocolAdapter();
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { nvmVersion: 1, mode: "bogus" } })
    ).rejects.toThrowError(ProtocolError);
  });

  it("buildRetry emits X-PAYMENT-NVM header", async () => {
    const a = new NeverminedProtocolAdapter();
    const signed: SignedAuthorization = {
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "10000000", decimals: 6, currency: "USDC" },
        recipient: "0xPlan",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0, validBefore: 9_999_999_999, nonce: "plan-pro-001", rawPayload: {},
      },
      signer: "0xAgent",
      signature: "0xsig",
    };
    const env = await a.buildRetry(signed);
    const decoded = JSON.parse(Buffer.from(env.headers[X_PAYMENT_NVM_HEADER]!, "base64url").toString("utf8"));
    expect(decoded.nvmVersion).toBe(1);
    expect(decoded.signature).toBe("0xsig");
  });
});
