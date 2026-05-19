/**
 * Governance — Policy + Compliance + Audit unit tests
 *
 * Tests the 7-layer Guardrail Layer 3, 5, 7 implementations.
 */
import { describe, expect, it } from "vitest";
import type {
  Money,
  PaymentRequest,
  Session,
  UserId,
  WalletProviderId,
} from "@openagentpay/core";

import {
  InMemoryPolicyEngine,
  velocityLimit,
  amountThreshold,
  merchantWhitelist,
  merchantBlacklist,
  walletProviderWhitelist,
  timeOfDay,
  StaticSanctionsChecker,
  DEMO_SANCTIONS_LIST,
  CompositeComplianceChecker,
  InMemoryAuditSink,
  AuditLogger,
  GovernanceManager,
  type RecentPaymentRecord,
} from "../src/index.js";

// ============================================================================
//  Test fixtures
// ============================================================================

const USER: UserId = "test-user" as UserId;
const PROVIDER: WalletProviderId = "hashkey-chain" as WalletProviderId;

function mkAmount(usdc: number): Money {
  return {
    amountAtomic: BigInt(Math.round(usdc * 1e6)).toString(),
    decimals: 6,
    currency: "USDC",
  };
}

function mkRequest(opts: {
  recipient?: string;
  usdc?: number;
} = {}): PaymentRequest {
  return {
    protocol: "x402-v1" as any,
    amount: mkAmount(opts.usdc ?? 1),
    recipient: opts.recipient ?? "0x1234567890123456789012345678901234567890",
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 600,
    nonce: "0x" + "00".repeat(32),
    rawPayload: {},
  };
}

function mkSession(): Session {
  return {
    id: "test-session" as any,
    userId: USER,
    budget: mkAmount(100),
    spent: mkAmount(0),
    status: "active" as any,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  } as Session;
}

function mkRecent(usdc: number, ageMs: number): RecentPaymentRecord {
  return {
    timestamp: Date.now() - ageMs,
    amount: mkAmount(usdc),
    recipient: "0x" + "ab".repeat(20),
    walletProvider: PROVIDER,
    success: true,
  };
}

// ============================================================================
//  Policy tests
// ============================================================================

describe("PolicyEngine — velocityLimit", () => {
  it("allows when count and amount under cap", () => {
    const engine = new InMemoryPolicyEngine();
    engine.use(velocityLimit({ windowMs: 60_000, maxCount: 5 }));
    const r = engine.evaluate({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest(),
      session: mkSession(),
      recentPayments: [mkRecent(1, 1000), mkRecent(1, 2000)],
      now: Date.now(),
    });
    expect(r.allowed).toBe(true);
  });

  it("denies when count exceeds maxCount", () => {
    const engine = new InMemoryPolicyEngine();
    engine.use(velocityLimit({ windowMs: 60_000, maxCount: 2 }));
    const r = engine.evaluate({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest(),
      session: mkSession(),
      recentPayments: [mkRecent(1, 1000), mkRecent(1, 2000)],
      now: Date.now(),
    });
    expect(r.allowed).toBe(false);
    expect(r.denyReason).toMatch(/exceeds maxCount=2/);
  });

  it("denies when total atomic spend exceeds cap", () => {
    const engine = new InMemoryPolicyEngine();
    engine.use(
      velocityLimit({
        windowMs: 60_000,
        maxAmountAtomic: BigInt(2 * 1e6).toString(), // $2 cap
      })
    );
    const r = engine.evaluate({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest({ usdc: 1.5 }),
      session: mkSession(),
      recentPayments: [mkRecent(1, 1000)], // already spent $1, +$1.5 = $2.5 > $2
      now: Date.now(),
    });
    expect(r.allowed).toBe(false);
    expect(r.denyReason).toMatch(/exceed cap/);
  });

  it("ignores payments outside window", () => {
    const engine = new InMemoryPolicyEngine();
    engine.use(velocityLimit({ windowMs: 5_000, maxCount: 1 }));
    const r = engine.evaluate({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest(),
      session: mkSession(),
      recentPayments: [mkRecent(1, 60_000)], // 60s ago, outside 5s window
      now: Date.now(),
    });
    expect(r.allowed).toBe(true);
  });
});

describe("PolicyEngine — amountThreshold", () => {
  it("allows under threshold", () => {
    const engine = new InMemoryPolicyEngine();
    engine.use(amountThreshold({ maxAtomic: "10000000" })); // $10
    const r = engine.evaluate({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest({ usdc: 5 }),
      session: mkSession(),
      recentPayments: [],
      now: Date.now(),
    });
    expect(r.allowed).toBe(true);
  });

  it("denies above threshold", () => {
    const engine = new InMemoryPolicyEngine();
    engine.use(amountThreshold({ maxAtomic: "10000000" })); // $10
    const r = engine.evaluate({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest({ usdc: 15 }),
      session: mkSession(),
      recentPayments: [],
      now: Date.now(),
    });
    expect(r.allowed).toBe(false);
  });
});

