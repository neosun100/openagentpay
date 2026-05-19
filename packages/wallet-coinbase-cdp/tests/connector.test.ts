/**
 * CoinbaseCDPConnector — capability + interface conformance unit tests
 *
 * These tests do NOT require live CDP credentials. They exercise the public
 * surface (capabilities, instrument creation, store contract) using mock-style
 * CDP responses, mirroring the same pattern as wallet-hashkey conformance.
 *
 * Real on-chain verification is in scripts/coinbase-cdp-smoke.ts (run manually
 * with credentials in .env.local).
 */
import { describe, expect, it } from "vitest";
import {
  COINBASE_CDP_PROTOCOL,
  CoinbaseCDPConnector,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
} from "../src/index.js";
import type { UserId } from "@openagentpay/core";

const FAKE_CFG = {
  apiKeyId: "fake-key-id",
  apiKeySecret: "fake-key-secret-base64",
  walletSecret: "fake-wallet-secret-pem",
  agentAddress: "0x851C03756D5e9e057cb518C1B3cd47f628a0Dca7" as `0x${string}`,
  recipientAddress:
    "0x000000000000000000000000000000000000dEaD" as `0x${string}`,
};

describe("CoinbaseCDPConnector — capabilities", () => {
  it("advertises coinbase-cdp wallet provider", () => {
    const c = new CoinbaseCDPConnector({
      ...FAKE_CFG,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.walletProvider).toBe("coinbase-cdp");
  });

  it("declares Base Sepolia + Circle USDC support", () => {
    const c = new CoinbaseCDPConnector({
      ...FAKE_CFG,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const caps = c.getCapabilities();
    expect(caps.supportedAssets.map((a) => a.symbol)).toContain("USDC");
    expect(caps.supportedProtocols).toContain(COINBASE_CDP_PROTOCOL);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.requiresUserApproval).toBe(false); // managed wallet
  });

  it("flags managed-wallet + Circle USDC features", () => {
    const c = new CoinbaseCDPConnector({
      ...FAKE_CFG,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const features = c.getCapabilities().features ?? {};
    expect(features["managedWallet"]).toBe(true);
    expect(features["circleUSDC"]).toBe(true);
    expect(features["gasIncluded"]).toBe(true);
  });
});

describe("CoinbaseCDPConnector — instrument lifecycle", () => {
  it("createInstrument is idempotent per userId", async () => {
    const store = new MemoryInstrumentStore();
    const c = new CoinbaseCDPConnector({ ...FAKE_CFG, instrumentStore: store });
    const userId = "test-user" as UserId;
    const a = await c.createInstrument({ userId });
    const b = await c.createInstrument({ userId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(FAKE_CFG.agentAddress);
    expect(a.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("instrument id includes user id and provider prefix", async () => {
    const c = new CoinbaseCDPConnector({
      ...FAKE_CFG,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const userId = "demo-user-xyz" as UserId;
    const inst = await c.createInstrument({ userId });
    expect(inst.id).toBe(
      "payment-instrument-coinbase-cdp-demo-user-xyz"
    );
  });

  it("provider metadata includes Base Sepolia chain info", async () => {
    const c = new CoinbaseCDPConnector({
      ...FAKE_CFG,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await c.createInstrument({ userId: "u" as UserId });
    expect(inst.providerMetadata?.["chainId"]).toBe(84532);
    expect(inst.providerMetadata?.["chainName"]).toBe("base-sepolia");
    expect(inst.providerMetadata?.["tokenAddress"]).toBe(
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    );
  });
});

describe("CoinbaseCDPConnector — utilities", () => {
  it("generates 32-byte hex nonces", () => {
    const c = new CoinbaseCDPConnector({
      ...FAKE_CFG,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const n = c.generateNonce();
    expect(n).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("each nonce is unique", () => {
    const c = new CoinbaseCDPConnector({
      ...FAKE_CFG,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const ns = new Set([
      c.generateNonce(),
      c.generateNonce(),
      c.generateNonce(),
      c.generateNonce(),
      c.generateNonce(),
    ]);
    expect(ns.size).toBe(5);
  });

  it("agentAddress accessor returns configured address", () => {
    const c = new CoinbaseCDPConnector({
      ...FAKE_CFG,
      instrumentStore: new MemoryInstrumentStore(),
    });
    expect(c.agentAddress).toBe(FAKE_CFG.agentAddress);
  });
});

describe("MemoryInstrumentStore", () => {
  it("stores and retrieves by user and id", async () => {
    const store = new MemoryInstrumentStore();
    const c = new CoinbaseCDPConnector({ ...FAKE_CFG, instrumentStore: store });
    const userId = "u1" as UserId;
    const inst = await c.createInstrument({ userId });
    expect(await store.get(userId)).toEqual(inst);
    expect(await store.getById(inst.id)).toEqual(inst);
  });

  it("returns undefined for unknown ids", async () => {
    const store = new MemoryInstrumentStore();
    expect(await store.get("nonexistent" as UserId)).toBeUndefined();
    expect(await store.getById("nonexistent" as any)).toBeUndefined();
  });
});
