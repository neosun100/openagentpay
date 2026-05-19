/**
 * scripts/langchain-demo.ts
 *
 * Demonstrates @openagentpay/langchain-plugin in action:
 *
 *   1. Build a real PaymentManager + governance + 1 wallet (HashKey)
 *   2. Wrap it as a LangChain StructuredTool
 *   3. Invoke the tool directly (no LLM), simulating an Agent's tool call
 *   4. Show the JSON result the LLM would receive
 *
 * NOT a real LLM agent — that requires OPENAI_API_KEY + dependencies.
 * This shows the plugin works with HashKey Chain Testnet for real on-chain payment.
 *
 * Run:
 *     node --experimental-strip-types --no-warnings scripts/langchain-demo.ts
 *
 * Reads .env.local for HASHKEY_TESTNET_AGENT_PRIVATE_KEY.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryPaymentManager,
  InMemorySessionManager,
  type UserId,
  type WalletProviderId,
} from "@openagentpay/core";
import {
  HashKeyChainConnector,
  HashKeyChainTokenClient,
  MemoryInstrumentStore,
  hashkeyChainTestnet,
  HASHKEY_PROTOCOL,
} from "@openagentpay/wallet-hashkey";
import {
  GovernanceManager,
  InMemoryAuditSink,
  InMemoryPolicyEngine,
  StaticSanctionsChecker,
  DEMO_SANCTIONS_LIST,
  amountThreshold,
} from "@openagentpay/governance";
import { createPaymentTool } from "@openagentpay/langchain-plugin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.local
const envPath = join(__dirname, "..", ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trim = line.trim();
    if (!trim || trim.startsWith("#")) continue;
    const eq = trim.indexOf("=");
    if (eq < 0) continue;
    const k = trim.slice(0, eq).trim();
    const v = trim
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

function hr() {
  console.log("─".repeat(80));
}

async function main() {
  console.log("");
  hr();
  console.log("🤖 OpenAgentPay × LangChain Plugin — Live Demo");
  hr();

  // 1. Build PaymentManager + HashKey Connector
  const pk = process.env["HASHKEY_TESTNET_AGENT_PRIVATE_KEY"];
  const tokenAddress = process.env["HASHKEY_USDC_ADDRESS"];
  if (!pk || !tokenAddress) {
    console.error("❌ HASHKEY_TESTNET_AGENT_PRIVATE_KEY + HASHKEY_USDC_ADDRESS required");
    process.exit(1);
  }

  const sessionManager = new InMemorySessionManager();
  const store = new MemoryInstrumentStore();
  const tokenClient = new HashKeyChainTokenClient({
    tokenAddress: tokenAddress as `0x${string}`,
    chain: hashkeyChainTestnet,
  });
  const connector = new HashKeyChainConnector({
    privateKey: (pk.startsWith("0x") ? pk : "0x" + pk) as `0x${string}`,
    tokenAddress: tokenAddress as `0x${string}`,
    instrumentStore: store,
    tokenClient,
  });
  const manager = new InMemoryPaymentManager({
    sessionManager,
    resolveInstrument: async (id) => store.getById(id),
  });
  manager.registerConnector(connector);

  // 2. Build Governance (Layer 3 + 5 + 7)
  const policyEngine = new InMemoryPolicyEngine();
  policyEngine.use(amountThreshold({ maxAtomic: "10000000" })); // $10 cap
  const auditSink = new InMemoryAuditSink(100);
  const governance = new GovernanceManager({
    policyEngine,
    complianceChecker: new StaticSanctionsChecker([DEMO_SANCTIONS_LIST]),
    auditSink,
  });

  // 3. Wrap as LangChain Tool
  const tool = createPaymentTool({
    manager,
    governance,
    userId: "demo-agent" as UserId,
    defaultWalletProvider: connector
      .getCapabilities()
      .walletProvider as WalletProviderId,
    defaultSessionBudgetUsd: 1, // $1 hard cap for demo
    defaultSessionExpiryMinutes: 5,
    resolveProtocolForWallet: () => HASHKEY_PROTOCOL,
  });

  console.log("");
  console.log(`Tool ready:`);
  console.log(`  name: ${tool.name}`);
  console.log(`  description (first 100 chars): ${tool.description.slice(0, 100)}…`);
  console.log("");

  // 4. Test 1: Allowed payment
  hr();
  console.log("Test 1 / 3 · Allowed payment ($0.001 USDC) — expect success + tx hash");
  hr();
  const r1 = await tool.runPayment({
    amountUsd: 0.001,
    recipient: "0x" + "a".repeat(40), // throwaway recipient
    reason: "Pay for market data API access (LangChain agent action)",
  });
  console.log(JSON.stringify(r1, null, 2));

  // 5. Test 2: Policy deny
  hr();
  console.log("Test 2 / 3 · Over-budget payment ($100) — expect amountThreshold deny");
  hr();
  const r2 = await tool.runPayment({
    amountUsd: 100,
    recipient: "0x" + "b".repeat(40),
    reason: "Buy enterprise data feed (way over cap)",
  });
  console.log(JSON.stringify(r2, null, 2));

  // 6. Test 3: Compliance deny
  hr();
  console.log("Test 3 / 3 · Sanctioned recipient — expect compliance deny");
  hr();
  const r3 = await tool.runPayment({
    amountUsd: 0.001,
    recipient: "0x8589427373d6d84e98730d7795d8f6f8731fda16", // Tornado Cash
    reason: "Pay sanctioned address (should be blocked)",
  });
  console.log(JSON.stringify(r3, null, 2));

  // 7. Show audit log
  hr();
  console.log(`📜 Audit log (${auditSink.size()} events):`);
  hr();
  for (const e of auditSink.readAll()) {
    console.log(
      `  ${e.timestamp.slice(11, 19)}  ${e.kind.padEnd(20)}  ${e.result.padEnd(10)}  ${e.reason ?? ""}`.trim()
    );
  }

  hr();
  console.log("");
  console.log("✅ LangChain plugin demo complete.");
  console.log("");
  console.log("Real use:");
  console.log("  const agent = await initializeAgentExecutorWithOptions(");
  console.log("    [tool, ...otherTools],");
  console.log('    new ChatOpenAI({ modelName: "gpt-4o-mini" }),');
  console.log('    { agentType: "openai-functions" }');
  console.log("  );");
  console.log("  await agent.invoke({ input: 'Pay $0.001 USDC to 0x... for the market data report' });");
  console.log("");
  hr();
}

main().catch((err) => {
  console.error("❌ Demo failed:", err);
  process.exit(1);
});
