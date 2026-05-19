/**
 * demo-api integration tests
 *
 * Exercises the FULL handler logic end-to-end with mock connectors:
 *   - listWallets / getWalletStatus / createSession / getSession
 *   - processPayment (success + governance deny + sanctions deny + settle fail)
 *   - getGovernanceStatus
 *   - walletProvider routing (hashkey vs coinbase-cdp)
 *
 * No real chain calls; mock connector returns canned tx hashes.
 * Real PaymentManager + SessionManager + PolicyEngine + AuditLogger.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetContext, __setContextForTest } from "../src/context.js";
import {
  createSession,
  getGovernanceStatus,
  getSession,
  getWalletStatus,
  listWallets,
  processPayment,
} from "../src/handlers.js";
import { buildMockContext, TORNADO_CASH_ADDRESS } from "./fixtures/mock-context.js";
import type { SessionId } from "@openagentpay/core";

describe("demo-api · listWallets / getWalletStatus", () => {
  beforeEach(() => {
    const { ctx } = buildMockContext();
    __setContextForTest(ctx);
  });
  afterEach(() => _resetContext());

  it("listWallets returns both providers with default = hashkey-chain", async () => {
    const r = await listWallets();
    expect(r.wallets).toHaveLength(2);
    expect(r.defaultProvider).toBe("hashkey-chain");
    expect(r.wallets.map((w) => w.walletProvider).sort()).toEqual([
      "coinbase-cdp",
      "hashkey-chain",
    ]);
  });

  it("getWalletStatus(undefined) returns default provider's wallet", async () => {
    const r = await getWalletStatus(undefined);
    expect(r.walletProvider).toBe("hashkey-chain");
    expect(r.balance).toBe(100); // mock connector returns 100 USDC
  });

  it("getWalletStatus('coinbase-cdp') returns cdp wallet", async () => {
    const r = await getWalletStatus("coinbase-cdp");
    expect(r.walletProvider).toBe("coinbase-cdp");
    expect(r.network).toBe("Mock Base Sepolia");
    expect(r.tokenLabel).toBe("USDC (Mock Circle)");
  });

  it("getWalletStatus('unknown-wallet') falls back to default", async () => {
    const r = await getWalletStatus("nonexistent-wallet");
    expect(r.walletProvider).toBe("hashkey-chain");
  });
});

describe("demo-api · session lifecycle", () => {
  beforeEach(() => {
    const { ctx } = buildMockContext();
    __setContextForTest(ctx);
  });
  afterEach(() => _resetContext());

  it("createSession then getSession round-trips", async () => {
    const s = await createSession({ budgetUsd: 1, expiryMinutes: 10 });
    expect(s.sessionId).toMatch(/^payment-session-/);
    expect(s.budgetUsd).toBe(1);

    const g = await getSession(s.sessionId as SessionId);
    expect(g).not.toBeNull();
    expect(g!.sessionId).toBe(s.sessionId);
    expect(g!.budgetAtomic).toBe("1000000");
    expect(g!.spentAtomic).toBe("0");
  });

  it("createSession rejects budgetUsd <= 0", async () => {
    await expect(
      createSession({ budgetUsd: 0, expiryMinutes: 10 })
    ).rejects.toThrow(/budgetUsd/);
  });

  it("createSession rejects expiryMinutes > 1440", async () => {
    await expect(
      createSession({ budgetUsd: 1, expiryMinutes: 99999 })
    ).rejects.toThrow(/expiryMinutes/);
  });

  it("getSession returns null for unknown id", async () => {
    const g = await getSession("nonexistent" as SessionId);
    expect(g).toBeNull();
  });
});

describe("demo-api · processPayment happy path", () => {
  let calls: Array<{ method: string; args: unknown }> = [];

  beforeEach(() => {
    const { ctx, cdpCalls } = buildMockContext();
    calls = cdpCalls;
    __setContextForTest(ctx);
  });
  afterEach(() => _resetContext());

  it("returns success with mock tx hash + records audit", async () => {
    const session = await createSession({ budgetUsd: 1, expiryMinutes: 10 });
    const r = await processPayment({
      sessionId: session.sessionId,
      amountUsdc: 0.001,
      walletProvider: "coinbase-cdp",
    });

    expect(r.success).toBe(true);
    expect(r.txHash).toMatch(/^0xMOCKTX/);
    expect(r.walletProvider).toBe("coinbase-cdp");
    expect(r.network).toBe("mock-network");

    // Verify mock connector was actually called
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("createInstrument");
    expect(methods).toContain("signAuthorization");
    expect(methods).toContain("settle");

    // Verify governance recorded the success
    const gov = await getGovernanceStatus();
    const successEvents = gov.auditLog.filter((e) => e.kind === "payment_success");
    expect(successEvents.length).toBe(1);
    expect(successEvents[0]!.txHash).toMatch(/^0xMOCKTX/);
  });

  it("walletProvider routing: hashkey vs cdp picks the right connector", async () => {
    const { ctx, hashkeyCalls, cdpCalls } = buildMockContext();
    __setContextForTest(ctx);
    const session = await createSession({ budgetUsd: 1, expiryMinutes: 10 });

    await processPayment({
      sessionId: session.sessionId,
      amountUsdc: 0.001,
      walletProvider: "hashkey-chain",
    });

    expect(hashkeyCalls.some((c) => c.method === "settle")).toBe(true);
    expect(cdpCalls.some((c) => c.method === "settle")).toBe(false);
  });
});

describe("demo-api · processPayment governance deny paths", () => {
  beforeEach(() => {
    const { ctx } = buildMockContext();
    __setContextForTest(ctx);
  });
  afterEach(() => _resetContext());

  it("denies $100 payment via amountThreshold policy", async () => {
    const session = await createSession({ budgetUsd: 200, expiryMinutes: 10 });
    const r = await processPayment({
      sessionId: session.sessionId,
      amountUsdc: 100,
      walletProvider: "coinbase-cdp",
    });

    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("policy_denied");
    expect(r.errorMessage).toMatch(/exceeds maxAtomic/);
    expect(r.txHash).toBeUndefined();

    // Verify audit captured the denial
    const gov = await getGovernanceStatus();
    const denials = gov.auditLog.filter((e) => e.result === "denied");
    expect(denials.length).toBeGreaterThan(0);
  });

  it("denies payment to sanctioned address (Tornado Cash)", async () => {
    const session = await createSession({ budgetUsd: 1, expiryMinutes: 10 });
    const r = await processPayment({
      sessionId: session.sessionId,
      amountUsdc: 0.001,
      recipient: TORNADO_CASH_ADDRESS,
      walletProvider: "coinbase-cdp",
    });

    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("policy_denied"); // handler labels all governance denies as policy_denied
    expect(r.errorMessage).toMatch(/compliance|sanctions/i);

    const gov = await getGovernanceStatus();
    const complianceDenies = gov.auditLog.filter(
      (e) => e.kind === "compliance_check" && e.result === "denied"
    );
    expect(complianceDenies.length).toBe(1);
  });

  it("velocityLimit cap enforced after enough payments", async () => {
    const session = await createSession({ budgetUsd: 200, expiryMinutes: 10 });

    // 20 small payments succeed (within maxCount=20)
    for (let i = 0; i < 20; i++) {
      const r = await processPayment({
        sessionId: session.sessionId,
        amountUsdc: 0.001,
        walletProvider: "coinbase-cdp",
      });
      expect(r.success).toBe(true);
    }

    // 21st should hit velocity limit
    const r21 = await processPayment({
      sessionId: session.sessionId,
      amountUsdc: 0.001,
      walletProvider: "coinbase-cdp",
    });
    expect(r21.success).toBe(false);
    expect(r21.errorMessage).toMatch(/maxCount/i);
  });
});

describe("demo-api · processPayment settle failure path", () => {
  beforeEach(() => {
    const { ctx } = buildMockContext({ shouldFailSettle: true });
    __setContextForTest(ctx);
  });
  afterEach(() => _resetContext());

  it("returns success:false when chain settle fails + records payment_failure", async () => {
    const session = await createSession({ budgetUsd: 1, expiryMinutes: 10 });
    const r = await processPayment({
      sessionId: session.sessionId,
      amountUsdc: 0.001,
      walletProvider: "coinbase-cdp",
    });

    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("rpc_error");
    expect(r.txHash).toBeUndefined();

    const gov = await getGovernanceStatus();
    const failures = gov.auditLog.filter((e) => e.kind === "payment_failure");
    expect(failures.length).toBe(1);
  });
});

describe("demo-api · processPayment validation", () => {
  beforeEach(() => {
    const { ctx } = buildMockContext();
    __setContextForTest(ctx);
  });
  afterEach(() => _resetContext());

  it("rejects missing sessionId", async () => {
    await expect(
      processPayment({ sessionId: "", amountUsdc: 1 })
    ).rejects.toThrow(/sessionId/);
  });

  it("rejects amountUsdc <= 0", async () => {
    const session = await createSession({ budgetUsd: 1, expiryMinutes: 10 });
    await expect(
      processPayment({
        sessionId: session.sessionId,
        amountUsdc: -1,
      })
    ).rejects.toThrow(/amountUsdc/);
  });
});

describe("demo-api · governance status", () => {
  beforeEach(() => {
    const { ctx } = buildMockContext();
    __setContextForTest(ctx);
  });
  afterEach(() => _resetContext());

  it("getGovernanceStatus returns all 3 default policies + compliance", async () => {
    const r = await getGovernanceStatus();
    expect(r.policies.length).toBe(3);
    expect(r.compliance.enabled).toBe(true);
    expect(r.compliance.checker).toContain("Sanctions");
  });

  it("audit log accumulates across payments", async () => {
    const session = await createSession({ budgetUsd: 1, expiryMinutes: 10 });
    const before = (await getGovernanceStatus()).auditCount;
    await processPayment({
      sessionId: session.sessionId,
      amountUsdc: 0.001,
      walletProvider: "coinbase-cdp",
    });
    const after = (await getGovernanceStatus()).auditCount;
    expect(after).toBeGreaterThan(before);
  });
});
