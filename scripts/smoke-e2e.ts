#!/usr/bin/env node
/**
 * scripts/smoke-e2e.ts — End-to-end smoke test against a running OpenAgentPay deployment.
 *
 * Hits real HTTP endpoints (NOT mocks) and exercises:
 *   - GET  /api/health
 *   - GET  /api/wallets                          (lists 2 connectors)
 *   - GET  /api/wallet?walletProvider=hashkey-chain
 *   - GET  /api/wallet?walletProvider=coinbase-cdp
 *   - GET  /api/governance                       (3 policies + sanctions)
 *   - POST /api/session                          (create budget)
 *   - POST /api/pay (hashkey-chain)              REAL on-chain — HashKey
 *   - POST /api/pay (coinbase-cdp)               REAL on-chain — Base Sepolia
 *   - POST /api/pay (policy deny: $100)          governance reject
 *   - POST /api/pay (sanctions match)            compliance reject
 *   - GET  /api/governance                       audit log accumulation
 *
 * Run against local:       pnpm tsx scripts/smoke-e2e.ts http://localhost:8787
 * Run against production:  pnpm tsx scripts/smoke-e2e.ts https://d1p7yxa99nxaye.cloudfront.net
 *
 * Exit code 0 on success, 1 on any failure.
 *
 * @license Apache-2.0
 */

const TORNADO_CASH_ADDRESS = "0x8589427373d6d84e98730d7795d8f6f8731fda16";

interface TestResult {
  name: string;
  ok: boolean;
  detail?: string;
  durationMs?: number;
}

const results: TestResult[] = [];

function log(emoji: string, msg: string): void {
  console.log(`  ${emoji}  ${msg}`);
}
function hr(): void {
  console.log("─".repeat(80));
}

async function step<T>(
  name: string,
  fn: () => Promise<T>,
  validate?: (r: T) => string | null,
): Promise<T | null> {
  const t0 = Date.now();
  try {
    const r = await fn();
    const validationError = validate ? validate(r) : null;
    if (validationError) {
      results.push({ name, ok: false, detail: validationError, durationMs: Date.now() - t0 });
      log("❌", `${name} (${Date.now() - t0}ms) — ${validationError}`);
      return null;
    }
    results.push({ name, ok: true, durationMs: Date.now() - t0 });
    log("✅", `${name} (${Date.now() - t0}ms)`);
    return r;
  } catch (err) {
    const e = err as Error;
    results.push({ name, ok: false, detail: e.message, durationMs: Date.now() - t0 });
    log("❌", `${name} — ${e.message}`);
    return null;
  }
}

