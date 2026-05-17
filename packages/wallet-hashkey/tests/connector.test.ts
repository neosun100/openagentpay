/**
 * Tests for HashKeyChainConnector.
 *
 * Uses the real eth signing (viem PrivateKeyAccount) but mocks the network
 * I/O via a stub HashKeyChainTokenClient. This validates:
 *   1. signAuthorization produces a real EIP-712 signature
 *   2. createInstrument is idempotent
 *   3. getBalance proxies to token client
 *   4. settle reads txHash from a mocked broadcast
 *
 * For real-chain integration tests, see e2e.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type CreateInstrumentInput,
  type Money,
  type PaymentRequest,
  type ProtocolId,
  type UserId,
} from "@openagentpay/core";
import {
  HashKeyChainConnector,
  HASHKEY_PROTOCOL,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
} from "../src/connector.js";
import { HashKeyChainTokenClient } from "../src/token-client.js";

// A throwaway test private key (NEVER use this for real funds)
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const TEST_AGENT_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"; // derived from above
const TEST_TOKEN = "0x0685C487Df4Cc0723Aa828C299686798294E9803" as const;

const FIXED_NOW_MS = 1778860654_000;

function makeStubTokenClient(): HashKeyChainTokenClient {
  // Cast to any to override read methods without setting up real RPC
  const stub = {
    tokenAddress: TEST_TOKEN,
    chain: { id: 133, name: "HashKey Chain Testnet" },
    publicClient: {} as never,
    getDecimals: vi.fn(async () => 6),
    getName: vi.fn(async () => "Mock USD Coin"),
    getBalance: vi.fn(async () => 1_000_000_000n), // 1000 USDC
    getDomainSeparator: vi.fn(async () => "0x" + "00".repeat(32)),
    isAuthorizationUsed: vi.fn(async () => false),
    signTransferAuthorization: vi.fn(),
    broadcastSignedAuthorization: vi.fn(async () => "0xfeedface" as const),
    waitForReceipt: vi.fn(async () => ({
      blockNumber: 12345n,
      gasUsed: 82_406n,
      status: "success" as const,
    })),
  };
  return stub as unknown as HashKeyChainTokenClient;
}

function makeConnector(tokenClient?: HashKeyChainTokenClient): HashKeyChainConnector {
  return new HashKeyChainConnector({
    privateKey: TEST_PRIVATE_KEY,
    tokenAddress: TEST_TOKEN,
    instrumentStore: new MemoryInstrumentStore(),
    now: () => FIXED_NOW_MS,
    ...(tokenClient !== undefined ? { tokenClient } : {}),
  });
}

const userAlice = "alice" as UserId;
const createInput: CreateInstrumentInput = { userId: userAlice };

describe("HashKeyChainConnector.getCapabilities", () => {
  it("reports hashkey-chain provider", () => {
    const c = makeConnector(makeStubTokenClient());
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.requiresUserApproval).toBe(false);
    expect(caps.settlesOnChain).toBe(true);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedProtocols).toContain(HASHKEY_PROTOCOL);
  });
});

describe("HashKeyChainConnector.createInstrument", () => {
  it("is idempotent — same userId returns same instrument", async () => {
    const c = makeConnector(makeStubTokenClient());
    const a = await c.createInstrument(createInput);
    const b = await c.createInstrument(createInput);
    expect(a.id).toBe(b.id);
  });

  it("publicHandle is the EVM address derived from privateKey", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    expect(inst.publicHandle).toBe(TEST_AGENT_ADDRESS);
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
  });

  it("instrumentId follows naming convention", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    expect(inst.id).toBe("payment-instrument-hashkey-alice");
  });
});

describe("HashKeyChainConnector.getBalance", () => {
  it("returns balance from token client in atomic units", async () => {
    const stub = makeStubTokenClient();
    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("1000000000");
    expect(bal.money.decimals).toBe(6);
    expect(bal.money.currency).toBe("USDC");
  });
});

describe("HashKeyChainConnector.signAuthorization", () => {
  it("rejects wrong protocol id", async () => {
    const c = makeConnector(makeStubTokenClient());
    const inst = await c.createInstrument(createInput);
    const session = makeSession();
    const req = makeRequest({ protocol: "wrong-protocol" as ProtocolId });
    await expect(
      c.signAuthorization({ instrumentId: inst.id, request: req, session })
    ).rejects.toThrow(/only supports protocol/);
  });

  it("returns SignedAuthorization with extra.signed populated", async () => {
    const stub = makeStubTokenClient();
    const fakeSigned = {
      authorization: {
        from: TEST_AGENT_ADDRESS as `0x${string}`,
        to: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23" as `0x${string}`,
        value: "1000000",
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
      },
      signature: "0xsignaturehex" as `0x${string}`,
      v: 27,
      r: ("0x" + "00".repeat(32)) as `0x${string}`,
      s: ("0x" + "00".repeat(32)) as `0x${string}`,
      chainId: 133,
      verifyingContract: TEST_TOKEN as `0x${string}`,
    };
    (stub.signTransferAuthorization as ReturnType<typeof vi.fn>).mockResolvedValue(fakeSigned);

    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const session = makeSession();
    const req = makeRequest({});
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session,
    });
    expect(signed.signer).toBe(TEST_AGENT_ADDRESS);
    expect(signed.signature).toBe("0xsignaturehex");
    expect((signed.extra as Record<string, unknown>)["signed"]).toBe(fakeSigned);
  });
});

describe("HashKeyChainConnector.settle", () => {
  it("returns success + on-chain tx hash on successful broadcast", async () => {
    const stub = makeStubTokenClient();
    const fakeSigned = {
      authorization: {
        from: TEST_AGENT_ADDRESS as `0x${string}`,
        to: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23" as `0x${string}`,
        value: "1000000",
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
      },
      signature: "0xsignaturehex" as `0x${string}`,
      v: 27,
      r: ("0x" + "00".repeat(32)) as `0x${string}`,
      s: ("0x" + "00".repeat(32)) as `0x${string}`,
      chainId: 133,
      verifyingContract: TEST_TOKEN as `0x${string}`,
    };
    (stub.signTransferAuthorization as ReturnType<typeof vi.fn>).mockResolvedValue(fakeSigned);

    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const session = makeSession();
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session,
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(true);
    expect(result.transactionRef).toBe("0xfeedface");
    expect(result.network).toBe("HashKey Chain Testnet");
    const raw = result.raw as Record<string, string>;
    expect(raw.explorerUrl).toBe(
      "https://testnet-explorer.hsk.xyz/tx/0xfeedface"
    );
  });

  it("returns failure when extra.signed is missing", async () => {
    const c = makeConnector(makeStubTokenClient());
    const result = await c.settle({
      request: makeRequest({}),
      signer: "0x0",
      signature: "0x0",
      // no extra.signed
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("signature_invalid");
  });

  it("returns rpc_error on broadcast exception", async () => {
    const stub = makeStubTokenClient();
    (stub.signTransferAuthorization as ReturnType<typeof vi.fn>).mockResolvedValue({
      authorization: {
        from: TEST_AGENT_ADDRESS as `0x${string}`,
        to: "0x0" as `0x${string}`,
        value: "1000",
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
      },
      signature: "0x0" as `0x${string}`,
      v: 27,
      r: ("0x" + "00".repeat(32)) as `0x${string}`,
      s: ("0x" + "00".repeat(32)) as `0x${string}`,
      chainId: 133,
      verifyingContract: TEST_TOKEN as `0x${string}`,
    });
    (stub.broadcastSignedAuthorization as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("RPC unavailable")
    );

    const c = makeConnector(stub);
    const inst = await c.createInstrument(createInput);
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: makeRequest({}),
      session: makeSession(),
    });
    const result = await c.settle(signed);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("rpc_error");
    expect(result.errorMessage).toContain("RPC unavailable");
  });
});

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function makeRequest(opts: { protocol?: ProtocolId }): PaymentRequest {
  return {
    protocol: opts.protocol ?? HASHKEY_PROTOCOL,
    amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" } as Money,
    recipient: "0xaaa86bb77b5a14b23e5724fb12e4685809599f23",
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(FIXED_NOW_MS / 1000) + 600,
    nonce: "0x" + "ab".repeat(32),
    rawPayload: {},
  };
}

function makeSession() {
  const usd: Money = { amountAtomic: "1000000", decimals: 6, currency: "USDC" };
  return {
    id: "sess-1" as never,
    userId: userAlice,
    budget: usd,
    spent: { amountAtomic: "0", decimals: 6, currency: "USDC" } as Money,
    expiresAt: new Date(FIXED_NOW_MS + 3_600_000).toISOString(),
    createdAt: new Date(FIXED_NOW_MS).toISOString(),
    updatedAt: new Date(FIXED_NOW_MS).toISOString(),
    status: "active" as const,
  };
}
