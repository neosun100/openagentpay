/**
 * Tests for @openagentpay/llamaindex-plugin.
 *
 * Coverage:
 *   - factory creates tool with right name + description + JSON schema
 *   - call(input) returns JSON string
 *   - runPayment happy path → success + tx hash
 *   - runPayment + governance allow-deny path
 *   - runPayment session lazy creation + reuse
 *   - runPayment passes mandates through to PaymentRequest
 *   - runPayment recognizes settlement-failure → returns errorCode
 *   - input as string or object both work
 */

import { describe, expect, it, vi } from "vitest";
import {
  OpenAgentPayLlamaTool,
  createLlamaPaymentTool,
  type LlamaPaymentToolInput,
} from "../src/index.js";
import {
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type Mandate,
  type PaymentManager,
  type PaymentRequest,
  type Session,
  type SessionId,
  type SettlementResult,
  type SignedAuthorization,
  type UserId,
  type WalletConnector,
  type WalletProviderId,
  type ProtocolId,
  type CreateSessionInput,
} from "@openagentpay/core";

const userId = "alice" as UserId;
const wallet = "test-wallet" as WalletProviderId;

function makeMockManager(opts: {
  settle?: (req: PaymentRequest) => Partial<SettlementResult>;
} = {}) {
  let sessionCounter = 0;
  let instrumentCounter = 0;
  const sessions = new Map<string, Session>();
  const calls = {
    createSession: 0,
    createInstrument: 0,
    processPayment: 0,
    settle: [] as PaymentRequest[],
  };

  const mgr: PaymentManager = {
    async createPaymentSession(input: CreateSessionInput): Promise<Session> {
      calls.createSession++;
      sessionCounter++;
      const id = `payment-session-${sessionCounter}` as SessionId;
      const s: Session = {
        id,
        userId: input.userId,
        budget: {
          amountAtomic: BigInt(Math.round(input.budgetUsd * 1e6)).toString(),
          decimals: 6,
          currency: "USDC",
        },
        spent: { amountAtomic: "0", decimals: 6, currency: "USDC" },
        expiresAt: new Date(Date.now() + input.expiresMinutes * 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "active",
      };
      sessions.set(id, s);
      return s;
    },
    async createPaymentInstrument(_provider, input: CreateInstrumentInput): Promise<Instrument> {
      calls.createInstrument++;
      instrumentCounter++;
      return {
        id: `payment-instrument-${instrumentCounter}` as InstrumentId,
        userId: input.userId,
        walletProvider: wallet,
        publicHandle: "0xagent",
        createdAt: new Date().toISOString(),
      };
    },
    async getPaymentSession(id) {
      return sessions.get(id);
    },
    async processPayment(input) {
      calls.processPayment++;
      calls.settle.push(input.request);
      const session = sessions.get(input.sessionId)!;
      const settlement: SettlementResult = {
        success: true,
        transactionRef: ("0xtx" + calls.processPayment) as any,
        network: "mock",
        settledAt: new Date().toISOString(),
        ...opts.settle?.(input.request),
      };
      return {
        success: settlement.success,
        settlement,
        signed: undefined as unknown as SignedAuthorization,
        sessionAfter: session,
      };
    },
    registerConnector(_c: WalletConnector) {},
    getConnector() { return undefined; },
    listProviders() { return [wallet]; },
  };
  return { mgr, calls, sessions };
}

const validMandate: Mandate = {
  "@context": ["https://www.w3.org/ns/credentials/v2"],
  id: "urn:uuid:test",
  type: ["VerifiableCredential", "ap2.IntentMandate"],
  issuer: "did:test",
  issuanceDate: "2026-05-21T00:00:00Z",
  credentialSubject: {
    id: "did:test",
    mandate: {
      kind: "ap2.IntentMandate",
      description: "Test",
      maxAmountAtomic: "1000000",
      currency: "USDC",
      decimals: 6,
    },
  },
  proof: {
    type: "Ed25519Signature2020",
    created: "2026-05-21T00:00:00Z",
    verificationMethod: "did:test#k1",
    proofPurpose: "assertionMethod",
    proofValue: "z3rEK4MN-test",
  },
};

// ----------------------------------------------------------------------------
//  Factory + metadata
// ----------------------------------------------------------------------------

describe("createLlamaPaymentTool", () => {
  it("returns OpenAgentPayLlamaTool with right metadata", () => {
    const { mgr } = makeMockManager();
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
    });
    expect(tool.name).toBe("openagentpay_pay");
    expect(tool.description).toContain("OpenAgentPay");
    expect((tool.parameters as any).type).toBe("object");
    expect((tool.parameters as any).required).toContain("amountUsd");
    expect((tool.parameters as any).required).toContain("recipient");
  });

  it("describes mandates parameter for AP2 composition", () => {
    const { mgr } = makeMockManager();
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
    });
    expect((tool.parameters as any).properties.mandates).toBeDefined();
  });
});

// ----------------------------------------------------------------------------
//  runPayment happy path
// ----------------------------------------------------------------------------

