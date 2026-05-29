/**
 * Tests for Ap2ProtocolAdapter.
 *
 * Coverage:
 *   - detect() positive/negative
 *   - parsePaymentRequired() success extracts settlement protocol from
 *     PaymentMandate.claims and total from CartMandate.claims
 *   - rejects body with no mandates / wrong version
 *   - allowedSettlementProtocols filter
 *   - buildRetry() emits X-PAYMENT-AP2 header with base64url-encoded chain
 *   - verifyMandateChain() detects:
 *       * cart total > intent max
 *       * cart.intentMandateId mismatch
 *       * payment.cartMandateId mismatch
 *       * expired mandates
 *       * wrong-merchant cart vs intent allowedMerchants
 *       * verifier rejection
 *   - buildIntentMandate / buildCartMandate / buildPaymentMandate factories
 */

import { describe, expect, it } from "vitest";
import {
  Ap2ProtocolAdapter,
  NullMandateVerifier,
  PROTOCOL_ID,
  X_PAYMENT_AP2_HEADER,
  buildIntentMandate,
  buildCartMandate,
  buildPaymentMandate,
  type MandateVerifier,
} from "../src/index.js";
import type {
  Mandate,
  ProtocolId,
  SignedAuthorization,
} from "@openagentpay/core";
import { ProtocolError } from "@openagentpay/core";

const proof: Mandate["proof"] = {
  type: "Ed25519Signature2020",
  created: "2026-05-21T00:00:00Z",
  verificationMethod: "did:openagent:user-alice#k1",
  proofPurpose: "assertionMethod",
  proofValue: "z3rEK4MN-test-only",
};

function makeIntent(overrides: Partial<Parameters<typeof buildIntentMandate>[0]> = {}) {
  return buildIntentMandate({
    id: "urn:uuid:intent-001",
    issuer: "did:openagent:user-alice",
    subjectId: "did:openagent:user-alice",
    description: "Buy market data under $5",
    maxAmountAtomic: "5000000",
    currency: "USDC",
    decimals: 6,
    issuanceDate: "2026-05-21T00:00:00Z",
    expirationDate: "2027-05-21T00:00:00Z",
    proof,
    ...overrides,
  });
}

function makeCart(overrides: Partial<Parameters<typeof buildCartMandate>[0]> = {}) {
  return buildCartMandate({
    id: "urn:uuid:cart-001",
    issuer: "did:web:merchant.example",
    subjectId: "did:openagent:user-alice",
    intentMandateId: "urn:uuid:intent-001",
    totalAtomic: "1000000",   // $1
    currency: "USDC",
    decimals: 6,
    merchant: "did:web:merchant.example",
    lineItems: [
      {
        sku: "DATA-001",
        description: "BTC market analysis",
        quantity: 1,
        unitPriceAtomic: "1000000",
      },
    ],
    issuanceDate: "2026-05-21T00:00:00Z",
    proof,
    ...overrides,
  });
}

function makePayment(overrides: Partial<Parameters<typeof buildPaymentMandate>[0]> = {}) {
  return buildPaymentMandate({
    id: "urn:uuid:payment-001",
    issuer: "did:web:psp.example",
    subjectId: "did:openagent:user-alice",
    cartMandateId: "urn:uuid:cart-001",
    settlementProtocol: "x402-v1" as ProtocolId,
    settlementPayload: {
      recipient: "0x000000000000000000000000000000000000dEaD",
      nonce: "0x" + "a".repeat(64),
      validBefore: 9_999_999_999,
    },
    presence: "agent_not_present",
    issuanceDate: "2026-05-21T00:00:00Z",
    proof,
    ...overrides,
  });
}

const ap2Body = (mandates: Mandate[]) => ({
  ap2Version: "0.1",
  mandates,
});

// ----------------------------------------------------------------------------
//  detect()
// ----------------------------------------------------------------------------

describe("Ap2ProtocolAdapter.detect", () => {
  it("accepts ap2Version=0.1 body", () => {
    const a = new Ap2ProtocolAdapter();
    expect(
      a.detect({ statusCode: 402, headers: {}, body: ap2Body([makeCart(), makePayment()]) })
    ).toBe(true);
  });

  it("rejects bodies without ap2Version", () => {
    const a = new Ap2ProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });

  it("rejects unsupported ap2Version", () => {
    const a = new Ap2ProtocolAdapter();
    expect(
      a.detect({ statusCode: 402, headers: {}, body: { ap2Version: "9.9" } })
    ).toBe(false);
  });

  it("rejects non-402 status codes (defensive, type already enforces this)", () => {
    const a = new Ap2ProtocolAdapter();
    expect(
      a.detect({ statusCode: 200 as 402, headers: {}, body: { ap2Version: "0.1" } })
    ).toBe(false);
  });
});

// ----------------------------------------------------------------------------
//  parsePaymentRequired()
// ----------------------------------------------------------------------------

