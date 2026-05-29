/**
 * Self-test for the conformance suite — uses a tiny in-memory fake connector
 * to confirm our `runWalletConformance()` driver works end-to-end.
 *
 * Real third-party usage looks the same: import vitest globals, build a
 * TestRunner, hand it to `runWalletConformance`.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
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
} from "@openagentpay/core";
import { runWalletConformance, type TestRunner } from "../src/wallet.js";

// ---------------------------------------------------------------------------
//  Toy connector — passes every contract trivially.
// ---------------------------------------------------------------------------
class ToyWalletConnector implements WalletConnector {
  private readonly instruments = new Map<string, Instrument>();
  private readonly byUser = new Map<string, Instrument>();

  getCapabilities(): WalletCapabilities {
    return {
      walletProvider: "toy" as WalletProviderId,
      displayName: "Toy",
      supportedAssets: [{ symbol: "USDC", decimals: 6 } satisfies Asset],
      supportedProtocols: ["toy-v1" as ProtocolId],
      requiresUserApproval: false,
      settlesOnChain: false,
    };
  }

  async createInstrument(input: CreateInstrumentInput): Promise<Instrument> {
    if (!input.userId) throw new Error("userId required");
    const cached = this.byUser.get(input.userId);
    if (cached) return cached;
    const id = `payment-instrument-toy-${input.userId}` as InstrumentId;
    const inst: Instrument = {
      id,
      userId: input.userId,
      walletProvider: "toy" as WalletProviderId,
      publicHandle: `toy-handle-${input.userId}`,
      createdAt: new Date().toISOString(),
    };
    this.instruments.set(id, inst);
    this.byUser.set(input.userId, inst);
    return inst;
  }

  async getBalance(id: InstrumentId): Promise<Balance> {
    const inst = this.instruments.get(id);
    if (!inst) throw new Error(`instrument not found: ${id}`);
    return {
      instrumentId: id,
      asset: { symbol: "USDC", decimals: 6 },
      money: { amountAtomic: "1000000", decimals: 6, currency: "USDC" },
      fetchedAt: new Date().toISOString(),
    };
  }

  async signAuthorization(
    input: SignAuthorizationInput
  ): Promise<SignedAuthorization> {
    if (input.request.protocol !== ("toy-v1" as ProtocolId)) {
      throw new Error(
        `unsupported protocol ${String(input.request.protocol)}`
      );
    }
    const inst = this.instruments.get(input.instrumentId);
    if (!inst) {
      throw new Error(`instrument not found: ${String(input.instrumentId)}`);
    }
    return {
      request: input.request,
      signer: inst.publicHandle,
      signature: `toy-sig-${input.request.nonce}`,
    };
  }

  async settle(signed: SignedAuthorization): Promise<SettlementResult> {
    return {
      success: true,
      transactionRef: `toy-tx-${signed.signature}` as never,
      network: "toy-net",
      settledAt: new Date().toISOString(),
      settledAmount: signed.request.amount,
    };
  }
}

// ---------------------------------------------------------------------------
//  Build a TestRunner from vitest globals
// ---------------------------------------------------------------------------
const runner: TestRunner = {
  describe: (name, fn) => describe(name, fn),
  it: (name, fn) => it(name, fn),
  beforeAll: (fn) => beforeAll(fn),
  expect: (value) => expect(value) as unknown as TestRunner["expect"] extends (
    v: unknown
  ) => infer R
    ? R
    : never,
};

// ---------------------------------------------------------------------------
//  Run the conformance suite against the toy connector.
//  `requiresNetwork: false` (default) → network-gated tests skip cleanly.
// ---------------------------------------------------------------------------
runWalletConformance(
  runner,
  {
    createConnector: () => new ToyWalletConnector(),
    createUserId: (suffix) => `toy-${suffix}` as UserId,
    buildPaymentRequest: (overrides): PaymentRequest => ({
      protocol: "toy-v1" as ProtocolId,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "toy-merchant",
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0x" + "0".repeat(64),
      rawPayload: {},
      ...overrides,
    }),
  },
  { skipSettle: true, suiteName: "Toy connector (self-check)" }
);