describe("OpenAgentPayLlamaTool.runPayment", () => {
  it("happy path → success + tx hash", async () => {
    const { mgr, calls } = makeMockManager();
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
    });
    const r = await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "test",
    });
    expect(r.success).toBe(true);
    expect(r.txHash).toMatch(/^0xtx/);
    expect(r.walletProvider).toBe("test-wallet");
    expect(r.hadMandates).toBe(false);
    expect(calls.processPayment).toBe(1);
    expect(calls.createSession).toBe(1);
  });

  it("session lazy creation then reuse", async () => {
    const { mgr, calls } = makeMockManager();
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
    });
    await tool.runPayment({ amountUsd: 0.001, recipient: "0xR1", reason: "1" });
    await tool.runPayment({ amountUsd: 0.001, recipient: "0xR2", reason: "2" });
    expect(calls.createSession).toBe(1); // reused
    expect(calls.processPayment).toBe(2);
  });

  it("passes mandates through to PaymentRequest", async () => {
    const { mgr, calls } = makeMockManager();
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
    });
    const r = await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "ap2 test",
      mandates: [validMandate],
    });
    expect(r.success).toBe(true);
    expect(r.hadMandates).toBe(true);
    expect(calls.settle[0]?.mandates).toHaveLength(1);
    expect(calls.settle[0]?.mandates?.[0]!.id).toBe(validMandate.id);
  });

  it("settlement failure → success=false + errorCode", async () => {
    const { mgr } = makeMockManager({
      settle: () => ({
        success: false,
        errorCode: "rpc_error",
        errorMessage: "node down",
      }),
    });
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
    });
    const r = await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "fail test",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("rpc_error");
    expect(r.errorMessage).toMatch(/node down/);
  });

  it("call() returns JSON string of result", async () => {
    const { mgr } = makeMockManager();
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
    });
    const json = await tool.call({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "json test",
    });
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json);
    expect(parsed.success).toBe(true);
  });

  it("call() accepts string input", async () => {
    const { mgr } = makeMockManager();
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
    });
    const json = await tool.call(JSON.stringify({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "string",
    }));
    expect(JSON.parse(json).success).toBe(true);
  });

  it("walletProvider override per call", async () => {
    const { mgr } = makeMockManager();
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: "default-w" as WalletProviderId,
    });
    const r = await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "override",
      walletProvider: "other-w",
    });
    expect(r.walletProvider).toBe("other-w");
  });

  it("internal error caught → returns errorCode=internal_error", async () => {
    const { mgr } = makeMockManager();
    // Force createPaymentInstrument to throw
    mgr.createPaymentInstrument = async () => {
      throw new Error("boom");
    };
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
    });
    const r = await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "internal",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("internal_error");
    expect(r.errorMessage).toMatch(/boom/);
  });

  it("__resetCachedSession forces new session creation", async () => {
    const { mgr, calls } = makeMockManager();
    const tool = new OpenAgentPayLlamaTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
    });
    await tool.runPayment({ amountUsd: 0.001, recipient: "0xR", reason: "1" });
    expect(calls.createSession).toBe(1);
    tool.__resetCachedSession();
    await tool.runPayment({ amountUsd: 0.001, recipient: "0xR", reason: "2" });
    expect(calls.createSession).toBe(2);
  });
});

// ----------------------------------------------------------------------------
//  Governance integration
// ----------------------------------------------------------------------------

describe("OpenAgentPayLlamaTool governance integration", () => {
  it("policy_denied bubbles up as success=false errorCode", async () => {
    const { mgr } = makeMockManager();
    const govDeny: any = {
      preCheck: vi.fn(async () => ({ allowed: false, reason: "over cap" })),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
      governance: govDeny,
    });
    const r = await tool.runPayment({
      amountUsd: 100,
      recipient: "0xR",
      reason: "over budget",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("policy_denied");
    expect(govDeny.preCheck).toHaveBeenCalledOnce();
    expect(govDeny.recordSuccess).not.toHaveBeenCalled();
  });

  it("recordSuccess called on happy path", async () => {
    const { mgr } = makeMockManager();
    const govAllow: any = {
      preCheck: vi.fn(async () => ({ allowed: true })),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
      governance: govAllow,
    });
    await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "ok",
    });
    expect(govAllow.recordSuccess).toHaveBeenCalledOnce();
  });

  it("recordFailure called on settlement failure", async () => {
    const { mgr } = makeMockManager({
      settle: () => ({ success: false, errorCode: "rpc_error" }),
    });
    const gov: any = {
      preCheck: vi.fn(async () => ({ allowed: true })),
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    const tool = createLlamaPaymentTool({
      manager: mgr,
      userId,
      defaultWalletProvider: wallet,
      governance: gov,
    });
    await tool.runPayment({
      amountUsd: 0.001,
      recipient: "0xR",
      reason: "fail",
    });
    expect(gov.recordFailure).toHaveBeenCalledOnce();
  });
});
