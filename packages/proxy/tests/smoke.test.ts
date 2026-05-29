/**
 * Smoke test — verifies the proxy boots, auth gates work, and a request with
 * a valid virtual API key can read /v1/whoami.
 *
 * Uses supertest (already in demo-api dev deps; we add it here too).
 * No real wallet — this only exercises the auth/tenant/route layer.
 *
 * @license Apache-2.0
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createInMemoryPaymentManager } from "@openagentpay/core";
import {
  createProxy,
  generateVirtualApiKey,
  InMemoryTenantStore,
  type Tenant,
} from "../src/index.js";

describe("proxy auth + whoami smoke", () => {
  let key: string;
  let server: ReturnType<typeof createProxy>;
  let store: InMemoryTenantStore;

  beforeAll(async () => {
    store = new InMemoryTenantStore();
    const apiKey = generateVirtualApiKey();
    key = apiKey.plaintext;

    const tenant: Tenant = {
      id: "test-tenant",
      name: "Test Tenant",
      apiKeyHash: apiKey.hash,
      allowedWallets: ["hashkey"],
      allowedProtocols: [],
      dailyBudgetUsd: 10,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
    };
    await store.put(tenant);

    server = createProxy({
      paymentManager: createInMemoryPaymentManager({
        resolveInstrument: async () => undefined,
        connectors: [],
      }),
      tenantStore: store,
    });
  });

  it("rejects requests without an API key", async () => {
    const r = await request(server.app).get("/v1/whoami");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("missing_api_key");
  });

  it("rejects an unknown API key", async () => {
    const r = await request(server.app)
      .get("/v1/whoami")
      .set("Authorization", "Bearer oap_sk_NONEXISTENT");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("invalid_api_key");
  });

  it("returns whoami for a valid key", async () => {
    const r = await request(server.app)
      .get("/v1/whoami")
      .set("Authorization", `Bearer ${key}`);
    expect(r.status).toBe(200);
    expect(r.body.tenantId).toBe("test-tenant");
    expect(r.body.dailyBudgetUsd).toBe(10);
    expect(r.body.allowedWallets).toEqual(["hashkey"]);
  });

  it("/v1/health is public", async () => {
    const r = await request(server.app).get("/v1/health");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("blocks tenants exceeding daily budget on session creation", async () => {
    const r = await request(server.app)
      .post("/v1/sessions")
      .set("Authorization", `Bearer ${key}`)
      .send({ budgetUsd: 100, expiresMinutes: 30 });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("exceeds_daily_budget");
  });

  it("blocks instrument creation for non-allowed wallets", async () => {
    const r = await request(server.app)
      .post("/v1/instruments")
      .set("Authorization", `Bearer ${key}`)
      .send({ walletProvider: "binance-pay" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("wallet_not_allowed");
  });

  it("suspends tenants are 403'd everywhere", async () => {
    await store.suspend("test-tenant");
    const r = await request(server.app)
      .get("/v1/whoami")
      .set("Authorization", `Bearer ${key}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("tenant_suspended");
  });
});
