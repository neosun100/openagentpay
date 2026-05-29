/**
 * Tests for v0.10 governance extensions:
 *   - ApprovalManager (Cobo PACT-style 2-of-N)
 *   - PerAgentPolicyEngine
 *   - jurisdictionRestriction policy
 *   - ChainalysisKYTChecker (mocked fetch)
 *   - TRMLabsChecker (mocked fetch)
 *   - OFACSdnAutoSyncChecker (mocked fetch)
 */

import { describe, it, expect } from "vitest";
import type { Money, PaymentRequest, ProtocolId, Session, SessionId, UserId, WalletProviderId } from "@openagentpay/core";
import {
  ApprovalManager,
  ChainalysisKYTChecker,
  InMemoryApprovalStore,
  jurisdictionRestriction,
  OFACSdnAutoSyncChecker,
  PerAgentPolicyEngine,
  TRMLabsChecker,
  amountThreshold,
} from "../src/index.js";

// ============================================================================
//  Test fixture builders
// ============================================================================

function buildSession(metadata?: Record<string, string>): Session {
  return {
    id: "sess-1" as SessionId,
    userId: "alice" as UserId,
    budget: { amountAtomic: "100000000", decimals: 6, currency: "USDC" },
    spent: { amountAtomic: "0", decimals: 6, currency: "USDC" },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function buildRequest(overrides?: Partial<PaymentRequest>): PaymentRequest {
  return {
    protocol: "x402-v1" as ProtocolId,
    amount: { amountAtomic: "10000", decimals: 6, currency: "USDC" } as Money,
    recipient: "0x000000000000000000000000000000000000dEaD",
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "0x" + "0".repeat(64),
    rawPayload: {},
    ...overrides,
  };
}

// ============================================================================
//  ApprovalManager
// ============================================================================

describe("ApprovalManager", () => {
  it("creates a pending approval request", async () => {
    const mgr = new ApprovalManager({ store: new InMemoryApprovalStore() });
    const r = await mgr.create({
      sessionId: "s1" as SessionId,
      initiator: "alice" as UserId,
      walletProvider: "hashkey" as WalletProviderId,
      recipient: "0xabc",
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      reason: "high-value tx",
      requiredApprovals: 2,
      approverPool: ["bob" as UserId, "carol" as UserId, "dave" as UserId],
    });
    expect(r.status).toBe("pending");
    expect(r.requiredApprovals).toBe(2);
  });

  it("flips to approved after the Nth approval", async () => {
    const mgr = new ApprovalManager({ store: new InMemoryApprovalStore() });
    const r = await mgr.create({
      sessionId: "s1" as SessionId,
      initiator: "alice" as UserId,
      walletProvider: "hashkey" as WalletProviderId,
      recipient: "0xabc",
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      reason: "x",
      requiredApprovals: 2,
      approverPool: ["bob" as UserId, "carol" as UserId],
    });
    const after1 = await mgr.approve(r.id, "bob" as UserId);
    expect(after1.status).toBe("pending");
    const after2 = await mgr.approve(r.id, "carol" as UserId);
    expect(after2.status).toBe("approved");
    expect(after2.approvals).toHaveLength(2);
  });

  it("rejects self-approval", async () => {
    const mgr = new ApprovalManager({ store: new InMemoryApprovalStore() });
    const r = await mgr.create({
      sessionId: "s1" as SessionId,
      initiator: "alice" as UserId,
      walletProvider: "hashkey" as WalletProviderId,
      recipient: "0xabc",
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      reason: "x",
      requiredApprovals: 1,
      approverPool: ["alice" as UserId, "bob" as UserId],
    });
    await expect(
      (async () => mgr.approve(r.id, "alice" as UserId))()
    ).rejects.toThrow(/self-approval/);
  });

  it("rejects approver outside pool", async () => {
    const mgr = new ApprovalManager({ store: new InMemoryApprovalStore() });
    const r = await mgr.create({
      sessionId: "s1" as SessionId,
      initiator: "alice" as UserId,
      walletProvider: "hashkey" as WalletProviderId,
      recipient: "0xabc",
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      reason: "x",
      requiredApprovals: 1,
      approverPool: ["bob" as UserId],
    });
    await expect(
      (async () => mgr.approve(r.id, "eve" as UserId))()
    ).rejects.toThrow(/not in pool/);
  });

  it("idempotent: same approver approving twice doesn't double-count", async () => {
    const mgr = new ApprovalManager({ store: new InMemoryApprovalStore() });
    const r = await mgr.create({
      sessionId: "s1" as SessionId,
      initiator: "alice" as UserId,
      walletProvider: "hashkey" as WalletProviderId,
      recipient: "0xabc",
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      reason: "x",
      requiredApprovals: 2,
      approverPool: ["bob" as UserId, "carol" as UserId],
    });
    await mgr.approve(r.id, "bob" as UserId);
    const after = await mgr.approve(r.id, "bob" as UserId);
    expect(after.status).toBe("pending"); // bob counted once
  });

  it("reject flips status to rejected", async () => {
    const mgr = new ApprovalManager({ store: new InMemoryApprovalStore() });
    const r = await mgr.create({
      sessionId: "s1" as SessionId,
      initiator: "alice" as UserId,
      walletProvider: "hashkey" as WalletProviderId,
      recipient: "0xabc",
      amount: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      reason: "x",
      requiredApprovals: 1,
      approverPool: ["bob" as UserId],
    });
    const after = await mgr.reject(r.id, "bob" as UserId, "looks fishy");
    expect(after.status).toBe("rejected");
  });

  it("sweepExpired flips stale pending requests", async () => {
    const store = new InMemoryApprovalStore();
    const mgr = new ApprovalManager({ store, defaultExpiryMinutes: -1, now: () => Date.now() - 5 * 60_000 });
    await mgr.create({
      sessionId: "s1" as SessionId,
      initiator: "alice" as UserId,
      walletProvider: "hashkey" as WalletProviderId,
      recipient: "0xabc",
      amount: { amountAtomic: "1", decimals: 6, currency: "USDC" },
      reason: "x",
      requiredApprovals: 1,
      approverPool: ["bob" as UserId],
    });
    const sweeper = new ApprovalManager({ store });
    const n = await sweeper.sweepExpired();
    expect(n).toBe(1);
  });
});

// ============================================================================
//  PerAgentPolicyEngine
// ============================================================================

describe("PerAgentPolicyEngine", () => {
  it("dispatches to the right bundle by agentId", () => {
    const eng = new PerAgentPolicyEngine({
      bundles: [
        {
          agentId: "research-bot",
          policies: [amountThreshold({ maxAtomic: "5000000" })], // $5
        },
        {
          agentId: "trading-bot",
          policies: [amountThreshold({ maxAtomic: "5000000000" })], // $5000
        },
      ],
    });

    // research-bot @ $10 → blocked
    const ctx1 = {
      userId: "alice" as UserId,
      walletProvider: "hashkey" as WalletProviderId,
      session: buildSession({ agentId: "research-bot" }),
      request: buildRequest({
        amount: { amountAtomic: "10000000", decimals: 6, currency: "USDC" },
      }),
      recentPayments: [],
      now: Date.now(),
    };
    const r1 = eng.evaluate(ctx1);
    expect(r1.allowed).toBe(false);

    // trading-bot @ $10 → allowed
    const ctx2 = {
      ...ctx1,
      session: buildSession({ agentId: "trading-bot" }),
    };
    const r2 = eng.evaluate(ctx2);
    expect(r2.allowed).toBe(true);
  });

  it("falls back to default policies when agentId unknown", () => {
    const eng = new PerAgentPolicyEngine({
      bundles: [],
      defaultPolicies: [amountThreshold({ maxAtomic: "1000" })],
    });
    const ctx = {
      userId: "alice" as UserId,
      walletProvider: "hashkey" as WalletProviderId,
      session: buildSession({ agentId: "unknown-agent" }),
      request: buildRequest({
        amount: { amountAtomic: "10000", decimals: 6, currency: "USDC" },
      }),
      recentPayments: [],
      now: Date.now(),
    };
    const r = eng.evaluate(ctx);
    expect(r.allowed).toBe(false);
  });
});

// ============================================================================
//  jurisdictionRestriction
// ============================================================================

describe("jurisdictionRestriction", () => {
  it("blocks initiator country in blocklist", () => {
    const policy = jurisdictionRestriction({ blockedCountries: ["IR", "KP"] });
    const ctx = {
      userId: "alice" as UserId,
      walletProvider: "x" as WalletProviderId,
      session: buildSession({ country: "IR" }),
      request: buildRequest(),
      recentPayments: [],
      now: Date.now(),
    };
    const r = policy(ctx);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/IR/);
  });

  it("blocks recipient country if extractor returns it", () => {
    const policy = jurisdictionRestriction({
      blockedCountries: ["RU"],
      recipientCountry: () => "RU",
    });
    const ctx = {
      userId: "alice" as UserId,
      walletProvider: "x" as WalletProviderId,
      session: buildSession({ country: "US" }),
      request: buildRequest(),
      recentPayments: [],
      now: Date.now(),
    };
    const r = policy(ctx);
    expect(r.allowed).toBe(false);
  });

  it("denies when both unknown and onUnknown=deny (default)", () => {
    const policy = jurisdictionRestriction({ blockedCountries: ["KP"] });
    const ctx = {
      userId: "alice" as UserId,
      walletProvider: "x" as WalletProviderId,
      session: buildSession(),
      request: buildRequest(),
      recentPayments: [],
      now: Date.now(),
    };
    const r = policy(ctx);
    expect(r.allowed).toBe(false);
  });

  it("allows when onUnknown=allow", () => {
    const policy = jurisdictionRestriction({
      blockedCountries: ["KP"],
      onUnknown: "allow",
    });
    const ctx = {
      userId: "alice" as UserId,
      walletProvider: "x" as WalletProviderId,
      session: buildSession(),
      request: buildRequest(),
      recentPayments: [],
      now: Date.now(),
    };
    const r = policy(ctx);
    expect(r.allowed).toBe(true);
  });
});

// ============================================================================
//  ChainalysisKYTChecker — mocked fetch
// ============================================================================

describe("ChainalysisKYTChecker", () => {
  it("clears low-risk addresses", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => [{ riskLevel: "Low" }],
    })) as unknown as typeof fetch;
    const checker = new ChainalysisKYTChecker({ apiKey: "test", fetchFn: fakeFetch });
    const r = await checker.check("0xabc");
    expect(r.cleared).toBe(true);
  });

  it("blocks high-risk addresses", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => [{ riskLevel: "High", riskReasons: [{ category: "darknet" }] }],
    })) as unknown as typeof fetch;
    const checker = new ChainalysisKYTChecker({ apiKey: "test", fetchFn: fakeFetch });
    const r = await checker.check("0xabc");
    expect(r.cleared).toBe(false);
    expect(r.matches[0]?.source).toBe("chainalysis-kyt");
  });

  it("fail-closed by default on HTTP error", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const checker = new ChainalysisKYTChecker({ apiKey: "test", fetchFn: fakeFetch });
    const r = await checker.check("0xabc");
    expect(r.cleared).toBe(false);
  });

  it("fail-open when explicitly configured", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const checker = new ChainalysisKYTChecker({
      apiKey: "test",
      fetchFn: fakeFetch,
      failClosed: false,
    });
    const r = await checker.check("0xabc");
    expect(r.cleared).toBe(true);
  });
});

