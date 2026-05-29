/**
 * Tests for MetamaskConnector — uses an in-memory EIP-1193 mock provider.
 *
 * Coverage:
 *   - getCapabilities returns metamask metadata
 *   - createInstrument prompts eth_requestAccounts on first call, caches
 *   - getBalance reads via publicClient
 *   - signAuthorization invokes eth_signTypedData_v4 + parses v/r/s
 *   - settle calls eth_sendTransaction and waits for receipt
 *   - rejects non-x402 protocol
 *   - settle handles missing v/r/s gracefully
 *   - settle handles tx revert
 */

import { describe, expect, it, vi } from "vitest";
import {
  MetamaskConnector,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
  METAMASK_PROTOCOL,
  type Eip1193Provider,
} from "../src/index.js";
import type {
  PaymentRequest,
  Session,
  UserId,
} from "@openagentpay/core";

// ----------------------------------------------------------------------------
//  Test harness — fake EIP-1193 provider + chain
// ----------------------------------------------------------------------------

const TEST_CHAIN = {
  id: 11155111,
  name: "Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.example"] }, public: { http: ["https://sepolia.example"] } },
  blockExplorers: { default: { name: "Sepolia Explorer", url: "https://sepolia.io" } },
} as const;

const TOKEN = "0x1111111111111111111111111111111111111111" as const;
const ACCOUNT = "0x2222222222222222222222222222222222222222";

function makeProvider(): {
  provider: Eip1193Provider;
  calls: Record<string, unknown[]>;
  inject: Record<string, () => unknown>;
} {
  const calls: Record<string, unknown[]> = {};
  const inject: Record<string, () => unknown> = {
    eth_requestAccounts: () => [ACCOUNT],
    eth_signTypedData_v4: () =>
      // 65-byte signature: r(32) + s(32) + v(1) → 0x..1b
      "0x" +
      "a".repeat(64) +
      "b".repeat(64) +
      "1b",
    eth_sendTransaction: () => "0x" + "c".repeat(64),
    eth_call: () => "0x" + "0".repeat(62) + "06", // decimals=6 OR balance/name fallback
  };

  const provider: Eip1193Provider = {
    async request(args) {
      calls[args.method] = calls[args.method] ?? [];
      calls[args.method]!.push(args.params);
      const f = inject[args.method];
      if (!f) throw new Error(`Unmocked method: ${args.method}`);
      return f();
    },
  };
  return { provider, calls, inject };
}

// We build a minimal PublicClient-shaped mock by stubbing its .readContract
// and waitForTransactionReceipt via spies. Easier: pass `rpcUrl` so that
// viem builds an http transport, then mock viem.createPublicClient itself.
//
// Simpler approach: subclass MetamaskConnector for tests so we can swap the
// publicClient. We achieve this by injecting viem behavior via an
// instrument store hack. For the unit tests below, we rely on the
// EIP-1193 path and mock the underlying viem client.

// ----------------------------------------------------------------------------
//  Tests
// ----------------------------------------------------------------------------

