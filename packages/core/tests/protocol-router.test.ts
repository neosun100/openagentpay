/**
 * Tests for ProtocolRouter — multi-protocol dispatch + AP2 mandate bridging.
 *
 * Coverage:
 *   - Routes to first-match adapter
 *   - Skips adapters whose detect() returns false
 *   - Throws ProtocolError when no adapter matches
 *   - Defensive: detect() throws → treated as miss, continues
 *   - byId() lookup works
 *   - list() returns adapter ids
 *   - Mandate extraction from { mandates: [...] }
 *   - Mandate extraction from { ap2: { mandates: [...] } }
 *   - Malformed mandates silently dropped
 *   - carryMandates=false → mandates ignored
 *   - Constructor rejects empty adapters
 */

import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  ProtocolRouter,
  type HttpResponse402,
  type HttpRetryEnvelope,
  type Mandate,
  type PaymentRequest,
  type ProtocolAdapter,
  type ProtocolId,
  type SignedAuthorization,
} from "../src/index.js";

// ----------------------------------------------------------------------------
//  Mock adapters — minimal valid ProtocolAdapter implementations
// ----------------------------------------------------------------------------

function makeAdapter(
  id: string,
  detector: (r: HttpResponse402) => boolean,
  parsed?: Partial<PaymentRequest>
): ProtocolAdapter {
  return {
    id: id as ProtocolId,
    detect: detector,
    parsePaymentRequired: async (r: HttpResponse402): Promise<PaymentRequest> => ({
      protocol: id as ProtocolId,
      amount: { amountAtomic: "100", decimals: 6, currency: "USDC" },
      recipient: "0xtest",
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: 9_999_999_999,
      nonce: "0xabc",
      rawPayload: r.body,
      ...parsed,
    }),
    buildRetry: async (_signed: SignedAuthorization): Promise<HttpRetryEnvelope> => ({
      headers: {},
    }),
  };
}

const x402 = makeAdapter("x402-v1", (r) => {
  const b = r.body as Record<string, unknown> | null;
  return !!b && typeof b["x402Version"] === "number";
});

const cex = makeAdapter("cex-pay-v0.1", (r) => {
  const b = r.body as Record<string, unknown> | null;
  return !!b && b["scheme"] === "cex-pay";
});

const ap2 = makeAdapter("ap2-v0.1", (r) => {
  const b = r.body as Record<string, unknown> | null;
  return !!b && b["ap2Version"] === "0.1";
});

const broken = makeAdapter("broken", () => {
  throw new Error("detect blew up");
});

const validMandate: Mandate = {
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  id: "urn:uuid:11111111-2222-3333-4444-555555555555",
  type: ["VerifiableCredential", "ap2.IntentMandate"],
  issuer: "did:openagent:user-alice",
  issuanceDate: "2026-05-21T00:00:00Z",
  credentialSubject: {
    id: "did:openagent:user-alice",
    mandate: {
      kind: "ap2.IntentMandate",
      description: "Buy market data for under $5",
      maxAmountAtomic: "5000000",
      currency: "USDC",
      decimals: 6,
    },
  },
  proof: {
    type: "Ed25519Signature2020",
    created: "2026-05-21T00:00:00Z",
    verificationMethod: "did:openagent:user-alice#key-1",
    proofPurpose: "assertionMethod",
    proofValue: "z3rEK4MN...",
  },
};

// ----------------------------------------------------------------------------
//  Tests
// ----------------------------------------------------------------------------

describe("ProtocolRouter — constructor", () => {
  it("rejects empty adapters list", () => {
    expect(() => new ProtocolRouter({ adapters: [] })).toThrow(
      /at least one ProtocolAdapter/
    );
  });

  it("accepts a single adapter", () => {
    const r = new ProtocolRouter({ adapters: [x402] });
    expect(r.list()).toEqual(["x402-v1"]);
  });
});

