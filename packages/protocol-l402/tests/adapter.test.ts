import { describe, expect, it } from "vitest";
import {
  L402ProtocolAdapter,
  parseBolt11Amount,
  parseL402Challenge,
  PROTOCOL_ID,
} from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const SAMPLE_MACAROON = "AGIAJEemVQUTEyNCR0exk7ek90Cg==";
// 1000 sat = 0.00001 BTC → encoded as "10u"
const SAMPLE_INVOICE_1000_SAT = "lnbc10u1pwcvqkzpp5xyz";

describe("parseBolt11Amount", () => {
  it("parses milli-BTC ('m')", () => {
    expect(parseBolt11Amount("lnbc1m...")).toBe(100_000_000n); // 100k sat = 1e8 msat
  });
  it("parses micro-BTC ('u')", () => {
    expect(parseBolt11Amount("lnbc1u...")).toBe(100_000n); // 100 sat
  });
  it("parses nano-BTC ('n')", () => {
    expect(parseBolt11Amount("lnbc1n...")).toBe(100n); // 0.1 sat
  });
  it("parses 1000u (1000 sats)", () => {
    expect(parseBolt11Amount("lnbc1000u...")).toBe(100_000_000n); // 1000 * 1e5 = 1e8 msat = 1000 sat
  });
  it("returns 0 for amountless invoice (value=0)", () => {
    expect(parseBolt11Amount("lnbc0...")).toBe(0n);
  });
  it("throws on bad prefix", () => {
    expect(() => parseBolt11Amount("lnxx100u")).toThrowError(ProtocolError);
  });
  it("supports testnet prefix lntb", () => {
    expect(parseBolt11Amount("lntb1u...")).toBe(100_000n);
  });
});

describe("parseL402Challenge", () => {
  it("parses standard L402 header", () => {
    const c = parseL402Challenge(`L402 macaroon="${SAMPLE_MACAROON}", invoice="${SAMPLE_INVOICE_1000_SAT}"`);
    expect(c.macaroon).toBe(SAMPLE_MACAROON);
    expect(c.invoice).toBe(SAMPLE_INVOICE_1000_SAT);
  });
  it("parses legacy LSAT header", () => {
    const c = parseL402Challenge(`LSAT macaroon="${SAMPLE_MACAROON}", invoice="${SAMPLE_INVOICE_1000_SAT}"`);
    expect(c.macaroon).toBe(SAMPLE_MACAROON);
  });
  it("throws on non-L402 scheme", () => {
    expect(() => parseL402Challenge(`Bearer xyz`)).toThrowError(ProtocolError);
  });
  it("throws on missing macaroon", () => {
    expect(() => parseL402Challenge(`L402 invoice="${SAMPLE_INVOICE_1000_SAT}"`)).toThrowError(/macaroon/);
  });
  it("throws on missing invoice", () => {
    expect(() => parseL402Challenge(`L402 macaroon="abc"`)).toThrowError(/invoice/);
  });
  it("captures optional description", () => {
    const c = parseL402Challenge(`L402 macaroon="${SAMPLE_MACAROON}", invoice="${SAMPLE_INVOICE_1000_SAT}", description="Premium API"`);
    expect(c.description).toBe("Premium API");
  });
});

describe("L402ProtocolAdapter", () => {
  it("detects L402 challenge in WWW-Authenticate header", () => {
    const a = new L402ProtocolAdapter();
    expect(
      a.detect({
        statusCode: 402,
        headers: { "www-authenticate": `L402 macaroon="x", invoice="y"` },
        body: {},
      })
    ).toBe(true);
  });
  it("detects legacy LSAT", () => {
    const a = new L402ProtocolAdapter();
    expect(
      a.detect({
        statusCode: 402,
        headers: { "www-authenticate": `LSAT macaroon="x", invoice="y"` },
        body: {},
      })
    ).toBe(true);
  });
  it("rejects when no www-authenticate header", () => {
    const a = new L402ProtocolAdapter();
    expect(
      a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })
    ).toBe(false);
  });

  it("parses to PaymentRequest with msat amount", async () => {
    const a = new L402ProtocolAdapter();
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {
        "www-authenticate": `L402 macaroon="${SAMPLE_MACAROON}", invoice="lnbc1000u1...rest"`,
      },
      body: {},
    });
    expect(r.protocol).toBe(PROTOCOL_ID);
    expect(r.amount.amountAtomic).toBe("100000000"); // 1000 sat = 1e8 msat
    expect(r.amount.currency).toBe("BTC");
    expect(r.amount.decimals).toBe(11);
    expect(r.nonce).toBe(SAMPLE_MACAROON); // macaroon stashed as nonce
  });

  it("uses tBTC currency for testnet config", async () => {
    const a = new L402ProtocolAdapter({ preferredNetwork: "testnet" });
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {
        "www-authenticate": `L402 macaroon="${SAMPLE_MACAROON}", invoice="lntb1u..."`,
      },
      body: {},
    });
    expect(r.amount.currency).toBe("tBTC");
  });

  it("throws when www-authenticate missing", async () => {
    const a = new L402ProtocolAdapter();
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: {} })
    ).rejects.toThrowError(/missing/);
  });

  it("buildRetry produces Authorization: L402 macaroon:preimage", async () => {
    const a = new L402ProtocolAdapter();
    const signed: SignedAuthorization = {
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "100000", decimals: 11, currency: "BTC" },
        recipient: "unknown",
        asset: { symbol: "BTC", decimals: 11 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: SAMPLE_MACAROON,
        rawPayload: {},
      },
      signer: "lightning-wallet",
      signature: "deadbeef".repeat(8), // preimage hex (32 bytes)
    };
    const env = await a.buildRetry(signed);
    expect(env.headers["Authorization"]).toBe(
      `L402 ${SAMPLE_MACAROON}:${signed.signature}`
    );
  });

  it("buildRetry rejects when preimage missing", async () => {
    const a = new L402ProtocolAdapter();
    await expect(
      a.buildRetry({
        request: {
          protocol: PROTOCOL_ID,
          amount: { amountAtomic: "1", decimals: 11, currency: "BTC" },
          recipient: "x",
          asset: { symbol: "BTC", decimals: 11 },
          validAfter: 0,
          validBefore: 1,
          nonce: "m",
          rawPayload: {},
        },
        signer: "x",
        signature: "",
      })
    ).rejects.toThrowError(/preimage/);
  });
});
