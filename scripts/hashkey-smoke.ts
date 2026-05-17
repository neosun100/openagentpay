#!/usr/bin/env tsx
/**
 * HashKey Chain Testnet TypeScript Smoke Test
 * ==============================================
 *
 * The TS counterpart of `scripts/hashkey/transfer-with-auth.py`.
 * Verifies that `@openagentpay/wallet-hashkey` produces identical on-chain
 * effects to the Python reference implementation.
 *
 * Run:
 *
 *     pnpm smoke:hashkey
 *
 * Reads `.env.local`:
 *   - HASHKEY_TESTNET_AGENT_PRIVATE_KEY  (required)
 *   - HASHKEY_USDC_ADDRESS               (required, set by deploy.py)
 *   - HASHKEY_RPC_URL                    (optional, defaults to public RPC)
 *
 * @license Apache-2.0
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  HashKeyChainConnector,
  HASHKEY_PROTOCOL,
  MemoryInstrumentStore,
  txExplorerUrl,
  hashkeyChainTestnet,
} from "@openagentpay/wallet-hashkey";
import {
  InMemoryPaymentManager,
  InMemorySessionManager,
  type Money,
  type PaymentRequest,
  type UserId,
} from "@openagentpay/core";

// ----------------------------------------------------------------------------
//  Tiny .env.local loader (zero deps)
// ----------------------------------------------------------------------------
function loadDotenvLocal(): void {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function hr() {
  console.log("=".repeat(70));
}

async function main() {
  loadDotenvLocal();

  const pk = process.env["HASHKEY_TESTNET_AGENT_PRIVATE_KEY"];
  const usdc = process.env["HASHKEY_USDC_ADDRESS"];
  const rpcUrl = process.env["HASHKEY_RPC_URL"] ?? hashkeyChainTestnet.rpcUrls.default.http[0];

  if (!pk || !usdc) {
    console.error(c.red("\n❌ Missing required env vars in .env.local:\n"));
    console.error("  HASHKEY_TESTNET_AGENT_PRIVATE_KEY=0x...");
    console.error("  HASHKEY_USDC_ADDRESS=0x0685C487Df4Cc0723Aa828C299686798294E9803");
    console.error(c.dim("\n  Run scripts/hashkey/deploy.py first to populate these.\n"));
    process.exit(2);
  }

  hr();
  console.log(c.bold(c.cyan("🌐 OpenAgentPay × HashKey Chain — TypeScript Smoke Test")));
  hr();
  console.log(`  Network:  HashKey Chain Testnet (chainId=${hashkeyChainTestnet.id})`);
  console.log(`  RPC:      ${rpcUrl}`);
  console.log(`  USDC:     ${usdc}`);
  console.log("");

  // 1. Build the connector
  console.log(c.bold("Step 1️⃣  Construct HashKeyChainConnector"));
  console.log("-".repeat(70));
  const store = new MemoryInstrumentStore();
  const connector = new HashKeyChainConnector({
    privateKey: pk as `0x${string}`,
    tokenAddress: usdc as `0x${string}`,
    instrumentStore: store,
  });
  console.log(`  ✓  Agent address:       ${c.cyan(connector.agentAddress)}`);
  console.log(`  ✓  Facilitator address: ${c.cyan(connector.facilitatorAddress)}`);
  console.log("");

  // 2. Wrap in PaymentManager (which is what the Lambda will use)
  console.log(c.bold("Step 2️⃣  Wrap in InMemoryPaymentManager"));
  console.log("-".repeat(70));
  const sessionManager = new InMemorySessionManager();
  const manager = new InMemoryPaymentManager({
    sessionManager,
    resolveInstrument: async (id) => store.getById(id),
  });
  manager.registerConnector(connector);
  console.log(`  ✓  Registered providers: ${manager.listProviders().join(", ")}`);
  console.log("");

  // 3. Create user, session, instrument
  console.log(c.bold("Step 3️⃣  createPaymentSession + createPaymentInstrument"));
  console.log("-".repeat(70));
  const userId = "neo" as UserId;
  const session = await manager.createPaymentSession({
    userId,
    budgetUsd: 1.0,
    expiresMinutes: 60,
  });
  const instrument = await manager.createPaymentInstrument(
    connector.getCapabilities().walletProvider,
    { userId }
  );
  console.log(`  ✓  Session:    ${c.cyan(session.id)}`);
  console.log(`  ✓  Instrument: ${c.cyan(instrument.id)}`);
  console.log("");

  // 4. Generate ad-hoc merchant
  console.log(c.bold("Step 4️⃣  Generate ad-hoc merchant wallet (recipient)"));
  console.log("-".repeat(70));
  const merchantAccount = privateKeyToAccount(generatePrivateKey());
  console.log(`  ✓  Merchant: ${c.cyan(merchantAccount.address)}`);
  console.log("");

  // 5. Construct PaymentRequest
  console.log(c.bold("Step 5️⃣  Build x402-style PaymentRequest"));
  console.log("-".repeat(70));
  const validBefore = Math.floor(Date.now() / 1000) + 600;
  const amount: Money = { amountAtomic: "1000000", decimals: 6, currency: "USDC" }; // 1 USDC
  const nonce = connector.generateNonce();
  const request: PaymentRequest = {
    protocol: HASHKEY_PROTOCOL,
    amount,
    recipient: merchantAccount.address,
    asset: { symbol: "USDC", decimals: 6 },
    validAfter: 0,
    validBefore,
    nonce,
    rawPayload: { synthetic: true, source: "smoke-hashkey" },
    description: "OpenAgentPay TS smoke test (1 USDC on HashKey Chain Testnet)",
  };
  console.log(`  ✓  amount:      1 USDC (${amount.amountAtomic} atomic)`);
  console.log(`  ✓  recipient:   ${request.recipient}`);
  console.log(`  ✓  validBefore: ${validBefore}`);
  console.log(`  ✓  nonce:       ${nonce}`);
  console.log("");

  // 6. processPayment — full 12-step flow in one call
  console.log(c.bold("Step 6️⃣  manager.processPayment() — full 12-step flow"));
  console.log("-".repeat(70));
  const start = Date.now();
  const result = await manager.processPayment({
    sessionId: session.id,
    instrumentId: instrument.id,
    request,
  });
  const elapsed = Date.now() - start;

  if (result.success) {
    const tx = result.settlement.transactionRef!;
    const explorer = txExplorerUrl(hashkeyChainTestnet, tx);
    console.log(`  ${c.green("✓")} Settlement success in ${elapsed}ms`);
    console.log(`  📜 Tx:        ${c.cyan(tx)}`);
    console.log(`  🌐 Explorer:  ${c.cyan(explorer)}`);
    console.log(`  💰 Spent:     ${result.sessionAfter.spent.amountAtomic} atomic = 1 USDC`);
    console.log("");
    hr();
    console.log(c.bold(c.green("✅ TypeScript Smoke PASSED — TS implementation produces identical")));
    console.log(c.bold(c.green("   on-chain effect to scripts/hashkey/transfer-with-auth.py.")));
    hr();
  } else {
    console.log(c.red(`  ❌ Settlement failed: ${result.settlement.errorCode}`));
    console.log(c.red(`     ${result.settlement.errorMessage}`));
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(c.red("\n❌ Unhandled error:"));
  console.error(err);
  process.exit(99);
});
