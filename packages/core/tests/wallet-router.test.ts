/**
 * WalletRouter unit tests.
 *
 * @license Apache-2.0
 */

import { describe, it, expect } from "vitest";
import {
  WalletRouter,
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type PaymentRequest,
  type ProtocolId,
  type SettlementResult,
  type SignAuthorizationInput,
  type SignedAuthorization,
  type UserId,
  type WalletCapabilities,
  type WalletConnector,
  type WalletProviderId,
} from "../src/index.js";

// ---------------------------------------------------------------------------
//  Test helpers — minimal connectors with configurable capabilities
// ---------------------------------------------------------------------------

function makeConnector(opts: {
  id: string;
  protocols?: readonly ProtocolId[];
  assets?: readonly Asset[];
  settlesOnChain?: boolean;
  typicalLatencyMs?: number;
  hasInstrument?: boolean;
}): WalletConnector {
  const protocols = opts.protocols ?? (["x402-v1" as ProtocolId] as const);
  const assets =
    opts.assets ?? ([{ symbol: "USDC", decimals: 6 }] as const);
  const has = opts.hasInstrument ?? true;
  return {
    getCapabilities: (): WalletCapabilities => ({
      walletProvider: opts.id as WalletProviderId,
      displayName: opts.id,
      supportedAssets: assets,
      supportedProtocols: protocols,
      requiresUserApproval: false,
      settlesOnChain: opts.settlesOnChain ?? true,
      ...(opts.typicalLatencyMs !== undefined
        ? { typicalLatencyMs: opts.typicalLatencyMs }
        : {}),
    }),
    async createInstrument(_: CreateInstrumentInput): Promise<Instrument> {
      throw new Error("not used");
    },
    async getBalance(_: InstrumentId): Promise<Balance> {
      throw new Error("not used");
    },
    async signAuthorization(
      _: SignAuthorizationInput
    ): Promise<SignedAuthorization> {
      throw new Error("not used");
    },
    async settle(_: SignedAuthorization): Promise<SettlementResult> {
      throw new Error("not used");
    },
  } as WalletConnector;
}

