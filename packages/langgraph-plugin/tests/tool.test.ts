import { describe, it, expect } from "vitest";
import { createLanggraphPaymentNode } from "../src/index.js";
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

describe("langgraph-plugin createLanggraphPaymentNode", () => {
  it("returns a node with name, description, schema, invoke()", () => {
    const node = createLanggraphPaymentNode({
      manager: new FakeManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "fake" as WalletProviderId,
    });
    expect(node.name).toBe("openagentpay_pay");
    expect(typeof node.description).toBe("string");
    expect(node.schema).toBeDefined();
    expect(typeof node.invoke).toBe("function");
  });

  it("invoke() returns a payment result", async () => {
    const node = createLanggraphPaymentNode({
      manager: new FakeManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "fake" as WalletProviderId,
    });
    const r = await node.invoke({
      amountUsd: 2.5,
      recipient: "0xRecipient",
      reason: "graph payment",
    });
    expect(r.success).toBe(true);
    expect(r.amountUsd).toBe(2.5);
  });

  it("schema declares amountUsd / recipient / reason as required", () => {
    const node = createLanggraphPaymentNode({
      manager: new FakeManager(),
      userId: "alice" as UserId,
      defaultWalletProvider: "fake" as WalletProviderId,
    });
    const schema = node.schema as { required?: string[] };
    expect(schema.required).toEqual(["amountUsd", "recipient", "reason"]);
  });
});