describe("PolicyEngine — merchant lists", () => {
  it("whitelist allows known", () => {
    const engine = new InMemoryPolicyEngine();
    engine.use(merchantWhitelist(["0xABCDEF"]));
    const r = engine.evaluate({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest({ recipient: "0xabcdef" }), // case insensitive
      session: mkSession(),
      recentPayments: [],
      now: Date.now(),
    });
    expect(r.allowed).toBe(true);
  });

  it("whitelist denies unknown", () => {
    const engine = new InMemoryPolicyEngine();
    engine.use(merchantWhitelist(["0xABCDEF"]));
    const r = engine.evaluate({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest({ recipient: "0x1234" }),
      session: mkSession(),
      recentPayments: [],
      now: Date.now(),
    });
    expect(r.allowed).toBe(false);
  });

  it("blacklist denies known-bad", () => {
    const engine = new InMemoryPolicyEngine();
    engine.use(merchantBlacklist(["0xBADBADBAD"]));
    const r = engine.evaluate({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest({ recipient: "0xBADBADBAD" }),
      session: mkSession(),
      recentPayments: [],
      now: Date.now(),
    });
    expect(r.allowed).toBe(false);
  });
});

describe("PolicyEngine — walletProviderWhitelist", () => {
  it("allows whitelisted provider", () => {
    const engine = new InMemoryPolicyEngine();
    engine.use(walletProviderWhitelist(["hashkey-chain" as WalletProviderId]));
    const r = engine.evaluate({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest(),
      session: mkSession(),
      recentPayments: [],
      now: Date.now(),
    });
    expect(r.allowed).toBe(true);
  });

  it("denies non-whitelisted provider", () => {
    const engine = new InMemoryPolicyEngine();
    engine.use(walletProviderWhitelist(["coinbase-cdp" as WalletProviderId]));
    const r = engine.evaluate({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest(),
      session: mkSession(),
      recentPayments: [],
      now: Date.now(),
    });
    expect(r.allowed).toBe(false);
  });
});

describe("PolicyEngine — first deny wins", () => {
  it("returns first failing policy", () => {
    const engine = new InMemoryPolicyEngine();
    engine.use(amountThreshold({ maxAtomic: "1000000000" })); // $1000 - passes
    engine.use(merchantBlacklist(["0xBAD"])); // denies
    engine.use(amountThreshold({ maxAtomic: "1" })); // would deny (but never reached)
    const r = engine.evaluate({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest({ recipient: "0xBAD", usdc: 5 }),
      session: mkSession(),
      recentPayments: [],
      now: Date.now(),
    });
    expect(r.allowed).toBe(false);
    expect(r.denyPolicyName).toMatch(/[bB]lacklist/);
    expect(r.evaluations.length).toBe(2); // 1 pass + 1 deny, third never evaluated
  });
});

// ============================================================================
//  Compliance tests
// ============================================================================

describe("StaticSanctionsChecker", () => {
  it("clears unknown addresses", async () => {
    const checker = new StaticSanctionsChecker([DEMO_SANCTIONS_LIST]);
    const r = await checker.check("0x1234567890123456789012345678901234567890");
    expect(r.cleared).toBe(true);
    expect(r.matches.length).toBe(0);
  });

  it("flags sanctioned addresses (case insensitive)", async () => {
    const checker = new StaticSanctionsChecker([DEMO_SANCTIONS_LIST]);
    const r = await checker.check(
      "0x8589427373D6D84E98730D7795D8F6F8731FDA16" // upper-case
    );
    expect(r.cleared).toBe(false);
    expect(r.matches.length).toBeGreaterThan(0);
  });

  it("supports adding multiple lists", async () => {
    const checker = new StaticSanctionsChecker();
    checker.addList({
      addresses: ["0xAAA"],
      source: "list-a",
      lastUpdated: new Date().toISOString(),
    });
    checker.addList({
      addresses: ["0xBBB"],
      source: "list-b",
      lastUpdated: new Date().toISOString(),
    });
    expect((await checker.check("0xaaa")).cleared).toBe(false);
    expect((await checker.check("0xbbb")).cleared).toBe(false);
    expect((await checker.check("0xCCC")).cleared).toBe(true);
  });
});

describe("CompositeComplianceChecker", () => {
  it("fails closed: any failure denies", async () => {
    const ok = new StaticSanctionsChecker(); // empty
    const bad = new StaticSanctionsChecker([
      {
        addresses: ["0xDEAD"],
        source: "test",
        lastUpdated: new Date().toISOString(),
      },
    ]);
    const composite = new CompositeComplianceChecker([ok, bad]);
    const r = await composite.check("0xDEAD");
    expect(r.cleared).toBe(false);
  });
});

