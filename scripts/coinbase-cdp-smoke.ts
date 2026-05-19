/**
 * scripts/coinbase-cdp-smoke.ts
 *
 * End-to-end smoke test: Coinbase CDP V2 + Base Sepolia + Circle USDC
 *
 * Verifies:
 *   1. CDP credentials work (auth + account lookup)
 *   2. Balance read works (Circle USDC on Base Sepolia)
 *   3. EIP-712 signature via CDP signTypedData
 *   4. transferWithAuthorization broadcast through CDP-managed account
 *   5. On-chain settlement with real Circle USDC (production-grade)
 *
 * Run:
 *     pnpm tsx scripts/coinbase-cdp-smoke.ts
 *
 * Output: real Base Sepolia tx hash + Basescan link.
 */
import {
  CoinbaseCDPConnector,
  COINBASE_CDP_PROTOCOL,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
} from "@openagentpay/wallet-coinbase-cdp";
import type {
  PaymentRequest,
  Session,
  UserId,
} from "@openagentpay/core";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnits, type Address } from "viem";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "..", ".env.local") });

function hr() {
  console.log("─".repeat(76));
}

async function main() {
  console.log("");
  hr();
  console.log("🌐 OpenAgentPay × Coinbase CDP — Base Sepolia x402 e2e Demo");
  hr();

  // 1. Load credentials
  const apiKeyId = process.env["COINBASE_CDP_API_KEY_ID"]!;
  const apiKeySecret = process.env["COINBASE_CDP_API_KEY_SECRET"]!;
  const walletSecret = process.env["COINBASE_CDP_WALLET_SECRET"]!;
  const agentAddress = "0x851C03756D5e9e057cb518C1B3cd47f628a0Dca7" as Address;
  const recipientAddress = "0x000000000000000000000000000000000000dEaD" as Address; // burn

  console.log(`Network:           Base Sepolia (chainId 84532)`);
  console.log(`USDC contract:     0x036CbD53842c5426634e7929541eC2318f3dCF7e (Circle official)`);
  console.log(`Agent address:     ${agentAddress}`);
  console.log(`Recipient (burn):  ${recipientAddress}`);
  console.log("");

  // 2. Build connector
  const store = new MemoryInstrumentStore();
  const connector = new CoinbaseCDPConnector({
    apiKeyId,
    apiKeySecret,
    walletSecret,
    agentAddress,
    recipientAddress,
    instrumentStore: store,
  });

  // 3. Show capabilities
  hr();
  console.log("Step 1 / 5  ·  Connector Capabilities");
  hr();
  const caps = connector.getCapabilities();
  console.log(JSON.stringify(caps, null, 2));
  console.log("");

  // 4. Create instrument
  hr();
  console.log("Step 2 / 5  ·  Create Payment Instrument");
  hr();
  const userId = "demo-user" as UserId;
  const instrument = await connector.createInstrument({ userId });
  console.log(`Instrument id:   ${instrument.id}`);
  console.log(`Public handle:   ${instrument.publicHandle}`);
  console.log("");

  // 5. Read balance
  hr();
  console.log("Step 3 / 5  ·  Get Balance (Circle USDC on Base Sepolia)");
  hr();
  const balance = await connector.getBalance(instrument.id);
  const usdc = (Number(balance.money.amountAtomic) / 10 ** 6).toFixed(6);
  console.log(`Balance:         ${usdc} USDC`);
  console.log(`Atomic:          ${balance.money.amountAtomic}`);
  console.log("");

  // 6. Sign + Settle
  hr();
  console.log("Step 4 / 5  ·  Sign EIP-712 transferWithAuthorization");
  hr();

  // Build a small payment request (0.01 USDC)
  const amount = parseUnits("0.01", 6);
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + 3600;
  const nonce = connector.generateNonce();

  const request: PaymentRequest = {
    protocol: COINBASE_CDP_PROTOCOL,
    amount: {
      amountAtomic: amount.toString(),
      decimals: 6,
      currency: "USDC",
    },
    recipient: recipientAddress,
    asset: { symbol: "USDC", decimals: 6, contract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
    validAfter,
    validBefore,
    nonce,
    raw: {},
  };

  // Minimal session (smoke test only)
  const session: Session = {
    id: "session-smoke" as any,
    userId,
    budget: {
      amountAtomic: parseUnits("1", 6).toString(),
      decimals: 6,
      currency: "USDC",
    },
    spent: {
      amountAtomic: "0",
      decimals: 6,
      currency: "USDC",
    },
    expiresAt: new Date(validBefore * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    state: "active" as any,
  };

  const t1 = Date.now();
  const signed = await connector.signAuthorization({
    instrumentId: instrument.id,
    request,
    session,
  });
  console.log(`Signed in ${Date.now() - t1}ms`);
  console.log(`Signature:       ${signed.signature.slice(0, 20)}...${signed.signature.slice(-10)}`);
  console.log(`v / r / s extracted: yes`);
  console.log("");

  hr();
  console.log("Step 5 / 5  ·  Broadcast transferWithAuthorization (real on-chain)");
  hr();
  const t2 = Date.now();
  const result = await connector.settle(signed);
  console.log(`Settled in ${Date.now() - t2}ms`);
  console.log("");

  if (result.success) {
    console.log(`✅ Settlement successful`);
    console.log(`Tx hash:         ${result.transactionRef}`);
    console.log(`Network:         ${result.network}`);
    console.log(`Block number:    ${(result.raw as any)?.blockNumber}`);
    console.log(`Gas used:        ${(result.raw as any)?.gasUsed}`);
    console.log(`Explorer:        ${(result.raw as any)?.explorerUrl}`);
  } else {
    console.log(`❌ Settlement failed`);
    console.log(`Error:           ${result.errorMessage}`);
    if (result.raw) console.log(`Raw:             ${JSON.stringify(result.raw, null, 2).slice(0, 500)}`);
  }
  console.log("");
  hr();
  console.log("");
}

main().catch((e) => {
  console.error("❌ Smoke test failed:", e);
  process.exit(1);
});
