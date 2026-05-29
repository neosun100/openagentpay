import { describe, it, expect } from "vitest";
import { CosmosIbcProtocolAdapter, PROTOCOL_ID } from "../src/adapter.js";

const valid = {
  cosmosIbcVersion: "1.0",
  sourceChain: "cosmoshub-4",
  destChain: "osmosis-1",
  sourcePort: "transfer",
  sourceChannel: "channel-141",
  payee: "cosmos1abc123def456ghi789jkl012mno345pqr",
  denom: "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2",
  amount: { value: "1000000", currency: "ATOM", decimals: 6 },
  memo: "agent payment",
  nonce: "0xnoncecosmos",
};

describe("CosmosIbcProtocolAdapter", () => {
  it("detects valid", () => {
    const a = new CosmosIbcProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: valid })).toBe(true);
  });

  it("rejects non-cosmos body", () => {
    const a = new CosmosIbcProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { foo: "bar" } })).toBe(false);
  });

  it("parses with denom in asset.contract", async () => {
    const a = new CosmosIbcProtocolAdapter();
    const r = await a.parsePaymentRequired({ statusCode: 402, headers: {}, body: valid });
    expect(r.protocol).toBe(PROTOCOL_ID);
    expect(r.recipient).toBe(valid.payee);
    expect(r.asset.contract).toBe(valid.denom);
  });

  it("rejects malformed bech32 payee", async () => {
    const a = new CosmosIbcProtocolAdapter();
    await expect(
      (async () =>
        a.parsePaymentRequired({
          statusCode: 402,
          headers: {},
          body: { ...valid, payee: "0xNotBech32" },
        }))()
    ).rejects.toThrow();
  });

  it("uses timeoutTimestamp (ns) → validBefore (s)", async () => {
    const a = new CosmosIbcProtocolAdapter();
    const ts = Date.now() * 1_000_000 + 600 * 1_000_000_000;
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: { ...valid, timeoutTimestamp: ts },
    });
    expect(r.validBefore).toBe(Math.floor(ts / 1_000_000_000));
  });
});