// ============================================================================
//  Audit tests
// ============================================================================

describe("AuditLogger + InMemoryAuditSink", () => {
  it("records emitted events", async () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger(sink);
    await logger.emit({
      kind: "payment_attempt",
      actor: USER,
      result: "allowed",
    });
    expect(sink.size()).toBe(1);
    const event = sink.readAll()[0]!;
    expect(event.kind).toBe("payment_attempt");
    expect(event.eventId).toMatch(/^audit-/);
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("query filters by kind", async () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger(sink);
    await logger.emit({ kind: "policy_check", actor: USER, result: "allowed" });
    await logger.emit({
      kind: "payment_success",
      actor: USER,
      result: "succeeded",
    });
    expect(sink.query({ kind: "payment_success" }).length).toBe(1);
    expect(sink.query({ result: "succeeded" }).length).toBe(1);
  });

  it("respects capacity (FIFO)", async () => {
    const sink = new InMemoryAuditSink(3);
    const logger = new AuditLogger(sink);
    for (let i = 0; i < 5; i++) {
      await logger.emit({
        kind: "policy_check",
        actor: USER,
        result: "allowed",
      });
    }
    expect(sink.size()).toBe(3);
  });
});

// ============================================================================
//  GovernanceManager (end-to-end facade)
// ============================================================================

describe("GovernanceManager", () => {
  it("preCheck allows + records audit when all policies pass", async () => {
    const sink = new InMemoryAuditSink();
    const engine = new InMemoryPolicyEngine();
    engine.use(amountThreshold({ maxAtomic: "10000000" }));

    const gov = new GovernanceManager({
      policyEngine: engine,
      auditSink: sink,
    });

    const r = await gov.preCheck({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest({ usdc: 5 }),
      session: mkSession(),
    });
    expect(r.allowed).toBe(true);

    const events = sink.readAll();
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("policy_check");
    expect(events[0]!.result).toBe("allowed");
  });

  it("preCheck denies + records audit when policy fails", async () => {
    const sink = new InMemoryAuditSink();
    const engine = new InMemoryPolicyEngine();
    engine.use(amountThreshold({ maxAtomic: "1000000" })); // $1 cap

    const gov = new GovernanceManager({
      policyEngine: engine,
      auditSink: sink,
    });

    const r = await gov.preCheck({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest({ usdc: 5 }), // exceeds $1
      session: mkSession(),
    });
    expect(r.allowed).toBe(false);
    expect(r.denyPolicyName).toMatch(/amountThreshold/);

    const events = sink.readAll();
    expect(events[0]!.result).toBe("denied");
  });

  it("preCheck denies on sanctions match", async () => {
    const sink = new InMemoryAuditSink();
    const engine = new InMemoryPolicyEngine();
    const checker = new StaticSanctionsChecker([DEMO_SANCTIONS_LIST]);

    const gov = new GovernanceManager({
      policyEngine: engine,
      complianceChecker: checker,
      auditSink: sink,
    });

    const r = await gov.preCheck({
      userId: USER,
      walletProvider: PROVIDER,
      request: mkRequest({
        recipient: "0x8589427373d6d84e98730d7795d8f6f8731fda16", // sanctioned
      }),
      session: mkSession(),
    });
    expect(r.allowed).toBe(false);
    expect(r.complianceMatches?.length).toBeGreaterThan(0);

    const events = sink.readAll();
    expect(events.find((e) => e.kind === "compliance_check")?.result).toBe(
      "denied"
    );
  });

  it("recordSuccess and recordFailure produce audit events", async () => {
    const sink = new InMemoryAuditSink();
    const gov = new GovernanceManager({
      policyEngine: new InMemoryPolicyEngine(),
      auditSink: sink,
    });

    await gov.recordSuccess({
      userId: USER,
      walletProvider: PROVIDER,
      sessionId: "s1",
      recipient: "0xabc",
      amountAtomic: "1000000",
      currency: "USDC",
      chain: "base-sepolia",
      txHash: "0xdead",
    });
    await gov.recordFailure({
      userId: USER,
      walletProvider: PROVIDER,
      sessionId: "s2",
      recipient: "0xdef",
      amountAtomic: "2000000",
      currency: "USDC",
      chain: "hashkey-testnet",
      errorCode: "rpc_error",
      errorMessage: "test failure",
    });

    expect(sink.query({ kind: "payment_success" }).length).toBe(1);
    expect(sink.query({ kind: "payment_failure" }).length).toBe(1);
  });
});
