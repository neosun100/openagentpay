/**
 * Tests for InMemoryPaymentManager.
 *
 * Coverage:
 *   - createPaymentSession proxies to SessionManager
 *   - createPaymentInstrument routes to right connector
 *   - registerConnector / listProviders work as registry
 *   - processPayment runs full flow: reserve → sign → settle → commit
 *   - processPayment fails fast when session/instrument/connector missing
 *   - failed settlement releases reservation (no spent advance)
 *   - successful settlement advances session.spent
 */

import { describe, expect, it } from "vitest";
import {
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type Money,
  type PaymentRequest,
  type ProtocolId,
  type SettlementResult,
  type SignAuthorizationInput,
  type SignedAuthorization,
  type UserId,
  type WalletCapabilities,
  type WalletConnector,
  type WalletProviderId,
} from "../src/types.js";
import {
  InMemoryPaymentManager,
  PaymentManagerError,
  createInMemoryPaymentManager,
} from "../src/manager/payment-manager.js";

// ---------------------------------------------------------------------------
//  Mock connector — minimal valid WalletConnector implementation
// ---------------------------------------------------------------------------

const MOCK_PROVIDER_ID = "mock-wallet" as WalletProviderId;
const MOCK_PROTOCOL = "mock-protocol" as ProtocolId;

const usdc = (atomic: string): Money => ({
  amountAtomic: atomic,
  decimals: 6,
  currency: "USDC",
});

class MockConnector implements WalletConnector {
  public readonly instruments = new Map<string, Instrument>();
  public settleResult: SettlementResult = {
    success: true,
    transactionRef: "mock-tx-1" as Brand<string, "TransactionRef">,
    network: "mock",
    settledAt: new Date(0).toISOString(),
  };

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: MOCK_PROVIDER_ID,
      displayName: "Mock Wallet",
      supportedAssets: [{ symbol: "USDC", decimals: 6 } as Asset],
      supportedProtocols: [MOCK_PROTOCOL],
      requiresUserApproval: false,
      settlesOnChain: false,
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    const id = `payment-instrument-mock-${input.userId}` as InstrumentId;
    const inst: Instrument = {
      id,
      userId: input.userId,
      walletProvider: MOCK_PROVIDER_ID,
      publicHandle: `mock-handle-${input.userId}`,
      createdAt: new Date(0).toISOString(),
    };
    this.instruments.set(id, inst);
    this.instruments.set(input.userId, inst);
    return inst;
  }

  async getBalance(instrumentId: InstrumentId): Promise<Balance> {
    return {
      instrumentId,
      asset: { symbol: "USDC", decimals: 6 },
      money: usdc("1000000000"), // 1000 USDC
      fetchedAt: new Date(0).toISOString(),
    };
  }

  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    return {
      request: input.request,
      signer: this.instruments.get(input.instrumentId)?.publicHandle ?? "mock",
      signature: "0xmocksignature",
      encoded: "mock-encoded",
    };
  }

  async settle(_signed: SignedAuthorization): Promise<SettlementResult> {
    return this.settleResult;
  }
}

// Re-imported here to avoid dragging the whole types module into Brand declaration
type Brand<T, B extends string> = T & { readonly __brand: B };

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

const userAlice = "alice" as UserId;

describe("InMemoryPaymentManager basics", () => {
  it("registers connectors and lists providers", () => {
    const conn = new MockConnector();
    const mgr = new InMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
    });
    mgr.registerConnector(conn);
    expect(mgr.listProviders()).toContain(MOCK_PROVIDER_ID);
    expect(mgr.getConnector(MOCK_PROVIDER_ID)).toBe(conn);
  });

  it("createPaymentSession returns a valid session", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
    });
    const s = await mgr.createPaymentSession({
      userId: userAlice,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    expect(s.budget).toEqual(usdc("1000000"));
    expect(s.status).toBe("active");
  });

  it("createPaymentInstrument routes to right connector", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
    });
    const inst = await mgr.createPaymentInstrument(MOCK_PROVIDER_ID, {
      userId: userAlice,
    });
    expect(inst.walletProvider).toBe(MOCK_PROVIDER_ID);
    expect(inst.userId).toBe("alice");
  });

  it("createPaymentInstrument throws when provider not registered", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      // no connectors registered
    });
    await expect(
      mgr.createPaymentInstrument(MOCK_PROVIDER_ID, { userId: userAlice })
    ).rejects.toThrow(PaymentManagerError);
  });
});

