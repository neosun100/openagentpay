import { describe, expect, it } from "vitest";
import { StellarSep31ProtocolAdapter, PROTOCOL_ID, X_PAYMENT_STELLAR_HEADER, type Stellar402Body } from "../src/index.js";
import { ProtocolError, type SignedAuthorization } from "@openagentpay/core";

const baseBody: Stellar402Body = {
  stellarVersion: "31",
  anchor: {
    domain: "circle.com",
    sendingAccount: "GABCDEF1234567890",
    receivingAccount: "GHIJKLMN1234567890",
    memoType: "text",
    memo: "ord_001",
  },
  amount: {
    value: "1000000",
    assetCode: "USDC",
    assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    decimals: 7,
  },
  description: "Cross-border micropayment",
};

describe("StellarSep31ProtocolAdapter", () => {
  it("detects stellar body", () => {
    const a = new StellarSep31ProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: baseBody })).toBe(true);
  });

  it("rejects non-stellar body", () => {
    const a = new StellarSep31ProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });

  it("parses to PaymentRequest", async () => {
    const a = new StellarSep31ProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody });
    expect(r.amount.amountAtomic).toBe("1000000");
    expect(r.amount.currency).toBe("USDC");
    expect(r.amount.decimals).toBe(7);
    expect(r.recipient).toBe(baseBody.anchor.receivingAccount);
    expect(r.nonce).toBe("ord_001");
    expect(r.asset.chain).toBe("stellar:pubnet");
  });

  it("rejects untrusted anchor", async () => {
    const a = new StellarSep31ProtocolAdapter({ trustedAnchors: ["other.com"] });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/anchor.*not trusted/);
  });

  it("rejects untrusted issuer", async () => {
    const a = new StellarSep31ProtocolAdapter({ trustedIssuers: ["GOTHERISSUER"] });
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: baseBody })
    ).rejects.toThrowError(/issuer.*not trusted/);
  });

  it("enforces SEP-29 memo requirement", async () => {
    const a = new StellarSep31ProtocolAdapter();
    const broken = JSON.parse(JSON.stringify(baseBody));
    broken.anchor.memo = "";
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/memo/);
  });

  it("throws on missing anchor field", async () => {
    const a = new StellarSep31ProtocolAdapter();
    const broken: any = JSON.parse(JSON.stringify(baseBody));
    delete broken.anchor.receivingAccount;
    await expect(
      a.parsePaymentRequired({ statusCode: 402, headers: {}, body: broken })
    ).rejects.toThrowError(/receivingAccount/);
  });

  it("buildRetry emits X-PAYMENT-STELLAR with base64url XDR", async () => {
    const a = new StellarSep31ProtocolAdapter();
    const signed: SignedAuthorization = {
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1000000", decimals: 7, currency: "USDC" },
        recipient: "GHIJKLMN", asset: { symbol: "USDC", decimals: 7 },
        validAfter: 0, validBefore: 9_999_999_999, nonce: "ord_001", rawPayload: {},
      },
      signer: "GABCDEF",
      signature: "AAAAAgAAAA...XDR_BASE64",
    };
    const env = await a.buildRetry(signed);
    const decoded = JSON.parse(Buffer.from(env.headers[X_PAYMENT_STELLAR_HEADER]!, "base64url").toString("utf8"));
    expect(decoded.stellarVersion).toBe("31");
    expect(decoded.txEnvelope).toBe("AAAAAgAAAA...XDR_BASE64");
    expect(decoded.memo).toBe("ord_001");
  });
});