describe("Ap2ProtocolAdapter.parsePaymentRequired", () => {
  it("extracts settlement protocol + total from mandate chain", async () => {
    const a = new Ap2ProtocolAdapter();
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: ap2Body([makeIntent(), makeCart(), makePayment()]),
    });
    // protocol points at the SETTLEMENT layer, not "ap2-v0.1"
    expect(r.protocol).toBe("x402-v1");
    expect(r.amount.amountAtomic).toBe("1000000");
    expect(r.amount.currency).toBe("USDC");
    expect(r.recipient).toBe("0x000000000000000000000000000000000000dEaD");
    expect(r.nonce).toBe("0x" + "a".repeat(64));
    expect(r.mandates).toHaveLength(3);
  });

  it("works without IntentMandate (human-present flow)", async () => {
    const a = new Ap2ProtocolAdapter();
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: ap2Body([makeCart(), makePayment()]),
    });
    expect(r.mandates).toHaveLength(2);
  });

  it("throws when no mandates", async () => {
    const a = new Ap2ProtocolAdapter();
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: { ap2Version: "0.1", mandates: [] },
      })
    ).rejects.toThrowError(ProtocolError);
  });

  it("throws when only IntentMandate present (missing Cart + Payment)", async () => {
    const a = new Ap2ProtocolAdapter();
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: ap2Body([makeIntent()]),
      })
    ).rejects.toThrowError(/at least Cart \+ Payment/);
  });

  it("throws when only Cart present (missing Payment)", async () => {
    const a = new Ap2ProtocolAdapter();
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: ap2Body([makeCart(), makeCart()]), // no PaymentMandate
      })
    ).rejects.toThrowError(/Missing PaymentMandate/);
  });

  it("rejects when settlement protocol not in allow-list", async () => {
    const a = new Ap2ProtocolAdapter({
      allowedSettlementProtocols: ["cex-pay-v0.1" as ProtocolId],
    });
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: ap2Body([makeCart(), makePayment()]), // settlementProtocol=x402-v1
      })
    ).rejects.toThrowError(/not in allow-list/);
  });

  it("propagates verifier rejection", async () => {
    const reject: MandateVerifier = {
      name: "reject-all",
      async verify() {
        return { valid: false, reason: "key not found" };
      },
    };
    const a = new Ap2ProtocolAdapter({ verifier: reject });
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: ap2Body([makeCart(), makePayment()]),
      })
    ).rejects.toThrowError(/failed verification/);
  });

  it("uses NullMandateVerifier by default", async () => {
    const a = new Ap2ProtocolAdapter();
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: ap2Body([makeCart(), makePayment()]),
    });
    expect(r.protocol).toBe("x402-v1");
  });

  it("throws when settlementPayload has no recipient", async () => {
    const a = new Ap2ProtocolAdapter();
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: ap2Body([
          makeCart(),
          makePayment({
            settlementPayload: { nonce: "0xabc" },
          }),
        ]),
      })
    ).rejects.toThrowError(/no settlement recipient/);
  });
});

// ----------------------------------------------------------------------------
//  buildRetry()
// ----------------------------------------------------------------------------