describe("InMemoryPaymentManager.processPayment", () => {
  function makeRequest(): PaymentRequest {
    return {
      protocol: MOCK_PROTOCOL,
      amount: usdc("100000"), // 0.1 USDC
      recipient: "merchant_x",
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: 9_999_999_999,
      nonce: "0xabcdef",
      rawPayload: {},
    };
  }

  it("runs full flow: reserve → sign → settle → commit", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
    });
    const session = await mgr.createPaymentSession({
      userId: userAlice,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    const inst = await mgr.createPaymentInstrument(MOCK_PROVIDER_ID, {
      userId: userAlice,
    });

    const r = await mgr.processPayment({
      sessionId: session.id,
      instrumentId: inst.id,
      request: makeRequest(),
    });

    expect(r.success).toBe(true);
    expect(r.settlement.transactionRef).toBe("mock-tx-1");
    expect(r.sessionAfter.spent.amountAtomic).toBe("100000"); // 0.1 USDC
  });

  it("fails when session not found", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
    });
    const inst = await mgr.createPaymentInstrument(MOCK_PROVIDER_ID, {
      userId: userAlice,
    });
    await expect(
      mgr.processPayment({
        sessionId: "session-doesnotexist" as never,
        instrumentId: inst.id,
        request: makeRequest(),
      })
    ).rejects.toThrow(/Session.*not found/);
  });

  it("fails when instrument not found", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async () => undefined,
      connectors: [conn],
    });
    const session = await mgr.createPaymentSession({
      userId: userAlice,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    await expect(
      mgr.processPayment({
        sessionId: session.id,
        instrumentId: "payment-instrument-mock-bob" as InstrumentId,
        request: makeRequest(),
      })
    ).rejects.toThrow(/Instrument.*not found/);
  });

  it("releases reservation on failed settle (no spend advance)", async () => {
    const conn = new MockConnector();
    conn.settleResult = {
      success: false,
      network: "mock",
      settledAt: new Date(0).toISOString(),
      errorCode: "rpc_error",
    };
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
    });
    const session = await mgr.createPaymentSession({
      userId: userAlice,
      budgetUsd: 1.0,
      expiresMinutes: 60,
    });
    const inst = await mgr.createPaymentInstrument(MOCK_PROVIDER_ID, {
      userId: userAlice,
    });

    const r = await mgr.processPayment({
      sessionId: session.id,
      instrumentId: inst.id,
      request: makeRequest(),
    });

    expect(r.success).toBe(false);
    expect(r.sessionAfter.spent.amountAtomic).toBe("0"); // budget restored
  });

  it("budget exceeded → session_rejected error", async () => {
    const conn = new MockConnector();
    const mgr = createInMemoryPaymentManager({
      resolveInstrument: async (id) => conn.instruments.get(id),
      connectors: [conn],
    });
    const session = await mgr.createPaymentSession({
      userId: userAlice,
      budgetUsd: 0.05, // tiny — 50_000 atomic
      expiresMinutes: 60,
    });
    const inst = await mgr.createPaymentInstrument(MOCK_PROVIDER_ID, {
      userId: userAlice,
    });

    await expect(
      mgr.processPayment({
        sessionId: session.id,
        instrumentId: inst.id,
        request: makeRequest(), // tries 0.1 USDC > 0.05 budget
      })
    ).rejects.toThrow(/budget_exceeded/);
  });
});
