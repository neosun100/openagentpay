/**
 * HashKey Chain network configuration constants.
 *
 * Source: https://docs.hsk.xyz/docs/Build-on-HashKey-Chain/network-info
 *
 * @license Apache-2.0
 */

import type { Chain } from "viem";

// ============================================================================
//  Chain definitions (viem-compatible)
// ============================================================================

/** HashKey Chain Mainnet — chainId 177 */
export const hashkeyChainMainnet: Chain = {
  id: 177,
  name: "HashKey Chain",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://mainnet.hsk.xyz"] },
    public: { http: ["https://mainnet.hsk.xyz"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://hashkey.blockscout.com" },
  },
};

/** HashKey Chain Testnet — chainId 133 */
export const hashkeyChainTestnet: Chain = {
  id: 133,
  name: "HashKey Chain Testnet",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet.hsk.xyz"] },
    public: { http: ["https://testnet.hsk.xyz"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://testnet-explorer.hsk.xyz" },
  },
  testnet: true,
};

// ============================================================================
//  Token contract addresses
// ============================================================================

/**
 * Known token addresses on HashKey Chain Mainnet.
 * Testnet has its own MockUSDC deployed by OpenAgentPay (see scripts/hashkey/).
 *
 * Source: https://docs.hsk.xyz/docs/Build-on-HashKey-Chain/Token-Contracts
 */
export const HASHKEY_MAINNET_TOKENS = {
  /** Wrapped HSK (ERC20 form of native HSK) */
  WHSK: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
  /** Wrapped ETH (OptimismMintableERC20) */
  WETH: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0",
  /** USDT (OptimismMintableERC20) */
  USDT: "0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029",
  /** Wrapped BTC (OptimismMintableERC20) */
  WBTC: "0x6119ca49a79f5825c8b345f8d7ac36b272565b14",
  /** Bridged USDC */
  USDC: "0x054ed45810DbBAb8B27668922D110669c9D88D0a",
} as const;

/**
 * MockUSDC deployed by OpenAgentPay on HashKey Chain Testnet for demo purposes.
 * This is the contract `scripts/hashkey/MockUSDC.sol` deployed via `deploy.py`.
 *
 * The contract implements full EIP-3009 with same typehashes as Circle USDC,
 * so any x402-compatible flow that works against Circle USDC on Base works
 * here unchanged (only chainId + verifyingContract differ).
 *
 * Production note: replace with official Circle USDC address on HashKey Chain
 * mainnet when Circle deploys there.
 */
export const HASHKEY_TESTNET_MOCK_USDC =
  "0x0685C487Df4Cc0723Aa828C299686798294E9803" as const;

// ============================================================================
//  Helpers
// ============================================================================

/** Get the explorer URL for a tx hash. */
export function txExplorerUrl(chain: Chain, txHash: string): string {
  const base = chain.blockExplorers?.default?.url;
  if (!base) throw new Error(`No block explorer configured for chain ${chain.id}`);
  return `${base}/tx/${txHash.startsWith("0x") ? txHash : "0x" + txHash}`;
}

/** Get the explorer URL for an address. */
export function addressExplorerUrl(chain: Chain, address: string): string {
  const base = chain.blockExplorers?.default?.url;
  if (!base) throw new Error(`No block explorer configured for chain ${chain.id}`);
  return `${base}/address/${address}`;
}