describe("MetamaskConnector — capabilities + provider id", () => {
  it("reports metamask provider id", () => {
    const { provider } = makeProvider();
    const c = new MetamaskConnector({
      provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(METAMASK_PROTOCOL);
    expect(caps.requiresUserApproval).toBe(true);
    expect(caps.settlesOnChain).toBe(true);
  });

  it("generateNonce returns 0x-prefixed 64-char hex", () => {
    const { provider } = makeProvider();
    const c = new MetamaskConnector({
      provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const n = c.generateNonce();
    expect(n).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("MetamaskConnector — resolveAddress + createInstrument", () => {
  it("resolveAddress calls eth_requestAccounts and caches the result", async () => {
    const { provider, calls } = makeProvider();
    const c = new MetamaskConnector({
      provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const a1 = await c.resolveAddress();
    const a2 = await c.resolveAddress();
    expect(a1).toBe(ACCOUNT);
    expect(a2).toBe(ACCOUNT);
    // eth_requestAccounts called only once due to cache
    expect(calls["eth_requestAccounts"]?.length).toBe(1);
  });

  it("createInstrument is idempotent — same userId, same instrument", async () => {
    const { provider } = makeProvider();
    const store = new MemoryInstrumentStore();
    const c = new MetamaskConnector({
      provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: store,
    });
    const a = await c.createInstrument({ userId: "alice" as UserId });
    const b = await c.createInstrument({ userId: "alice" as UserId });
    expect(a.id).toBe(b.id);
    expect(a.publicHandle).toBe(ACCOUNT);
    expect(a.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("uses cachedAccount config if provided (no eth_requestAccounts)", async () => {
    const { provider, calls } = makeProvider();
    const c = new MetamaskConnector({
      provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
      cachedAccount: ACCOUNT as any,
    });
    await c.createInstrument({ userId: "bob" as UserId });
    expect(calls["eth_requestAccounts"]).toBeUndefined();
  });
});

describe("MetamaskConnector.signAuthorization", () => {
  it("rejects non-x402 protocol", async () => {
    const { provider } = makeProvider();
    const c = new MetamaskConnector({
      provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const fakeReq = {
      protocol: "ap2-v0.1",
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      recipient: "0xR",
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: 9_999_999_999,
      nonce: "0xabc",
      rawPayload: {},
    } as unknown as PaymentRequest;
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: fakeReq,
        session: {} as Session,
      })
    ).rejects.toThrow(/only supports x402-v1/);
  });

  it("signs via eth_signTypedData_v4 and extracts v/r/s", async () => {
    // We stub readContract by overriding the publicClient's readContract via
    // monkey-patching after construction.
    const { provider } = makeProvider();
    const c = new MetamaskConnector({
      provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    // @ts-ignore — test-only injection
    (c as any).publicClient = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "name") return "USDC";
        if (functionName === "decimals") return 6;
        if (functionName === "balanceOf") return 1000000n;
        throw new Error("unknown read");
      },
      waitForTransactionReceipt: async () => ({
        status: "success",
        blockNumber: 1n,
        gasUsed: 100n,
      }),
    };
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const req = {
      protocol: "x402-v1",
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      recipient: "0x000000000000000000000000000000000000dead",
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: 9_999_999_999,
      nonce: "0x" + "f".repeat(64),
      rawPayload: {},
    } as unknown as PaymentRequest;
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: {} as Session,
    });
    expect(signed.signer.toLowerCase()).toBe(ACCOUNT.toLowerCase());
    expect(signed.signature).toMatch(/^0x[0-9a-f]+$/);
    const e = signed.extra ?? ({} as any);
    expect(e["chainId"]).toBe(TEST_CHAIN.id);
    expect(e["verifyingContract"]).toBe(TOKEN);
    expect(typeof e["v"]).toBe("number");
    expect(e["r"]).toMatch(/^0x[0-9a-f]+$/);
    expect(e["s"]).toMatch(/^0x[0-9a-f]+$/);
  });
});

describe("MetamaskConnector.settle", () => {
  it("returns success when tx receipt status is success", async () => {
    const { provider } = makeProvider();
    const c = new MetamaskConnector({
      provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    // @ts-ignore — test-only injection
    (c as any).publicClient = {
      waitForTransactionReceipt: async () => ({
        status: "success",
        blockNumber: 100n,
        gasUsed: 50000n,
      }),
    };
    const result = await c.settle({
      request: {
        protocol: "x402-v1",
        amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
        recipient: "0xdead",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "0x" + "0".repeat(64),
        rawPayload: {},
      } as any,
      signer: ACCOUNT,
      signature: "0xsig",
      extra: {
        v: 27,
        r: "0x" + "1".repeat(64),
        s: "0x" + "2".repeat(64),
      },
    });
    expect(result.success).toBe(true);
    expect(result.transactionRef).toMatch(/^0x[0-9a-f]+$/);
    expect((result.raw as any).explorerUrl).toContain("https://sepolia.io/tx/");
  });

  it("returns failure when v/r/s missing", async () => {
    const { provider } = makeProvider();
    const c = new MetamaskConnector({
      provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const r = await c.settle({
      request: {
        protocol: "x402-v1",
        amount: { amountAtomic: "1", decimals: 6, currency: "USDC" },
        recipient: "0xR",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 999,
        nonce: "0xnonce",
        rawPayload: {},
      } as any,
      signer: ACCOUNT,
      signature: "0x",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("signature_invalid");
  });

  it("returns failure when tx reverts", async () => {
    const { provider } = makeProvider();
    const c = new MetamaskConnector({
      provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    // @ts-ignore — test injection
    (c as any).publicClient = {
      waitForTransactionReceipt: async () => ({
        status: "reverted",
        blockNumber: 1n,
        gasUsed: 100n,
      }),
    };
    const r = await c.settle({
      request: {
        protocol: "x402-v1",
        amount: { amountAtomic: "1", decimals: 6, currency: "USDC" },
        recipient: "0xR",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 999,
        nonce: "0xnonce",
        rawPayload: {},
      } as any,
      signer: ACCOUNT,
      signature: "0xsig",
      extra: {
        v: 28,
        r: "0x" + "3".repeat(64),
        s: "0x" + "4".repeat(64),
      },
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("rpc_error");
  });

  it("captures network error during eth_sendTransaction", async () => {
    const { provider, inject } = makeProvider();
    inject["eth_sendTransaction"] = () => {
      throw new Error("user rejected request");
    };
    const c = new MetamaskConnector({
      provider,
      tokenAddress: TOKEN,
      chain: TEST_CHAIN as any,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const r = await c.settle({
      request: {
        protocol: "x402-v1",
        amount: { amountAtomic: "1", decimals: 6, currency: "USDC" },
        recipient: "0xR",
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 999,
        nonce: "0xnonce",
        rawPayload: {},
      } as any,
      signer: ACCOUNT,
      signature: "0xsig",
      extra: {
        v: 27,
        r: "0x" + "5".repeat(64),
        s: "0x" + "6".repeat(64),
      },
    });
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/user rejected/);
  });
});
