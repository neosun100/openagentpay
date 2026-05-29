/**
 * Tests for WalletConnectConnector.
 *
 * Coverage:
 *   - Capabilities: walletProvider=walletconnect, peer wallet name in displayName
 *   - connect() called once on first usage, not again on subsequent calls
 *   - Provider without connect() handled gracefully
 *   - Instrument has walletProvider=walletconnect (not metamask)
 *   - Inner MetamaskConnector logic still works (delegate test)
 */

import { describe, expect, it, vi } from "vitest";
import {
  WalletConnectConnector,
  WALLET_PROVIDER_ID,
  WC_PROTOCOL,
  MemoryInstrumentStore,
  type Eip1193Provider,
} from "../src/index.js";
import type { UserId } from "@openagentpay/core";

const TEST_CHAIN = {
  id: 11155111,
  name: "Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.example"] }, public: { http: ["https://sepolia.example"] } },
  blockExplorers: { default: { name: "Sepolia Explorer", url: "https://sepolia.io" } },
} as const;

const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const ACCOUNT = "0x3333333333333333333333333333333333333333";

function makeWcProvider(opts: { withConnect?: boolean } = {}) {
  const calls: Record<string, number> = {};
  const provider: Eip1193Provider & { connect?: () => Promise<void> } = {
    async request(args) {
      calls[args.method] = (calls[args.method] ?? 0) + 1;
      if (args.method === "eth_requestAccounts") return [ACCOUNT];
      if (args.method === "eth_signTypedData_v4")
        return "0x" + "a".repeat(64) + "b".repeat(64) + "1b";
      if (args.method === "eth_sendTransaction") return "0x" + "c".repeat(64);
      throw new Error(`unmocked: ${args.method}`);
    },
  };
  if (opts.withConnect ?? true) {
    provider.connect = async () => {
      calls["__connect__"] = (calls["__connect__"] ?? 0) + 1;
    };
  }
  return { provider, calls };
}

describe("WalletConnectConnector — capabilities", () => {
  it("reports walletconnect provider id and peer name", () => {
    const { provider } = makeWcProvider();
    const c = new WalletConnectConnector({
      wcProvider: provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
      peerWalletName: "Rainbow",
    });
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.displayName).toContain("Rainbow");
    expect(caps.supportedProtocols).toContain(WC_PROTOCOL);
    expect(caps.features?.walletconnect).toBe(true);
    expect(caps.features?.protocolVersion).toBe(2);
  });

  it("uses default peer name when not provided", () => {
    const { provider } = makeWcProvider();
    const c = new WalletConnectConnector({
      wcProvider: provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    expect(c.getCapabilities().displayName).toContain("WalletConnect peer");
  });
});

describe("WalletConnectConnector — connect lifecycle", () => {
  it("calls connect() exactly once", async () => {
    const { provider, calls } = makeWcProvider({ withConnect: true });
    const c = new WalletConnectConnector({
      wcProvider: provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    await c.createInstrument({ userId: "alice" as UserId });
    await c.createInstrument({ userId: "alice" as UserId }); // idempotent
    expect(calls["__connect__"]).toBe(1);
  });

  it("works when provider has no connect() method", async () => {
    const { provider } = makeWcProvider({ withConnect: false });
    const c = new WalletConnectConnector({
      wcProvider: provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await c.createInstrument({ userId: "bob" as UserId });
    expect(inst.publicHandle).toBe(ACCOUNT);
  });

  it("createInstrument decorates with walletconnect provider id", async () => {
    const { provider } = makeWcProvider();
    const c = new WalletConnectConnector({
      wcProvider: provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
      peerWalletName: "Trust Wallet",
    });
    const inst = await c.createInstrument({ userId: "carol" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect((inst.providerMetadata as any).peerWallet).toBe("Trust Wallet");
    expect((inst.providerMetadata as any).walletconnectVersion).toBe(2);
  });
});

describe("WalletConnectConnector — delegates to MetamaskConnector", () => {
  it("generateNonce returns valid hex", () => {
    const { provider } = makeWcProvider();
    const c = new WalletConnectConnector({
      wcProvider: provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    expect(c.generateNonce()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("resolveAddress returns the wallet address (after connect)", async () => {
    const { provider } = makeWcProvider();
    const c = new WalletConnectConnector({
      wcProvider: provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    expect(await c.resolveAddress()).toBe(ACCOUNT);
  });
});
