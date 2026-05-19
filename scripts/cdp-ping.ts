/**
 * Coinbase CDP API ping — verify credentials + create EVM account.
 */
import { CdpClient } from "@coinbase/cdp-sdk";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "..", ".env.local") });

async function main() {
  const apiKeyId = process.env.COINBASE_CDP_API_KEY_ID!;
  const apiKeySecret = process.env.COINBASE_CDP_API_KEY_SECRET!;
  const walletSecret = process.env.COINBASE_CDP_WALLET_SECRET!;

  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    throw new Error("CDP credentials incomplete in .env.local");
  }

  const cdp = new CdpClient({ apiKeyId, apiKeySecret, walletSecret });

  console.log("=== 1. List existing EVM accounts ===");
  const list = await cdp.evm.listAccounts();
  console.log(`  Found ${list.accounts.length} account(s):`);
  for (const a of list.accounts) {
    console.log(`    - ${a.address}  name=${a.name ?? "(unnamed)"}`);
  }

  let agentAccount;
  if (list.accounts.length === 0) {
    console.log("\n=== 2. Create new EVM account ===");
    agentAccount = await cdp.evm.createAccount({ name: "openagentpay-cdp-agent" });
    console.log(`  ✅ Created: ${agentAccount.address}`);
    console.log(`     Name:   ${agentAccount.name}`);
  } else {
    console.log("\n=== 2. Reusing first account ===");
    agentAccount = list.accounts[0];
    console.log(`  ✅ Reusing: ${agentAccount.address}`);
  }

  console.log("\n=== 3. Save address to console ===");
  console.log(`     Network: Base Sepolia testnet`);
  console.log(`     Address: ${agentAccount.address}`);
  console.log(`     Faucet:  https://docs.cdp.coinbase.com/faucets/overview`);
  console.log(`              or  https://faucet.circle.com/  (USDC)`);

  console.log("\n✅ CDP wallet ready");
}

main().catch((e) => {
  console.error("\n❌ Failed:", e.message);
  if (e.response?.data) console.error("  Details:", JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
