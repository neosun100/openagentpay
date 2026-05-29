import { describe, expect, it } from "vitest";
import { VirtualsAcpProtocolAdapter, PROTOCOL_ID, X_PAYMENT_ACP_HEADER, type Acp402Body } from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const baseBody: Acp402Body = {
  acpVersion: 1,
  job: {
    id: "job_001",
    requesterAgent: "0xRequester",
    providerAgent: "0xProvider",
    evaluatorAgent: "0xEvaluator",
    phase: "transaction",
    terms: { description: "Generate research report", deliverable: "PDF + dataset" },
    priceAtomic: "5000000",
    currency: "USDC",
    decimals: 6,
    escrow: "0xEscrow000000000000000000000000000000000000",
    chain: "eip155:8453",
  },
};

describe("VirtualsAcpProtocolAdapter", () => {
  it("detects ACP body", () => {
    const a = new VirtualsAcpProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: baseBody })).toBe(true);
  });

  it("rejects non-ACP body", () => {
    const a = new VirtualsAcpProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });

  it("parses transaction phase to PaymentRequest", async () => {
    const a = new VirtualsAcpProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.amount.amountAtomic).toBe("5000000");
    expect(r.recipient).toBe("0xEscrow000000000000000000000000000000000000");
    expect(r.nonce).toBe("job_001");
    expect(r.description).toContain("research report");
  });

  it("rejects non-transaction phase", async () => {
    const a = new VirtualsAcpProtocolAdapter();
    const broken = JSON.parse(JSON.stringify(baseBody));
    broken.job.phase = "negotiation";
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/not actionable/);
  });

  it("rejects untrusted evaluator", async () => {
    const a = new VirtualsAcpProtocolAdapter({
      trustedEvaluators: ["0xKnownEvaluator00000000000000000000000000"],
    });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/not in trust list/);
  });

  it("accepts trusted evaluator", async () => {
    const a = new VirtualsAcpProtocolAdapter({
      trustedEvaluators: ["0xEvaluator"],
    });
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.protocol).toBe(PROTOCOL_ID);
  });

  it("buildRetry emits X-PAYMENT-ACP header", async () => {
    const a = new VirtualsAcpProtocolAdapter();
    const signed: SignedAuthorization = {
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "5000000", decimals: 6, currency: "USDC" },
        recipient: "0xEscrow",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0, validBefore: 9_999_999_999, nonce: "job_001", rawPayload: {},
      },
      signer: "0xRequester",
      signature: "0xsig",
    };
    const env = await a.buildRetry(signed);
    expect(env.headers[X_PAYMENT_ACP_HEADER]).toBeTypeOf("string");
    const decoded = JSON.parse(Buffer.from(env.headers[X_PAYMENT_ACP_HEADER]!, "base64url").toString("utf8"));
    expect(decoded.jobId).toBe("job_001");
    expect(decoded.signature).toBe("0xsig");
  });

  it("throws on missing job fields", async () => {
    const a = new VirtualsAcpProtocolAdapter();
    const broken = JSON.parse(JSON.stringify(baseBody));
    delete broken.job.escrow;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/escrow/);
  });

  it("throws when acpVersion not 1", async () => {
    const a = new VirtualsAcpProtocolAdapter();
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: { acpVersion: 2, job: baseBody.job } })
    ).rejects.toThrowError(ProtocolError);
  });
});
