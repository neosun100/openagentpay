/**
 * Tests for bootstrapFromConfig — covers wiring without requiring real wallets.
 */

import { describe, it, expect } from "vitest";
import { defaultConfig, validateConfig } from "@openagentpay/config";
import { bootstrapFromConfig } from "../src/configBootstrap.js";

describe("bootstrapFromConfig", () => {
  it("succeeds on an empty default config", async () => {
    const cfg = defaultConfig();
    const r = await bootstrapFromConfig(cfg, { log: () => {} });
    expect(r.loadedWallets.length).toBe(0);
    expect(r.walletErrors.length).toBe(0);
    expect(r.mintedKeys.length).toBe(0);
    // PaymentManager exists and lists no providers
    expect(r.paymentManager.listProviders().length).toBe(0);
  });

  it("captures errors loading non-existent wallet modules", async () => {
    const cfg = validateConfig({
      version: "1",
      wallets: [
        {
          provider: "fake",
          module: "@openagentpay/this-does-not-exist",
          config: {},
          secrets: {},
        },
      ],
    });
    const r = await bootstrapFromConfig(cfg, { log: () => {} });
    expect(r.loadedWallets.length).toBe(0);
    expect(r.walletErrors.length).toBe(1);
    expect(r.walletErrors[0]?.provider).toBe("fake");
    expect(r.walletErrors[0]?.error).toMatch(/import|failed|cannot/i);
  });

  it("hashes the apiKey of tenants from inline:// secret refs", async () => {
    const cfg = validateConfig({
      version: "1",
      tenants: [
        {
          id: "team-alpha",
          apiKey: "inline://my-secret-key-1234",
          dailyBudgetUsd: 100,
        },
      ],
    });
    const r = await bootstrapFromConfig(cfg, {
      log: () => {},
      resolveSecret: (uri) =>
        uri.startsWith("inline://") ? uri.slice("inline://".length) : undefined,
    });
    expect(r.mintedKeys.length).toBe(0);
    const t = await r.tenantStore.findById("team-alpha");
    expect(t?.id).toBe("team-alpha");
    expect(t?.dailyBudgetUsd).toBe(100);
    expect(t?.apiKeyHash.length).toBeGreaterThan(40);
  });

  it("translates yaml policies into a working PolicyEngine", async () => {
    const cfg = validateConfig({
      version: "1",
      governance: {
        policies: [
          { kind: "amountThreshold", maxUsd: 25 },
          { kind: "velocityLimit", windowSeconds: 60, maxCount: 5 },
          { kind: "merchantBlacklist", addresses: ["0xbad"] },
          { kind: "timeOfDay", startHourUtc: 1, endHourUtc: 23 },
        ],
        compliance: { checkers: [] },
        audit: { sinks: [{ kind: "console", config: {}, secrets: {} }] },
      },
    });
    const r = await bootstrapFromConfig(cfg, { log: () => {} });
    // GovernanceManager is constructed — preCheck should be a function
    expect(typeof r.governance.preCheck).toBe("function");
  });

  it("populates tenants from the yaml", async () => {
    const cfg = validateConfig({
      version: "1",
      tenants: [
        {
          id: "trading",
          name: "Trading Bots",
          apiKey: "inline://k1",
          dailyBudgetUsd: 1000,
          allowedWallets: ["coinbase-cdp"],
          requireTwoPersonApprovalAboveUsd: 500,
        },
      ],
    });
    const r = await bootstrapFromConfig(cfg, {
      log: () => {},
      resolveSecret: (uri) =>
        uri.startsWith("inline://") ? uri.slice("inline://".length) : undefined,
    });
    const t = await r.tenantStore.findById("trading");
    expect(t?.requireTwoPersonApprovalAboveUsd).toBe(500);
    expect(t?.allowedWallets).toEqual(["coinbase-cdp"]);
  });

  it("skips tenants whose apiKey ref does not resolve", async () => {
    const cfg = validateConfig({
      version: "1",
      tenants: [
        {
          id: "abandoned",
          apiKey: "env://NONEXISTENT_VAR_XYZ_NOPE",
          dailyBudgetUsd: 10,
        },
      ],
    });
    const r = await bootstrapFromConfig(cfg, {
      log: () => {},
      resolveSecret: () => undefined,
    });
    const t = await r.tenantStore.findById("abandoned");
    expect(t).toBe(undefined);
  });
});
