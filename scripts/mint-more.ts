/**
 * scripts/mint-more.ts — 给 agent 钱包 mint 更多 MockUSDC
 *
 * 用法：
 *   pnpm tsx scripts/mint-more.ts             # 默认 mint 5000 USDC
 *   pnpm tsx scripts/mint-more.ts 10000       # mint 10000 USDC
 *
 * 前置：
 *   .env.local 里有 HASHKEY_TESTNET_AGENT_PRIVATE_KEY
 */
import { createWalletClient, createPublicClient, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "..", ".env.local") });

const USDC_CONTRACT = "0x0685C487Df4Cc0723Aa828C299686798294E9803" as const;
const RPC_URL = "https://testnet.hsk.xyz";

const HASHKEY_CHAIN = {
  id: 133,
  name: "HashKey Chain Testnet",
  nativeCurrency: { decimals: 18, name: "HSK", symbol: "HSK" },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

const ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
]);

async function main() {
  const amount = process.argv[2] ? parseInt(process.argv[2], 10) : 5000;
  const pk = process.env.HASHKEY_TESTNET_AGENT_PRIVATE_KEY;
  if (!pk) throw new Error("HASHKEY_TESTNET_AGENT_PRIVATE_KEY missing in .env.local");

  const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`);

  const wallet = createWalletClient({ account, chain: HASHKEY_CHAIN, transport: http() });
  const publicClient = createPublicClient({ chain: HASHKEY_CHAIN, transport: http() });

  // Check balance before
  const balBefore = await publicClient.readContract({
    address: USDC_CONTRACT,
    abi: ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`Before: ${Number(balBefore) / 1e6} USDC`);

  // Mint
  const amountWei = parseUnits(String(amount), 6);
  console.log(`Minting ${amount} USDC to ${account.address} ...`);
  const txHash = await wallet.writeContract({
    address: USDC_CONTRACT,
    abi: ABI,
    functionName: "mint",
    args: [account.address, amountWei],
  });
  console.log(`Tx: ${txHash}`);
  console.log(`Explorer: https://testnet-explorer.hsk.xyz/tx/${txHash}`);

  // Wait for confirmation
  console.log("Waiting for confirmation...");
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  // Check balance after
  const balAfter = await publicClient.readContract({
    address: USDC_CONTRACT,
    abi: ABI,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`After:  ${Number(balAfter) / 1e6} USDC  (+${(Number(balAfter) - Number(balBefore)) / 1e6})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