describe("Ap2ProtocolAdapter.buildRetry", () => {
  it("emits X-PAYMENT-AP2 with base64url-encoded mandate chain", async () => {
    const a = new Ap2ProtocolAdapter();
    const mandates = [makeCart(), makePayment()];
    const signed: SignedAuthorization = {
      request: {
        protocol: "x402-v1" as ProtocolId,
        amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
        recipient: "0xdEaD",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0xabc",
        rawPayload: {},
        mandates,
      },
      signer: "0xagent",
      signature: "0xsig",
      encoded: "INNER_BASE64",
    };
    const env = await a.buildRetry(signed);
    expect(env.headers[X_PAYMENT_AP2_HEADER]).toBeTypeOf("string");
    // Must be base64url (no '+', '/', '=')
    expect(env.headers[X_PAYMENT_AP2_HEADER]).not.toMatch(/[+/=]/);
    // Decode + check shape
    const decoded = JSON.parse(
      Buffer.from(env.headers[X_PAYMENT_AP2_HEADER]!, "base64url").toString("utf8")
    );
    expect(decoded.ap2Version).toBe("0.1");
    expect(decoded.mandates).toHaveLength(2);
    expect(decoded.settlement.protocol).toBe("x402-v1");
    expect(decoded.settlement.encoded).toBe("INNER_BASE64");
  });

  it("works when signed has no mandates (defensive)", async () => {
    const a = new Ap2ProtocolAdapter();
    const env = await a.buildRetry({
      request: {
        protocol: "x402-v1" as ProtocolId,
        amount: { amountAtomic: "100", decimals: 6, currency: "USDC" },
        recipient: "0xR",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0x0",
        rawPayload: {},
      },
      signer: "0xS",
      signature: "0xsig",
    });
    const decoded = JSON.parse(
      Buffer.from(env.headers[X_PAYMENT_AP2_HEADER]!, "base64url").toString("utf8")
    );
    expect(decoded.mandates).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
//  verifyMandateChain()
// ----------------------------------------------------------------------------

describe("Ap2ProtocolAdapter.verifyMandateChain", () => {
  it("returns valid for a well-formed chain", async () => {
    const a = new Ap2ProtocolAdapter();
    const r = await a.verifyMandateChain([makeIntent(), makeCart(), makePayment()]);
    expect(r.valid).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("flags cart total > intent max", async () => {
    const a = new Ap2ProtocolAdapter();
    const r = await a.verifyMandateChain([
      makeIntent({ maxAmountAtomic: "100000" }), // $0.10 cap
      makeCart({ totalAtomic: "1000000" }),       // $1
      makePayment(),
    ]);
    expect(r.valid).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/exceeds Intent max/);
  });

  it("flags cart.intentMandateId mismatch", async () => {
    const a = new Ap2ProtocolAdapter();
    const r = await a.verifyMandateChain([
      makeIntent(),
      makeCart({ intentMandateId: "urn:uuid:wrong" }),
      makePayment(),
    ]);
    expect(r.valid).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/intentMandateId/);
  });

  it("flags payment.cartMandateId mismatch", async () => {
    const a = new Ap2ProtocolAdapter();
    const r = await a.verifyMandateChain([
      makeCart(),
      makePayment({ cartMandateId: "urn:uuid:wrong-cart" }),
    ]);
    expect(r.valid).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/cartMandateId/);
  });

  it("flags expired mandates", async () => {
    const a = new Ap2ProtocolAdapter({
      now: () => new Date("2099-01-01").getTime(),
    });
    const r = await a.verifyMandateChain([makeCart(), makePayment()]);
    // Cart has no expiry; Payment has no expiry — should still be valid
    expect(r.valid).toBe(true);

    const r2 = await a.verifyMandateChain([
      makeCart({ expirationDate: "2026-01-01T00:00:00Z" }),
      makePayment(),
    ]);
    expect(r2.valid).toBe(false);
    expect(r2.reasons.join(" ")).toMatch(/expired/);
  });

  it("flags wrong-merchant cart vs intent.allowedMerchants", async () => {
    const a = new Ap2ProtocolAdapter();
    const r = await a.verifyMandateChain([
      makeIntent({ allowedMerchants: ["did:web:other.example"] }),
      makeCart({ merchant: "did:web:merchant.example" }),
      makePayment(),
    ]);
    expect(r.valid).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/not in Intent allowedMerchants/);
  });

  it("flags currency mismatch between Intent and Cart", async () => {
    const a = new Ap2ProtocolAdapter();
    const r = await a.verifyMandateChain([
      makeIntent({ currency: "USDC" }),
      makeCart({ currency: "USDT" }),
      makePayment(),
    ]);
    expect(r.valid).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/currency.*differs/);
  });

  it("propagates verifier rejection", async () => {
    const a = new Ap2ProtocolAdapter({
      verifier: {
        name: "reject",
        async verify() {
          return { valid: false, reason: "bad sig" };
        },
      },
    });
    const r = await a.verifyMandateChain([makeCart(), makePayment()]);
    expect(r.valid).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/signature invalid/);
  });
});

// ----------------------------------------------------------------------------
//  Mandate builders
// ----------------------------------------------------------------------------

describe("buildIntentMandate / buildCartMandate / buildPaymentMandate", () => {
  it("buildIntentMandate produces VC-shaped mandate", () => {
    const m = makeIntent();
    expect(m.type[0]).toBe("VerifiableCredential");
    expect(m.type[1]).toBe("ap2.IntentMandate");
    expect(m["@context"][0]).toMatch(/credentials/);
    expect(m.proof.type).toBe("Ed25519Signature2020");
  });

  it("buildCartMandate carries lineItems", () => {
    const m = makeCart();
    const claims = m.credentialSubject.mandate as any;
    expect(claims.kind).toBe("ap2.CartMandate");
    expect(claims.lineItems).toHaveLength(1);
    expect(claims.lineItems[0].sku).toBe("DATA-001");
  });

  it("buildPaymentMandate links to cart + carries settlement protocol", () => {
    const m = makePayment();
    const claims = m.credentialSubject.mandate as any;
    expect(claims.kind).toBe("ap2.PaymentMandate");
    expect(claims.cartMandateId).toBe("urn:uuid:cart-001");
    expect(claims.settlementProtocol).toBe("x402-v1");
    expect(claims.presence).toBe("agent_not_present");
  });
});

// ----------------------------------------------------------------------------
//  Constants
// ----------------------------------------------------------------------------

describe("constants", () => {
  it("PROTOCOL_ID is 'ap2-v0.1'", () => {
    expect(PROTOCOL_ID).toBe("ap2-v0.1");
  });
  it("X_PAYMENT_AP2_HEADER is X-PAYMENT-AP2", () => {
    expect(X_PAYMENT_AP2_HEADER).toBe("X-PAYMENT-AP2");
  });
  it("NullMandateVerifier always returns valid", async () => {
    const v = new NullMandateVerifier();
    const m = makeCart();
    expect((await v.verify(m)).valid).toBe(true);
  });
});
