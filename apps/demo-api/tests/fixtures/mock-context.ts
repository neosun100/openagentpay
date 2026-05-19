/**
 * Mock context fixture for demo-api integration tests.
 *
 * Builds a fully-functional AppContext where:
 *   - PaymentManager + SessionManager are real
 *   - Connectors are mock (no chain calls, no Coinbase API calls)
 *   - Governance is real (real PolicyEngine + real audit sink)
 *
 * This means tests exercise the FULL handler logic + governance pipeline,
 * but skip the actual sign/settle network calls.
 */

import {
  InMemoryPaymentManager,
  InMemorySessionManager,
  type Asset,
  type Balance,
  type CreateInstrumentInput,
  type Instrument,
  type InstrumentId,
  type PaymentRequest,
  type ProtocolId,
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
} from "@openagentpay/governance";

import type { AppContext, ConnectorBundle } from "../../src/context.js";

const MOCK_TX = "0xMOCKTX_aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd111111";

/**
 * Build a fake on-chain connector that records every call and returns
 * canned successful settlements. No network IO.
 */
export function buildMockConnector(opts: {
  walletProvider: string;
  displayName: string;
  /** USDC balance in atomic units. Default 100 USDC. */
  balanceAtomic?: string;
  /** Force settle to fail. */
  shouldFailSettle?: boolean;
}): {
  connector: WalletConnector;
  callLog: Array<{ method: string; args: unknown }>;
} {
  const callLog: Array<{ method: string; args: unknown }> = [];
  const provider = opts.walletProvider as WalletProviderId;
  const protocol: ProtocolId = "x402-v1" as ProtocolId;
  const balanceAtomic = opts.balanceAtomic ?? "100000000"; // 100 USDC

  const asset: Asset = { symbol: "USDC", decimals: 6 };

  const instruments = new Map<UserId, Instrument>();
  const byId = new Map<InstrumentId, Instrument>();

  const connector: WalletConnector = {
    getCapabilities(): WalletCapabilities {
      return {
        walletProvider: provider,
        displayName: opts.displayName,
        supportedAssets: [asset],
        supportedProtocols: [protocol],
        requiresUserApproval: false,
        settlesOnChain: true,
      };
    },
    async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
      callLog.push({ method: "createInstrument", args: input });
      const existing = instruments.get(input.userId);
      if (existing) return existing;
      const id = `payment-instrument-${provider}-${input.userId}` as InstrumentId;
      const inst: Instrument = {
        id,
        userId: input.userId,
        walletProvider: provider,
        publicHandle: `0xMOCK${provider.slice(0, 6)}`,
        createdAt: new Date().toISOString(),
      };
      instruments.set(input.userId, inst);
      byId.set(id, inst);
      return inst;
    },
    async getBalance(instrumentId: InstrumentId): Promise<Balance> {
      callLog.push({ method: "getBalance", args: instrumentId });
      const inst = byId.get(instrumentId);
      if (!inst) throw new Error("instrument not found");
      return {
        instrumentId: inst.id,
        asset,
        money: { amountAtomic: balanceAtomic, decimals: 6, currency: "USDC" },
        fetchedAt: new Date().toISOString(),
      };
    },
    async signAuthorization(
      input: SignAuthorizationInput
    ): Promise<SignedAuthorization> {
      callLog.push({ method: "signAuthorization", args: input });
      return {
        request: input.request,
        signer: `0xMOCK${provider.slice(0, 6)}`,
        signature: "0x" + "ab".repeat(65),
        extra: {
          chainId: 84532,
          verifyingContract: "0xMOCK_USDC",
          v: 27,
          r: "0x" + "11".repeat(32),
          s: "0x" + "22".repeat(32),
        },
      };
    },
    async settle(signed: SignedAuthorization): Promise<SettlementResult> {
      callLog.push({ method: "settle", args: signed });
      if (opts.shouldFailSettle) {
        return {
          success: false,
          network: "mock-network",
          settledAt: new Date().toISOString(),
          errorCode: "rpc_error",
          errorMessage: "mock failure",
        };
      }
      return {
        success: true,
        transactionRef: MOCK_TX as TransactionRef,
        network: "mock-network",
        settledAt: new Date().toISOString(),
        settledAmount: signed.request.amount,
        raw: { blockNumber: "12345", gasUsed: "100000" },
      };
    },
  };

  // Add helper instance methods used by handlers (generateNonce + agentAddress)
  (connector as any).generateNonce = () => "0x" + "00".repeat(32);
  (connector as any).agentAddress = `0xMOCK${provider.slice(0, 6)}`;
  // Expose store accessor used by manager.resolveInstrument
  (connector as any).store = {
    getById: async (id: InstrumentId) => byId.get(id),
    get: async (uid: UserId) => instruments.get(uid),
  };

  return { connector, callLog };
}

