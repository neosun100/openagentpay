import { describe, it, expect } from "vitest";
import { createVercelAiPaymentTool } from "../src/index.js";
import type { CreateLlamaPaymentToolConfig } from "@openagentpay/llamaindex-plugin";
import type {
  CreateInstrumentInput,
  Instrument,
  InstrumentId,
  PaymentManager,
  ProcessPaymentInput,
  ProcessPaymentOutput,
  Session,
  SessionId,
  UserId,
  WalletConnector,
  WalletProviderId,
} from "@openagentpay/core";

class FakeManager implements PaymentManager {
  private session: Session = {
    id: "sess-1" as SessionId,
    userId: "alice" as UserId,
    budget: { amountAtomic: "1000000000", decimals: 6, currency: "USDC" },
    spent: { amountAtomic: "0", decimals: 6, currency: "USDC" },
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
  };
  async createPaymentSession() {
    return this.session;
  }
  async createPaymentInstrument(
    walletProvider: WalletProviderId,
    input: CreateInstrumentInput
  ): Promise<Instrument> {
    return {
      id: `payment-instrument-${walletProvider}` as InstrumentId,
      userId: input.userId,
      walletProvider,
      publicHandle: "0xfake",
      createdAt: new Date().toISOString(),
    };
  }
  async getPaymentSession() {
    return this.session;
  }
  async processPayment(_: ProcessPaymentInput): Promise<ProcessPaymentOutput> {
    return {
      success: true,
      settlement: {
        success: true,
        transactionRef: "0xfaketx" as never,
        network: "test-net",
        settledAt: new Date().toISOString(),
      },
      sessionAfter: this.session,
    };
  }
  registerConnector(_: WalletConnector): void {}
  getConnector(_: WalletProviderId): WalletConnector | undefined {
    return undefined;
  }
  listProviders(): readonly WalletProviderId[] {
    return ["fake" as WalletProviderId];
  }
}

const baseConfig = (): CreateLlamaPaymentToolConfig => ({
  manager: new FakeManager(),
  userId: "alice" as UserId,
  defaultWalletProvider: "fake" as WalletProviderId,
});

describe("vercel-ai-plugin createVercelAiPaymentTool", () => {
  it("returns a Vercel-AI-shaped descriptor", () => {
    const t = createVercelAiPaymentTool(baseConfig());
    expect(typeof t.description).toBe("string");
    expect(t.parameters).toBeDefined();
    expect(typeof t.execute).toBe("function");
  });

  it("parameters schema has required fields", () => {
    const t = createVercelAiPaymentTool(baseConfig());
    const schema = t.parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toContain("amountUsd");
    expect(schema.required).toContain("recipient");
    expect(schema.required).toContain("reason");
  });

  it("execute() invokes a payment via the underlying manager", async () => {
    const t = createVercelAiPaymentTool(baseConfig());
    const r = await t.execute({
      amountUsd: 1.5,
      recipient: "0xMerchant",
      reason: "API call",
    });
    expect(r.success).toBe(true);
    expect(r.amountUsd).toBe(1.5);
    expect(r.recipient).toBe("0xMerchant");
  });

  it("accepts optional walletProvider override", async () => {
    const t = createVercelAiPaymentTool(baseConfig());
    const r = await t.execute({
      amountUsd: 1,
      recipient: "0xMerchant",
      reason: "x",
      walletProvider: "fake",
    });
    expect(r.walletProvider).toBe("fake");
  });

  it("accepts optional mandates array", async () => {
    const t = createVercelAiPaymentTool(baseConfig());
    const r = await t.execute({
      amountUsd: 1,
      recipient: "0xMerchant",
      reason: "x",
      mandates: [],
    });
    expect(r.success).toBe(true);
    expect(r.hadMandates).toBe(false);
  });
});
