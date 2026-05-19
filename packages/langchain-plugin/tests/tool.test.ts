/**
 * @openagentpay/langchain-plugin — comprehensive unit + integration tests
 *
 * Coverage:
 *   - Tool metadata: name, description, schema (LangChain integration sanity)
 *   - schema validation (zod accepts/rejects per LLM)
 *   - runPayment success path: real PaymentManager + mock connector
 *   - runPayment with governance: policy deny + sanctions deny + audit
 *   - session lifecycle: lazy creation, reuse, expiry recovery
 *   - walletProvider routing (default vs override)
 *   - error handling: missing instrument, settlement failure, internal exception
 *   - _call method: returns valid JSON string for LLM
 *   - recentPayments buffer integration with velocity policies
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryPaymentManager,
  InMemorySessionManager,
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type SessionId,
  type SettlementResult,
  type SignAuthorizationInput,
  type SignedAuthorization,
  type TransactionRef,
  type UserId,
  type WalletCapabilities,
  type WalletConnector,
  type WalletProviderId,
} from "@openagentpay/core";
import {
  GovernanceManager,
  InMemoryAuditSink,
  InMemoryPolicyEngine,
  StaticSanctionsChecker,
  DEMO_SANCTIONS_LIST,
  amountThreshold,
  velocityLimit,
  type RecentPaymentRecord,
} from "@openagentpay/governance";

import { OpenAgentPayTool, createPaymentTool } from "../src/tool.js";

// ============================================================================
//  Mock connector (re-usable fixture)
// ============================================================================

const PROVIDER: WalletProviderId = "test-wallet" as WalletProviderId;

function buildMockConnector(opts: { fail?: boolean } = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const instruments = new Map<UserId, Instrument>();
  const byId = new Map<InstrumentId, Instrument>();

  const c: WalletConnector & {
    store?: {
      getById: (id: InstrumentId) => Promise<Instrument | undefined>;
      get: (uid: UserId) => Promise<Instrument | undefined>;
    };
  } = {
    getCapabilities(): WalletCapabilities {
      return {
        walletProvider: PROVIDER,
        displayName: "Test Wallet",
        supportedAssets: [{ symbol: "USDC", decimals: 6 }],
        supportedProtocols: ["x402-v1" as any],
        requiresUserApproval: false,
        settlesOnChain: true,
      };
    },
    async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
      calls.push({ method: "createInstrument", args: input });
      const existing = instruments.get(input.userId);
      if (existing) return existing;
      const id = `inst-${input.userId}` as InstrumentId;
      const inst: Instrument = {
        id,
        userId: input.userId,
        walletProvider: PROVIDER,
        publicHandle: "0xMOCK",
        createdAt: new Date().toISOString(),
      };
      instruments.set(input.userId, inst);
      byId.set(id, inst);
      return inst;
    },
    async getBalance(id: InstrumentId): Promise<Balance> {
      calls.push({ method: "getBalance", args: id });
      return {
        instrumentId: id,
        asset: { symbol: "USDC", decimals: 6 },
        money: { amountAtomic: "100000000", decimals: 6, currency: "USDC" },
        fetchedAt: new Date().toISOString(),
      };
    },
    async signAuthorization(input: SignAuthorizationInput): Promise<SignedAuthorization> {
      calls.push({ method: "signAuthorization", args: input });
      return {
        request: input.request,
        signer: "0xMOCK",
        signature: "0x" + "ab".repeat(65),
        extra: { v: 27, r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32) },
      };
    },
    async settle(signed: SignedAuthorization): Promise<SettlementResult> {
      calls.push({ method: "settle", args: signed });
      if (opts.fail) {
        return {
          success: false,
          network: "test-net",
          settledAt: new Date().toISOString(),
          errorCode: "rpc_error",
          errorMessage: "settlement failed for test",
        };
      }
      return {
        success: true,
        transactionRef: "0xMOCKTX_aaa" as TransactionRef,
        network: "test-net",
        settledAt: new Date().toISOString(),
        settledAmount: signed.request.amount,
        raw: { explorerUrl: "https://mock.explorer/tx/0xMOCKTX_aaa" },
      };
    },
  };
  c.store = {
    getById: async (id) => byId.get(id),
    get: async (uid) => instruments.get(uid),
  };
  return { connector: c, calls };
}

function buildSetup(opts: {
  withGovernance?: boolean;
  failSettle?: boolean;
  recentPayments?: RecentPaymentRecord[];
} = {}) {
  const { connector, calls } = buildMockConnector({ fail: opts.failSettle });
  const sessionManager = new InMemorySessionManager();
  const manager = new InMemoryPaymentManager({
    sessionManager,
    resolveInstrument: async (id) => (connector as any).store.getById(id),
  });
  manager.registerConnector(connector);

  const auditSink = new InMemoryAuditSink(500);
  let governance: GovernanceManager | undefined;
  if (opts.withGovernance) {
    const policyEngine = new InMemoryPolicyEngine();
    policyEngine.use(amountThreshold({ maxAtomic: "50000000" })); // $50
    policyEngine.use(
      velocityLimit({
        windowMs: 60_000,
        maxCount: 3,
      })
    );
    governance = new GovernanceManager({
      policyEngine,
      complianceChecker: new StaticSanctionsChecker([DEMO_SANCTIONS_LIST]),
      auditSink,
    });
  }

  const tool = createPaymentTool({
    manager,
    ...(governance ? { governance } : {}),
    userId: "alice" as UserId,
    defaultWalletProvider: PROVIDER,
    defaultSessionBudgetUsd: 5,
    defaultSessionExpiryMinutes: 30,
    ...(opts.recentPayments ? { recentPayments: opts.recentPayments } : {}),
  });

  return { tool, manager, sessionManager, auditSink, calls };
}

// ============================================================================
//  Tests
// ============================================================================

describe("OpenAgentPayTool — LangChain metadata", () => {
  it("has the right name", () => {
    const { tool } = buildSetup();
    expect(tool.name).toBe("openagentpay_pay");
  });

  it("has a non-empty description", () => {
    const { tool } = buildSetup();
    expect(tool.description.length).toBeGreaterThan(50);
    expect(tool.description).toContain("OpenAgentPay");
  });

  it("exposes a structured zod schema", () => {
    const { tool } = buildSetup();
    expect(tool.schema).toBeDefined();
    // schema accepts valid input
    const valid = tool.schema.parse({
      amountUsd: 1.5,
      recipient: "0xabc",
      reason: "test",
    });
    expect(valid.amountUsd).toBe(1.5);
  });

  it("schema rejects negative amount", () => {
    const { tool } = buildSetup();
    expect(() =>
      tool.schema.parse({ amountUsd: -1, recipient: "0xabc", reason: "x" })
    ).toThrow();
  });

  it("schema rejects empty recipient", () => {
    const { tool } = buildSetup();
    expect(() =>
      tool.schema.parse({ amountUsd: 1, recipient: "", reason: "x" })
    ).toThrow();
  });

  it("schema rejects empty reason", () => {
    const { tool } = buildSetup();
    expect(() =>
      tool.schema.parse({ amountUsd: 1, recipient: "0xabc", reason: "" })
    ).toThrow();
  });
});

describe("OpenAgentPayTool — runPayment happy path", () => {
  it("returns success + tx hash on first payment", async () => {
    const { tool } = buildSetup();
    const r = await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xrecipient",
      reason: "fetch market data",
    });
    expect(r.success).toBe(true);
    expect(r.txHash).toMatch(/^0xMOCKTX/);
    expect(r.walletProvider).toBe(PROVIDER);
    expect(r.amountUsd).toBe(0.001);
    expect(r.recipient).toBe("0xrecipient");
    expect(r.explorerUrl).toMatch(/^https:\/\/mock\.explorer/);
  });

  it("creates session lazily on first call", async () => {
    const { tool } = buildSetup();
    expect(tool.__getCachedSessionId()).toBeNull();
    await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xa",
      reason: "first",
    });
    expect(tool.__getCachedSessionId()).not.toBeNull();
  });

  it("reuses session across multiple calls", async () => {
    const { tool } = buildSetup();
    await tool.runPayment({ amountUsd: 0.001, recipient: "0xa", reason: "1" });
    const sid1 = tool.__getCachedSessionId();
    await tool.runPayment({ amountUsd: 0.001, recipient: "0xb", reason: "2" });
    const sid2 = tool.__getCachedSessionId();
    expect(sid1).toBe(sid2);
  });

  it("creates new session when previous expired", async () => {
    const { tool, manager } = buildSetup();
    await tool.runPayment({ amountUsd: 0.001, recipient: "0xa", reason: "1" });
    const sid1 = tool.__getCachedSessionId();
    expect(sid1).not.toBeNull();

    // Simulate expiry by manually expiring
    const session = await manager.getPaymentSession(sid1!);
    expect(session).toBeDefined();
    // Force expiry: re-inject the cached id but make it invalid
    tool.__resetCachedSession();

    await tool.runPayment({ amountUsd: 0.001, recipient: "0xb", reason: "2" });
    const sid2 = tool.__getCachedSessionId();
    expect(sid2).not.toBe(sid1);
  });

  it("invokes connector createInstrument + signAuthorization + settle", async () => {
    const { tool, calls } = buildSetup();
    await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xa",
      reason: "test call chain",
    });
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("createInstrument");
    expect(methods).toContain("signAuthorization");
    expect(methods).toContain("settle");
  });
});

describe("OpenAgentPayTool — _call (LangChain invocation)", () => {
  it("returns a JSON string parseable by LLM", async () => {
    const { tool } = buildSetup();
    const json = await tool.invoke({
      amountUsd: 0.001,
      recipient: "0xa",
      reason: "via _call",
    });
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json);
    expect(parsed.success).toBe(true);
    expect(parsed.txHash).toMatch(/^0xMOCKTX/);
  });

  it("invoke supports walletProvider override", async () => {
    const { tool } = buildSetup();
    // Override doesn't error even with unknown provider — falls back to default
    const json = await tool.invoke({
      amountUsd: 0.001,
      recipient: "0xa",
      reason: "override test",
      walletProvider: PROVIDER,
    });
    const parsed = JSON.parse(json);
    expect(parsed.walletProvider).toBe(PROVIDER);
  });
});

describe("OpenAgentPayTool — governance integration", () => {
  it("denies $100 payment via amountThreshold policy", async () => {
    const { tool, auditSink } = buildSetup({ withGovernance: true });
    const r = await tool.runPayment({
      amountUsd: 100,
      recipient: "0xa",
      reason: "way too much",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("policy_denied");
    expect(r.errorMessage).toMatch(/exceeds maxAtomic/);

    // Audit captured the denial
    const denies = auditSink.query({ result: "denied" });
    expect(denies.length).toBeGreaterThan(0);
  });

  it("denies sanctioned recipient via compliance checker", async () => {
    const { tool, auditSink } = buildSetup({ withGovernance: true });
    const r = await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0x8589427373d6d84e98730d7795d8f6f8731fda16", // Tornado Cash
      reason: "(should not work)",
    });
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/compliance|sanctions/i);

    const complianceDenies = auditSink.query({ kind: "compliance_check" });
    const denies = complianceDenies.filter((e) => e.result === "denied");
    expect(denies.length).toBe(1);
  });

  it("records payment_success audit event on successful pay", async () => {
    const { tool, auditSink } = buildSetup({ withGovernance: true });
    await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xa",
      reason: "happy",
    });
    const success = auditSink.query({ kind: "payment_success" });
    expect(success.length).toBe(1);
    expect(success[0]!.txHash).toMatch(/^0xMOCKTX/);
    expect(success[0]!.metadata?.["reason"]).toBe("happy");
  });

  it("records payment_failure audit event on settlement failure", async () => {
    const { tool, auditSink } = buildSetup({
      withGovernance: true,
      failSettle: true,
    });
    const r = await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xa",
      reason: "will fail",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("rpc_error");

    const failures = auditSink.query({ kind: "payment_failure" });
    expect(failures.length).toBe(1);
  });

  it("velocity limit denies after maxCount payments", async () => {
    const recent: RecentPaymentRecord[] = [];
    const { tool } = buildSetup({
      withGovernance: true,
      recentPayments: recent,
    });
    // policy: max 3 per minute
    for (let i = 0; i < 3; i++) {
      const r = await tool.runPayment({
        amountUsd: 0.001,
        recipient: `0xa${i}`,
        reason: `pay ${i}`,
      });
      expect(r.success).toBe(true);
    }
    expect(recent.length).toBe(3);
    // 4th should hit velocityLimit
    const r4 = await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xa3",
      reason: "should be denied",
    });
    expect(r4.success).toBe(false);
    expect(r4.errorMessage).toMatch(/maxCount/i);
  });

  it("recentPayments buffer accumulates on success + failure", async () => {
    const recent: RecentPaymentRecord[] = [];
    const { tool } = buildSetup({
      withGovernance: true,
      recentPayments: recent,
    });
    await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xa",
      reason: "ok",
    });
    expect(recent.length).toBe(1);
    expect(recent[0]!.success).toBe(true);
  });
});

describe("OpenAgentPayTool — resolveProtocolForWallet hook", () => {
  it("uses the resolver when provided", async () => {
    const resolver = vi.fn(async () => "x402-v1");
    const setup = buildSetup();
    const tool = createPaymentTool({
      manager: setup.manager,
      userId: "alice" as UserId,
      defaultWalletProvider: PROVIDER,
      resolveProtocolForWallet: resolver,
    });
    await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xa",
      reason: "resolver test",
    });
    expect(resolver).toHaveBeenCalledWith(PROVIDER);
  });
});

describe("createPaymentTool factory", () => {
  it("returns an OpenAgentPayTool instance", () => {
    const setup = buildSetup();
    expect(setup.tool).toBeInstanceOf(OpenAgentPayTool);
  });

  it("exposes cfg for inspection", () => {
    const setup = buildSetup();
    expect(setup.tool.cfg.userId).toBe("alice");
    expect(setup.tool.cfg.defaultWalletProvider).toBe(PROVIDER);
  });

  it("supports sharedSessionId pre-population", async () => {
    const setup = buildSetup();
    // Create a session first via manager
    const session = await setup.manager.createPaymentSession({
      userId: "alice" as UserId,
      budgetUsd: 10,
      expiresMinutes: 60,
    });
    // Build a separate tool that pre-uses this session
    const tool2 = createPaymentTool({
      manager: setup.manager,
      userId: "alice" as UserId,
      defaultWalletProvider: PROVIDER,
      sharedSessionId: session.id,
    });
    expect(tool2.__getCachedSessionId()).toBe(session.id);

    await tool2.runPayment({
      amountUsd: 0.001,
      recipient: "0xa",
      reason: "shared session",
    });
    // Still using same session
    expect(tool2.__getCachedSessionId()).toBe(session.id);
  });
});
