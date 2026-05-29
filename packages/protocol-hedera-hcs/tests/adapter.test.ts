import { describe, it, expect } from "vitest";
import { HederaHcsProtocolAdapter, PROTOCOL_ID } from "../src/adapter.js";

const valid = {
  hederaVersion: "1.0",
  network: "testnet" as const,
  payee: "0.0.12345",
  token: "USDC",
  tokenId: "0.0.456858",
  amount: { value: "1000000", currency: "USDC", decimals: 6 },
  memo: "API call",
  validBefore: Math.floor(Date.now() / 1000) + 600,
  nonce: "0xnoncehedera",
};

describe("HederaHcsProtocolAdapter", () => {
  it("detects valid", () => {
    const a = new HederaHcsProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: valid })).toBe(true);
  });

  it("rejects non-402", () => {
    const a = new HederaHcsProtocolAdapter();
    expect(a.detect({ statusCode: 200 as 402, headers: {}, body: valid })).toBe(false);
  });

  it("parses with HTS tokenId in asset.contract", async () => {
    const a = new HederaHcsProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: valid });
    expect(r.protocol).toBe(PROTOCOL_ID);
    expect(r.recipient).toBe("0.0.12345");
    expect(r.asset.contract).toBe("0.0.456858");
  });

  it("rejects malformed payee", async () => {
    const a = new HederaHcsProtocolAdapter();
    await expect(
      (async () =>
        a.parsePaymentRequired({
          statusCode: 402,
          headers: {},
          body: { ...valid, payee: "0xnotHedera" },
        }))()
    ).rejects.toThrow();
  });

  it("HBAR native (no tokenId) does not set asset.contract", async () => {
    const a = new HederaHcsProtocolAdapter();
    const { tokenId: _, ...nativeHbar } = valid;
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: { ...nativeHbar, token: "HBAR", amount: { value: "100000000", currency: "HBAR", decimals: 8 } },
    });
    expect(r.asset.contract).toBe(undefined);
  });
});