// ============================================================================
//  TRMLabsChecker
// ============================================================================

describe("TRMLabsChecker", () => {
  it("blocks at-or-above threshold", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => [{ addressRiskScore: 8 }],
    })) as unknown as typeof fetch;
    const checker = new TRMLabsChecker({
      apiKey: "test",
      fetchFn: fakeFetch,
      blockAtOrAbove: 7,
    });
    const r = await checker.check("0xabc");
    expect(r.cleared).toBe(false);
  });

  it("allows below threshold", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => [{ addressRiskScore: 3 }],
    })) as unknown as typeof fetch;
    const checker = new TRMLabsChecker({
      apiKey: "test",
      fetchFn: fakeFetch,
      blockAtOrAbove: 7,
    });
    const r = await checker.check("0xabc");
    expect(r.cleared).toBe(true);
  });
});

// ============================================================================
//  OFACSdnAutoSyncChecker
// ============================================================================

describe("OFACSdnAutoSyncChecker", () => {
  it("loads seed list immediately and blocks matches", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => "[]",
    })) as unknown as typeof fetch;
    const checker = new OFACSdnAutoSyncChecker({
      feedUrl: "https://example.com/sdn.txt",
      seed: ["0xBADADDRESS"],
      fetchFn: fakeFetch,
    });
    // OFAC checker normalizes both seed and lookups to lowercase
    const r = await checker.check("0xbadaddress");
    expect(r.cleared).toBe(false);
  });

  it("refreshes on stale and uses fresh data", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        text: async () => `["0xfeedbeef", "0xnewsanctioned"]`,
      };
    }) as unknown as typeof fetch;
    const checker = new OFACSdnAutoSyncChecker({
      feedUrl: "https://example.com/sdn.json",
      refreshIntervalMs: 0, // forces stale → refresh on every check
      fetchFn: fakeFetch,
    });
    await checker.refresh();
    expect(calls).toBe(1);
    expect(checker.size()).toBe(2);
    const r = await checker.check("0xnewsanctioned");
    expect(r.cleared).toBe(false);
  });

  it("clears unsanctioned addresses", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => `["0xbad"]`,
    })) as unknown as typeof fetch;
    const checker = new OFACSdnAutoSyncChecker({
      feedUrl: "https://example.com/sdn.json",
      fetchFn: fakeFetch,
    });
    await checker.refresh();
    const r = await checker.check("0xgood");
    expect(r.cleared).toBe(true);
  });

  it("parses plain-text line-separated feed", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => `# OFAC SDN feed\n0xaaa\n0xbbb\n# comment\n\n0xccc\n`,
    })) as unknown as typeof fetch;
    const checker = new OFACSdnAutoSyncChecker({
      feedUrl: "https://example.com/sdn.txt",
      fetchFn: fakeFetch,
    });
    await checker.refresh();
    expect(checker.size()).toBe(3);
  });
});
