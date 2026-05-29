#!/usr/bin/env node
/**
 * `oap-proxy` — minimal CLI entrypoint.
 *
 * Today this script just demonstrates how to wire the proxy with an
 * InMemoryPaymentManager + InMemoryTenantStore. Real deployments will:
 *   1. Construct PaymentManager from openagentpay.yaml (Wave 1 item #3).
 *   2. Use DynamoDB / Postgres-backed TenantStore in production.
 *   3. Hook into AWS Secrets Manager for wallet private keys.
 *
 * Today's run-mode is pure demo:
 *   pnpm --filter @openagentpay/proxy start
 *   # → http://localhost:8788 with one hard-coded sandbox tenant
 *
 * @license Apache-2.0
 */

import { createInMemoryPaymentManager } from "@openagentpay/core";
import {
  AuditLogger,
  GovernanceManager,
  InMemoryAuditSink,
  InMemoryPolicyEngine,
  StaticSanctionsChecker,
  amountThreshold,
  velocityLimit,
  DEMO_SANCTIONS_LIST,
} from "@openagentpay/governance";

import { createProxy } from "./server.js";
import {
  InMemoryTenantStore,
  generateVirtualApiKey,
} from "./tenant.js";

const PORT = Number(process.env["PORT"] ?? 8788);

async function main(): Promise<void> {
  // ---- Wire a minimal PaymentManager (no real wallets in this demo CLI) ----
  // Real deployments will load wallets from openagentpay.yaml.
  const paymentManager = createInMemoryPaymentManager({
    resolveInstrument: async () => undefined,
    connectors: [],
  });

  // ---- Wire governance (Layer 3 + 5 + 7) ----
  const policyEngine = new InMemoryPolicyEngine();
  policyEngine.use(amountThreshold({ maxAtomic: "50000000" })); // $50
  policyEngine.use(velocityLimit({ windowMs: 60_000, maxCount: 20 }));

  const governance = new GovernanceManager({
    policyEngine,
    complianceChecker: new StaticSanctionsChecker([DEMO_SANCTIONS_LIST]),
    auditSink: new InMemoryAuditSink(500),
  });

  // ---- Provision one demo tenant + virtual API key ----
  const tenantStore = new InMemoryTenantStore();
  const apiKey = generateVirtualApiKey();
  await tenantStore.put({
    id: "demo-tenant",
    name: "Demo Tenant",
    apiKeyHash: apiKey.hash,
    allowedWallets: [],
    allowedProtocols: [],
    dailyBudgetUsd: 100,
    sandboxOnly: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
  });

  // ---- Build the Express app ----
  const { app } = createProxy({
    paymentManager,
    governance,
    tenantStore,
    auth: { anonymousAllowed: false },
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "╔══════════════════════════════════════════════════════════════════╗",
        "║  OpenAgentPay Proxy (alpha) — listening                           ║",
        `║  Port: ${PORT.toString().padEnd(60)}║`,
        "║                                                                  ║",
        "║  Demo tenant API key (save it — shown only once):                 ║",
        `║  ${apiKey.plaintext.padEnd(64)}║`,
        "║                                                                  ║",
        "║  Try:                                                            ║",
        `║    curl -H "Authorization: Bearer ${apiKey.plaintext}" \\       ║`,
        `║      http://localhost:${PORT}/v1/whoami                         ║`,
        "╚══════════════════════════════════════════════════════════════════╝",
        "",
      ].join("\n")
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