/** Build a complete mock AppContext with two mock wallets + real governance. */
export function buildMockContext(opts: {
  shouldFailSettle?: boolean;
} = {}): {
  ctx: AppContext;
  hashkeyCalls: Array<{ method: string; args: unknown }>;
  cdpCalls: Array<{ method: string; args: unknown }>;
} {
  const sessionManager = new InMemorySessionManager();

  // Build two mock connectors
  const hk = buildMockConnector({
    walletProvider: "hashkey-chain",
    displayName: "HashKey Chain (Mock)",
    ...(opts.shouldFailSettle ? { shouldFailSettle: opts.shouldFailSettle } : {}),
  });
  const cdp = buildMockConnector({
    walletProvider: "coinbase-cdp",
    displayName: "Coinbase CDP (Mock)",
    ...(opts.shouldFailSettle ? { shouldFailSettle: opts.shouldFailSettle } : {}),
  });

  const connectors = new Map<WalletProviderId, ConnectorBundle>();
  connectors.set("hashkey-chain" as WalletProviderId, {
    walletProvider: "hashkey-chain" as WalletProviderId,
    displayName: "HashKey Chain (Mock)",
    connector: hk.connector,
    addressExplorer: (addr) => `https://mock.explorer/address/${addr}`,
    txExplorer: (hash) => `https://mock.explorer/tx/${hash}`,
    chainName: "Mock HashKey Testnet",
    chainId: 133,
    tokenAddress: "0xMOCK_HK_USDC",
    tokenDecimals: 6,
    tokenLabel: "MockUSDC (HashKey)",
    agentAddress: (hk.connector as any).agentAddress,
  });
  connectors.set("coinbase-cdp" as WalletProviderId, {
    walletProvider: "coinbase-cdp" as WalletProviderId,
    displayName: "Coinbase CDP (Mock)",
    connector: cdp.connector,
    addressExplorer: (addr) => `https://mock.basescan/address/${addr}`,
    txExplorer: (hash) => `https://mock.basescan/tx/${hash}`,
    chainName: "Mock Base Sepolia",
    chainId: 84532,
    tokenAddress: "0xMOCK_CDP_USDC",
    tokenDecimals: 6,
    tokenLabel: "USDC (Mock Circle)",
    agentAddress: (cdp.connector as any).agentAddress,
  });

  // PaymentManager with resolveInstrument that walks both stores
  const manager = new InMemoryPaymentManager({
    sessionManager,
    resolveInstrument: async (id) => {
      for (const b of connectors.values()) {
        const c = b.connector as any;
        const i = await c.store?.getById(id);
        if (i) return i;
      }
      return undefined;
    },
  });
  manager.registerConnector(hk.connector);
  manager.registerConnector(cdp.connector);

  // Real governance with same demo policies
  const policyEngine = new InMemoryPolicyEngine();
  policyEngine.use(amountThreshold({ maxAtomic: "50000000" })); // $50
  policyEngine.use(velocityLimit({ windowMs: 60_000, maxCount: 20 }));
  policyEngine.use(
    velocityLimit({
      windowMs: 60 * 60 * 1000,
      maxAmountAtomic: "100000000",
      currency: "USDC",
    })
  );
  const auditSink = new InMemoryAuditSink(500);
  const governance = new GovernanceManager({
    policyEngine,
    complianceChecker: new StaticSanctionsChecker([DEMO_SANCTIONS_LIST]),
    auditSink,
  });

  const ctx: AppContext = {
    manager,
    sessionManager,
    demoUserId: "demo-user" as UserId,
    connectors,
    defaultProvider: "hashkey-chain" as WalletProviderId,
    governance,
    auditSink,
    policyDescriptions: policyEngine.list(),
    recentPayments: [],
  };

  return { ctx, hashkeyCalls: hk.callLog, cdpCalls: cdp.callLog };
}

export const TORNADO_CASH_ADDRESS =
  "0x8589427373d6d84e98730d7795d8f6f8731fda16";
