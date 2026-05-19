/**
 * Base Sepolia chain config (Coinbase CDP target network)
 * Chain ID: 84532
 * Circle USDC official contract: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
 */
import type { Chain } from "viem";

export const BASE_SEPOLIA_CHAIN: Chain = {
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: {
    decimals: 18,
    name: "Ether",
    symbol: "ETH",
  },
  rpcUrls: {
    default: { http: ["https://sepolia.base.org"] },
    public: { http: ["https://sepolia.base.org"] },
  },
  blockExplorers: {
    default: {
      name: "Basescan Sepolia",
      url: "https://sepolia.basescan.org",
    },
  },
  testnet: true,
};

/** Circle USDC official contract on Base Sepolia */
export const BASE_SEPOLIA_USDC_ADDRESS =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

/** USDC has 6 decimals on Base Sepolia (matches mainnet) */
export const USDC_DECIMALS = 6;

/** EIP-712 domain for USDC EIP-3009 signatures on Base Sepolia */
export const USDC_EIP712_DOMAIN = {
  name: "USDC",
  version: "2",
  chainId: 84532,
  verifyingContract: BASE_SEPOLIA_USDC_ADDRESS,
} as const;