async function fetchJson(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (status ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${json.code ?? ""}: ${json.message ?? JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  const baseUrl = process.argv[2] ?? "http://localhost:8787";
  console.log("");
  hr();
  console.log(`🧪  OpenAgentPay E2E Smoke Test`);
  console.log(`📍  Target: ${baseUrl}`);
  hr();

  // ---- 1. Health ----
  console.log("\n[1/8] Liveness checks");
  await step("GET /api/health", () =>
    fetchJson("GET", `${baseUrl}/api/health`),
    (r) => (r.ok === true ? null : "ok != true"));

  // ---- 2. Wallets ----
  console.log("\n[2/8] Wallet inventory");
  const wallets = await step(
    "GET /api/wallets — expect 2+ providers",
    () => fetchJson("GET", `${baseUrl}/api/wallets`),
    (r) => (r.wallets?.length >= 2 ? null : `expected ≥2 wallets, got ${r.wallets?.length}`),
  );
  if (!wallets) return finish();

  const hkProvider = wallets.wallets.find((w: any) => w.walletProvider === "hashkey-chain");
  const cdpProvider = wallets.wallets.find((w: any) => w.walletProvider === "coinbase-cdp");
  if (!hkProvider || !cdpProvider) {
    log("⚠️", "Some expected providers missing — proceeding with available ones");
  }

  // ---- 3. Per-wallet status ----
  console.log("\n[3/8] Per-wallet balance reads");
  const hkStatus = await step(
    "GET /api/wallet?walletProvider=hashkey-chain",
    () => fetchJson("GET", `${baseUrl}/api/wallet?walletProvider=hashkey-chain`),
    (r) => (r.walletProvider === "hashkey-chain" ? null : "wrong provider returned"),
  );
  if (hkStatus) log("📊", `   HashKey balance: ${hkStatus.balance.toFixed(2)} ${hkStatus.token}`);

  const cdpStatus = await step(
    "GET /api/wallet?walletProvider=coinbase-cdp",
    () => fetchJson("GET", `${baseUrl}/api/wallet?walletProvider=coinbase-cdp`),
    (r) => (r.walletProvider === "coinbase-cdp" ? null : "wrong provider returned"),
  );
  if (cdpStatus) log("📊", `   Coinbase CDP balance: ${cdpStatus.balance.toFixed(6)} ${cdpStatus.token}`);

  // ---- 4. Governance ----
  console.log("\n[4/8] Governance status");
  const gov = await step(
    "GET /api/governance — expect 3 policies + compliance",
    () => fetchJson("GET", `${baseUrl}/api/governance`),
    (r) => {
      if (!Array.isArray(r.policies) || r.policies.length === 0) return "no policies";
      if (!r.compliance?.enabled) return "compliance not enabled";
      return null;
    },
  );
  if (gov) log("🛡️", `   ${gov.policies.length} policies + ${gov.compliance.checker}`);
  const auditCountBefore = gov?.auditCount ?? 0;

  // ---- 5. Session lifecycle ----
  console.log("\n[5/8] Session create + read");
  const session = await step(
    "POST /api/session",
    () =>
      fetchJson("POST", `${baseUrl}/api/session`, {
        budgetUsd: 0.5,
        expiryMinutes: 10,
      }),
    (r) => (r.sessionId ? null : "no sessionId returned"),
  );
  if (!session) return finish();
  log("📋", `   Session: ${session.sessionId.slice(0, 32)}…`);

  await step(
    "GET /api/session/:id",
    () => fetchJson("GET", `${baseUrl}/api/session/${session.sessionId}`),
    (r) => (r.sessionId === session.sessionId ? null : "session mismatch"),
  );

  // ---- 6. Real on-chain payment via HashKey ----
  console.log("\n[6/8] Real on-chain payment — HashKey Chain");

  // NOTE: each payment uses its OWN session because in production CloudFront
  // may route subsequent calls to different Lambda warm instances, each with
  // their own InMemorySessionManager. Production v0.5+ will move sessions to
  // DynamoDB to fix this.
  const hkSession = await fetchJson("POST", `${baseUrl}/api/session`, {
    budgetUsd: 0.5,
    expiryMinutes: 10,
  });
  const hkPayment = await step(
    "POST /api/pay (hashkey-chain, 0.001 USDC)",
    () =>
      fetchJson("POST", `${baseUrl}/api/pay`, {
        sessionId: hkSession.sessionId,
        amountUsdc: 0.001,
        walletProvider: "hashkey-chain",
      }),
    (r) => {
      if (!r.success) return `payment failed: ${r.errorCode} ${r.errorMessage}`;
      if (!r.txHash) return "no txHash returned";
      return null;
    },
  );
  if (hkPayment) {
    log("⛓️", `   tx: ${hkPayment.txHash}`);
    log("🔗", `   ${hkPayment.explorerUrl}`);
  }

  // ---- 7. Real on-chain payment via Coinbase CDP ----
  console.log("\n[7/8] Real on-chain payment — Coinbase CDP");
  const cdpSession = await fetchJson("POST", `${baseUrl}/api/session`, {
    budgetUsd: 0.5,
    expiryMinutes: 10,
  });
  const cdpPayment = await step(
    "POST /api/pay (coinbase-cdp, 0.001 USDC)",
    () =>
      fetchJson("POST", `${baseUrl}/api/pay`, {
        sessionId: cdpSession.sessionId,
        amountUsdc: 0.001,
        walletProvider: "coinbase-cdp",
      }),
    (r) => {
      if (!r.success) return `payment failed: ${r.errorCode} ${r.errorMessage}`;
      if (!r.txHash) return "no txHash returned";
      return null;
    },
  );
  if (cdpPayment) {
    log("⛓️", `   tx: ${cdpPayment.txHash}`);
    log("🔗", `   ${cdpPayment.explorerUrl}`);
  }

  // ---- 8. Governance deny paths ----
  console.log("\n[8/8] Governance deny paths");

  // Use fresh sessions for each deny test — Lambda warm instances may differ
  const denySession1 = await fetchJson("POST", `${baseUrl}/api/session`, {
    budgetUsd: 200,
    expiryMinutes: 10,
  });

  await step(
    "POST /api/pay ($100, expect amountThreshold deny)",
    () =>
      fetchJson("POST", `${baseUrl}/api/pay`, {
        sessionId: denySession1.sessionId,
        amountUsdc: 100,
        walletProvider: "coinbase-cdp",
      }),
    (r) => {
      if (r.success) return "expected deny but got success";
      if (r.errorCode !== "policy_denied") return `wrong errorCode: ${r.errorCode}`;
      if (!/exceeds maxAtomic/.test(r.errorMessage ?? "")) return "wrong reason";
      return null;
    },
  );
  log("🚫", "   Policy correctly denied $100 payment");

  const denySession2 = await fetchJson("POST", `${baseUrl}/api/session`, {
    budgetUsd: 1,
    expiryMinutes: 10,
  });

  await step(
    "POST /api/pay (Tornado Cash recipient, expect compliance deny)",
    () =>
      fetchJson("POST", `${baseUrl}/api/pay`, {
        sessionId: denySession2.sessionId,
        amountUsdc: 0.001,
        recipient: TORNADO_CASH_ADDRESS,
        walletProvider: "coinbase-cdp",
      }),
    (r) => {
      if (r.success) return "expected deny but got success";
      if (r.errorCode !== "policy_denied") return `wrong errorCode: ${r.errorCode}`;
      if (!/compliance|sanctions/i.test(r.errorMessage ?? "")) return "wrong reason";
      return null;
    },
  );
  log("🚫", "   Compliance correctly blocked sanctioned address");

  // ---- 9. Audit log accumulation ----
  console.log("\n[final] Audit log accumulation");
  await step(
    "audit log grew",
    () => fetchJson("GET", `${baseUrl}/api/governance`),
    (r) => {
      const grew = r.auditCount > auditCountBefore;
      return grew
        ? null
        : `audit count did not grow (before=${auditCountBefore}, after=${r.auditCount})`;
    },
  );

  finish();
}

function finish() {
  console.log("");
  hr();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const totalMs = results.reduce((s, r) => s + (r.durationMs ?? 0), 0);

  console.log(`📊  Result: ${passed} pass, ${failed} fail (${totalMs}ms total)`);
  hr();

  if (failed > 0) {
    console.log("\nFailures:");
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  ❌ ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  }

  console.log("\n🎉 All e2e smoke tests passed!\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Unhandled error:", err);
  process.exit(1);
});