describe("ProtocolRouter.route — single-protocol dispatch", () => {
  it("routes to x402 when body has x402Version", async () => {
    const router = new ProtocolRouter({ adapters: [x402, cex, ap2] });
    const out = await router.route({
      statusCode: 402,
      headers: {},
      body: { x402Version: 1, scheme: "exact" },
    });
    expect(out.adapter.id).toBe("x402-v1");
    expect(out.request.protocol).toBe("x402-v1");
    expect(out.hasMandates).toBe(false);
    expect(out.trace).toEqual(["x402-v1"]); // first match wins
  });

  it("routes to OAP-CEX when body has scheme=cex-pay", async () => {
    const router = new ProtocolRouter({ adapters: [x402, cex, ap2] });
    const out = await router.route({
      statusCode: 402,
      headers: {},
      body: { oapCexVersion: 1, scheme: "cex-pay", accepts: [] },
    });
    expect(out.adapter.id).toBe("cex-pay-v0.1");
    expect(out.trace).toEqual(["x402-v1", "cex-pay-v0.1"]);
  });

  it("respects priority order — first match wins", async () => {
    // Both adapters match the same body — first one in the list should win
    const matchAll = makeAdapter("first", () => true);
    const matchAll2 = makeAdapter("second", () => true);
    const router = new ProtocolRouter({ adapters: [matchAll, matchAll2] });
    const out = await router.route({
      statusCode: 402,
      headers: {},
      body: {},
    });
    expect(out.adapter.id).toBe("first");
  });

  it("throws ProtocolError when no adapter matches", async () => {
    const router = new ProtocolRouter({ adapters: [x402] });
    await expect(
      router.route({
        statusCode: 402,
        headers: {},
        body: { unknownProto: true },
      })
    ).rejects.toThrowError(ProtocolError);
  });

  it("treats throwing detect() as a miss and continues", async () => {
    const router = new ProtocolRouter({ adapters: [broken, x402] });
    const out = await router.route({
      statusCode: 402,
      headers: {},
      body: { x402Version: 1 },
    });
    expect(out.adapter.id).toBe("x402-v1");
    expect(out.trace).toEqual(["broken", "x402-v1"]);
  });
});

describe("ProtocolRouter — AP2 mandate envelope bridging", () => {
  it("merges top-level mandates[] into PaymentRequest", async () => {
    const router = new ProtocolRouter({ adapters: [x402] });
    const out = await router.route({
      statusCode: 402,
      headers: {},
      body: {
        x402Version: 1,
        scheme: "exact",
        mandates: [validMandate],
      },
    });
    expect(out.hasMandates).toBe(true);
    expect(out.request.mandates).toBeDefined();
    expect(out.request.mandates![0]!.id).toBe(validMandate.id);
  });

  it("merges nested ap2.mandates[] into PaymentRequest", async () => {
    const router = new ProtocolRouter({ adapters: [x402] });
    const out = await router.route({
      statusCode: 402,
      headers: {},
      body: {
        x402Version: 1,
        ap2: { mandates: [validMandate] },
      },
    });
    expect(out.hasMandates).toBe(true);
    expect(out.request.mandates).toHaveLength(1);
  });

  it("merges mandates from both top-level AND ap2 wrapper", async () => {
    const router = new ProtocolRouter({ adapters: [x402] });
    const second = { ...validMandate, id: "urn:uuid:second" };
    const out = await router.route({
      statusCode: 402,
      headers: {},
      body: {
        x402Version: 1,
        mandates: [validMandate],
        ap2: { mandates: [second] },
      },
    });
    expect(out.request.mandates).toHaveLength(2);
  });

  it("silently drops malformed mandates", async () => {
    const router = new ProtocolRouter({ adapters: [x402] });
    const out = await router.route({
      statusCode: 402,
      headers: {},
      body: {
        x402Version: 1,
        mandates: [
          validMandate,
          { id: "no-context-no-proof" }, // malformed
          null,
          "not-an-object",
        ],
      },
    });
    expect(out.request.mandates).toHaveLength(1);
  });

  it("ignores mandates when carryMandates=false", async () => {
    const router = new ProtocolRouter({
      adapters: [x402],
      carryMandates: false,
    });
    const out = await router.route({
      statusCode: 402,
      headers: {},
      body: { x402Version: 1, mandates: [validMandate] },
    });
    expect(out.hasMandates).toBe(false);
    expect(out.request.mandates).toBeUndefined();
  });

  it("works when body has no mandates field at all", async () => {
    const router = new ProtocolRouter({ adapters: [x402] });
    const out = await router.route({
      statusCode: 402,
      headers: {},
      body: { x402Version: 1 },
    });
    expect(out.hasMandates).toBe(false);
    expect(out.request.mandates).toBeUndefined();
  });
});

describe("ProtocolRouter.byId / list", () => {
  it("byId returns adapter when registered", () => {
    const router = new ProtocolRouter({ adapters: [x402, cex] });
    expect(router.byId("x402-v1" as ProtocolId)?.id).toBe("x402-v1");
    expect(router.byId("cex-pay-v0.1" as ProtocolId)?.id).toBe("cex-pay-v0.1");
  });

  it("byId returns undefined for unknown id", () => {
    const router = new ProtocolRouter({ adapters: [x402] });
    expect(router.byId("nope" as ProtocolId)).toBeUndefined();
  });

  it("list returns ids in registration order", () => {
    const router = new ProtocolRouter({ adapters: [ap2, x402, cex] });
    expect(router.list()).toEqual(["ap2-v0.1", "x402-v1", "cex-pay-v0.1"]);
  });
});