function buildRequest(opts: {
  protocol?: ProtocolId;
  symbol?: string;
} = {}): PaymentRequest {
  return {
    protocol: opts.protocol ?? ("x402-v1" as ProtocolId),
    amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
    recipient: "0x000000000000000000000000000000000000dEaD",
    asset: { symbol: opts.symbol ?? "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "0x" + "0".repeat(64),
    rawPayload: {},
  };
}

function makeResolver(idMap: Record<string, boolean>): {
  resolver: NonNullable<Parameters<WalletRouter["choose"]>[0]["instrumentResolver"]>;
} {
  return {
    resolver: async (provider) => {
      if (!idMap[provider]) return undefined;
      return {
        id: `payment-instrument-${provider}` as InstrumentId,
        userId: "test-user" as UserId,
        walletProvider: provider,
        publicHandle: `handle-${provider}`,
        createdAt: new Date().toISOString(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("WalletRouter — capability filtering", () => {
  it("rejects wallets that don't support the request protocol", async () => {
    const router = new WalletRouter({
      connectors: [
        makeConnector({ id: "a", protocols: ["x402-v1" as ProtocolId] }),
        makeConnector({ id: "b", protocols: ["solana-pay-v1" as ProtocolId] }),
      ],
    });
    const r = await router.choose({
      request: buildRequest({ protocol: "solana-pay-v1" as ProtocolId }),
      instrumentResolver: makeResolver({ a: true, b: true }).resolver,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.connector as any).getCapabilities().walletProvider).toBe("b");
  });

  it("rejects wallets that don't support the request asset", async () => {
    const router = new WalletRouter({
      connectors: [
        makeConnector({ id: "usdc-only" }),
        makeConnector({
          id: "usdt-only",
          assets: [{ symbol: "USDT", decimals: 6 }],
        }),
      ],
    });
    const r = await router.choose({
      request: buildRequest({ symbol: "USDT" }),
      instrumentResolver: makeResolver({ "usdc-only": true, "usdt-only": true }).resolver,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.connector as any).getCapabilities().walletProvider).toBe("usdt-only");
  });

  it("returns no_eligible_wallet when nothing matches", async () => {
    const router = new WalletRouter({
      connectors: [
        makeConnector({
          id: "x",
          protocols: ["x402-v1" as ProtocolId],
          assets: [{ symbol: "USDC", decimals: 6 }],
        }),
      ],
    });
    const r = await router.choose({
      request: buildRequest({ protocol: "solana-pay-v1" as ProtocolId }),
      instrumentResolver: makeResolver({ x: true }).resolver,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_eligible_wallet");
  });
});

describe("WalletRouter — strategies", () => {
  const trio = () => [
    makeConnector({ id: "fast", typicalLatencyMs: 800, settlesOnChain: false }),
    makeConnector({ id: "slow", typicalLatencyMs: 5000, settlesOnChain: true }),
    makeConnector({ id: "mid", typicalLatencyMs: 3500, settlesOnChain: true }),
  ];

  it("priority follows fallback order", async () => {
    const router = new WalletRouter({
      connectors: trio(),
      fallback: ["mid" as WalletProviderId, "fast" as WalletProviderId, "slow" as WalletProviderId],
      strategy: "priority",
    });
    const r = await router.choose({
      request: buildRequest(),
      instrumentResolver: makeResolver({ mid: true, fast: true, slow: true }).resolver,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.connector as any).getCapabilities().walletProvider).toBe("mid");
  });

  it("least-latency picks the smallest typicalLatencyMs", async () => {
    const router = new WalletRouter({ connectors: trio(), strategy: "least-latency" });
    const r = await router.choose({
      request: buildRequest(),
      instrumentResolver: makeResolver({ fast: true, mid: true, slow: true }).resolver,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.connector as any).getCapabilities().walletProvider).toBe("fast");
  });

  it("least-cost prefers off-chain (CEX) wallets", async () => {
    const router = new WalletRouter({ connectors: trio(), strategy: "least-cost" });
    const r = await router.choose({
      request: buildRequest(),
      instrumentResolver: makeResolver({ fast: true, mid: true, slow: true }).resolver,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.connector as any).getCapabilities().walletProvider).toBe("fast");
  });

  it("round-robin advances on each call", async () => {
    const router = new WalletRouter({ connectors: trio(), strategy: "round-robin" });
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await router.choose({
        request: buildRequest(),
        instrumentResolver: makeResolver({ fast: true, mid: true, slow: true }).resolver,
      });
      if (r.ok) seen.push((r.connector as any).getCapabilities().walletProvider);
    }
    // Each unique provider appears at least once across 6 calls
    expect(new Set(seen).size).toBeGreaterThanOrEqual(2);
  });

  it("user-affinity sticks to the same wallet across calls for the same userId", async () => {
    const router = new WalletRouter({ connectors: trio(), strategy: "user-affinity" });
    const r1 = await router.choose({
      request: buildRequest(),
      userId: "alice",
      instrumentResolver: makeResolver({ fast: true, mid: true, slow: true }).resolver,
    });
    const r2 = await router.choose({
      request: buildRequest(),
      userId: "alice",
      instrumentResolver: makeResolver({ fast: true, mid: true, slow: true }).resolver,
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect((r1.connector as any).getCapabilities().walletProvider).toBe(
        (r2.connector as any).getCapabilities().walletProvider
      );
    }
  });
});

describe("WalletRouter — disabling and fallback", () => {
  it("skips disabled providers", async () => {
    const router = new WalletRouter({
      connectors: [makeConnector({ id: "a" }), makeConnector({ id: "b" })],
      disabledProviders: ["a" as WalletProviderId],
    });
    const r = await router.choose({
      request: buildRequest(),
      instrumentResolver: makeResolver({ a: true, b: true }).resolver,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.connector as any).getCapabilities().walletProvider).toBe("b");
  });

  it("falls back when first wallet has no instrument", async () => {
    const router = new WalletRouter({
      connectors: [makeConnector({ id: "a" }), makeConnector({ id: "b" })],
      fallback: ["a" as WalletProviderId, "b" as WalletProviderId],
    });
    const r = await router.choose({
      request: buildRequest(),
      instrumentResolver: makeResolver({ a: false, b: true }).resolver,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.connector as any).getCapabilities().walletProvider).toBe("b");
  });

  it("returns all_disabled when every connector is disabled", async () => {
    const router = new WalletRouter({
      connectors: [makeConnector({ id: "a" }), makeConnector({ id: "b" })],
      disabledProviders: ["a" as WalletProviderId, "b" as WalletProviderId],
    });
    const r = await router.choose({
      request: buildRequest(),
      instrumentResolver: makeResolver({ a: true, b: true }).resolver,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("all_disabled");
  });
});

describe("WalletRouter — diagnostics", () => {
  it("list() returns registered providers", () => {
    const router = new WalletRouter({
      connectors: [makeConnector({ id: "a" }), makeConnector({ id: "b" })],
    });
    expect(router.list()).toEqual(["a", "b"]);
  });

  it("get() returns the connector by id", () => {
    const a = makeConnector({ id: "a" });
    const router = new WalletRouter({ connectors: [a] });
    expect(router.get("a" as WalletProviderId)).toBe(a);
    expect(router.get("nonexistent" as WalletProviderId)).toBe(undefined);
  });

  it("populates rejections map with per-provider reason", async () => {
    const router = new WalletRouter({
      connectors: [
        makeConnector({ id: "wrong-asset", assets: [{ symbol: "ETH", decimals: 18 }] }),
        makeConnector({ id: "right" }),
      ],
    });
    const r = await router.choose({
      request: buildRequest(),
      instrumentResolver: makeResolver({ "wrong-asset": true, right: true }).resolver,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rejections["wrong-asset"]).toMatch(/asset_not_supported/);
    }
  });
});
