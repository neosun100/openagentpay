/**
 * Self-contained wallet bundles — the 11 connectors added in v0.11 that need
 * NO external credentials. Each generates a real testnet keypair in-process
 * (Ed25519 / secp256k1 / BIP39) and registers unconditionally, so the demo-web
 * capability bar shows the full multi-chain matrix out of the box.
 *
 * This is the literal demonstration of OpenAgentPay's core claim: switch the
 * `walletProvider` and the same business code now pays on Stellar instead of
 * Solana, Sui instead of TRON — one click, zero code change.
 *
 * On-chain broadcast stays behind each connector's pluggable hook (offline-safe
 * defaults), so these bundles are demo-safe without funded faucets. When Neo
 * funds a testnet account, swap the generated keypair for a real secret via the
 * matching env var and the same bundle settles on-chain.
 *
 * @license Apache-2.0
 */

import type { WalletConnector } from "@openagentpay/core";
import type { ConnectorBundle } from "./context.js";

import {
  SolanaConnector,
  RealSolanaSigner,
  MemoryInstrumentStore as SolanaStore,
} from "@openagentpay/wallet-solana";
import {
  StellarConnector,
  RealStellarSigner,
  MemoryInstrumentStore as StellarStore,
} from "@openagentpay/wallet-stellar";
import {
  HederaConnector,
  RealHederaSigner,
  MemoryInstrumentStore as HederaStore,
} from "@openagentpay/wallet-hedera";
import {
  SuiConnector,
  RealSuiSigner,
  MemoryInstrumentStore as SuiStore,
} from "@openagentpay/wallet-sui";
import {
  AptosConnector,
  RealAptosSigner,
  MemoryInstrumentStore as AptosStore,
} from "@openagentpay/wallet-aptos";
import {
  TronConnector,
  RealTronSigner,
  MemoryInstrumentStore as TronStore,
} from "@openagentpay/wallet-tron";
import {
  CosmosConnector,
  RealCosmosSigner,
  MemoryInstrumentStore as CosmosStore,
} from "@openagentpay/wallet-cosmos";
import {
  StripePrivyConnector,
  createEmbeddedWallet,
  generateEmbeddedWalletKey,
  MemoryInstrumentStore as PrivyStore,
} from "@openagentpay/wallet-stripe-privy";
import {
  CircleConnector,
  generateEntitySecret,
  MemoryInstrumentStore as CircleStore,
} from "@openagentpay/wallet-circle";
import {
  MagicConnector,
  MemoryInstrumentStore as MagicStore,
} from "@openagentpay/wallet-magic";
import {
  ZeroDevConnector,
  RealZeroDevSigner,
  MemoryInstrumentStore as ZeroDevStore,
} from "@openagentpay/wallet-zerodev";

// ----------------------------------------------------------------------------
//  Bundle helper — fills ConnectorBundle metadata for a self-contained wallet
// ----------------------------------------------------------------------------
function bundleOf(opts: {
  connector: WalletConnector;
  agentAddress: string;
  chainName: string;
  chainId: number;
  tokenLabel: string;
  tokenAddress: string;
  tokenDecimals: number;
  addressExplorer: (addr: string) => string;
  txExplorer: (hash: string) => string;
}): ConnectorBundle {
  const caps = opts.connector.getCapabilities();
  return {
    walletProvider: caps.walletProvider,
    displayName: caps.displayName,
    connector: opts.connector,
    addressExplorer: opts.addressExplorer,
    txExplorer: opts.txExplorer,
    chainName: opts.chainName,
    chainId: opts.chainId,
    tokenAddress: opts.tokenAddress,
    tokenDecimals: opts.tokenDecimals,
    tokenLabel: opts.tokenLabel,
    agentAddress: opts.agentAddress,
  };
}

/**
 * Build all 11 self-contained connector bundles. Each instantiates its
 * connector with a freshly-generated in-process testnet keypair.
 */
export function buildSelfContainedBundles(): ConnectorBundle[] {
  const bundles: ConnectorBundle[] = [];

  // --- Solana (Ed25519 base58, Solana Pay) ---
  {
    const signer = new RealSolanaSigner({ cluster: "devnet" });
    const connector = new SolanaConnector({
      signer,
      instrumentStore: new SolanaStore(),
      cluster: "devnet",
    });
    bundles.push(
      bundleOf({
        connector,
        agentAddress: signer.address,
        chainName: "Solana Devnet",
        chainId: 0,
        tokenLabel: "USDC (Solana)",
        tokenAddress: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr",
        tokenDecimals: 6,
        addressExplorer: (a) =>
          `https://explorer.solana.com/address/${a}?cluster=devnet`,
        txExplorer: (h) => `https://explorer.solana.com/tx/${h}?cluster=devnet`,
      })
    );
  }

  // --- Stellar (Ed25519 StrKey, SEP-31) ---
  {
    const signer = new RealStellarSigner({ network: "testnet" });
    const connector = new StellarConnector({
      signer,
      instrumentStore: new StellarStore(),
      network: "testnet",
    });
    bundles.push(
      bundleOf({
        connector,
        agentAddress: signer.address,
        chainName: "Stellar Testnet",
        chainId: 0,
        tokenLabel: "USDC (Stellar)",
        tokenAddress: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        tokenDecimals: 7,
        addressExplorer: (a) =>
          `https://stellar.expert/explorer/testnet/account/${a}`,
        txExplorer: (h) => `https://stellar.expert/explorer/testnet/tx/${h}`,
      })
    );
  }

  // --- Hedera (Ed25519, HCS) ---
  {
    const signer = new RealHederaSigner({ network: "testnet" });
    const connector = new HederaConnector({
      signer,
      instrumentStore: new HederaStore(),
      network: "testnet",
    });
    bundles.push(
      bundleOf({
        connector,
        agentAddress: signer.accountId,
        chainName: "Hedera Testnet",
        chainId: 0,
        tokenLabel: "USDC (HTS 0.0.456858)",
        tokenAddress: "0.0.456858",
        tokenDecimals: 6,
        addressExplorer: (a) =>
          `https://hashscan.io/testnet/account/${a}`,
        txExplorer: (h) => `https://hashscan.io/testnet/transaction/${h}`,
      })
    );
  }

  // --- Sui (Ed25519 blake2b, Sui Pay) ---
  {
    const signer = new RealSuiSigner({ network: "devnet" });
    const connector = new SuiConnector({
      signer,
      instrumentStore: new SuiStore(),
      network: "devnet",
    });
    bundles.push(
      bundleOf({
        connector,
        agentAddress: signer.address,
        chainName: "Sui Devnet",
        chainId: 0,
        tokenLabel: "USDC (Sui)",
        tokenAddress: "0x...::usdc::USDC",
        tokenDecimals: 6,
        addressExplorer: (a) =>
          `https://suiscan.xyz/devnet/account/${a}`,
        txExplorer: (h) => `https://suiscan.xyz/devnet/tx/${h}`,
      })
    );
  }

  // --- Aptos (Ed25519 sha3, Aptos Pay) ---
  {
    const signer = new RealAptosSigner({ network: "devnet" });
    const connector = new AptosConnector({
      signer,
      instrumentStore: new AptosStore(),
      network: "devnet",
    });
    bundles.push(
      bundleOf({
        connector,
        agentAddress: signer.address,
        chainName: "Aptos Devnet",
        chainId: 0,
        tokenLabel: "USDC (Aptos)",
        tokenAddress: "0x...::usdc::USDC",
        tokenDecimals: 6,
        addressExplorer: (a) =>
          `https://explorer.aptoslabs.com/account/${a}?network=devnet`,
        txExplorer: (h) =>
          `https://explorer.aptoslabs.com/txn/${h}?network=devnet`,
      })
    );
  }

  // --- TRON (secp256k1 base58check, USDT-TRC20) ---
  {
    const signer = new RealTronSigner({ network: "shasta" });
    const connector = new TronConnector({
      signer,
      instrumentStore: new TronStore(),
      network: "shasta",
    });
    bundles.push(
      bundleOf({
        connector,
        agentAddress: signer.address,
        chainName: "TRON Shasta",
        chainId: 0,
        tokenLabel: "USDT-TRC20",
        tokenAddress: "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs",
        tokenDecimals: 6,
        addressExplorer: (a) => `https://shasta.tronscan.org/#/address/${a}`,
        txExplorer: (h) => `https://shasta.tronscan.org/#/transaction/${h}`,
      })
    );
  }

  // --- Cosmos (secp256k1 bech32 + BIP39, IBC) ---
  {
    const signer = new RealCosmosSigner({});
    const connector = new CosmosConnector({
      signer,
      instrumentStore: new CosmosStore(),
    });
    bundles.push(
      bundleOf({
        connector,
        agentAddress: signer.address,
        chainName: "Cosmos Theta Testnet",
        chainId: 0,
        tokenLabel: "ATOM (uatom)",
        tokenAddress: "uatom",
        tokenDecimals: 6,
        addressExplorer: (a) =>
          `https://www.mintscan.io/cosmoshub-testnet/account/${a}`,
        txExplorer: (h) => `https://www.mintscan.io/cosmoshub-testnet/tx/${h}`,
      })
    );
  }

  // --- Stripe Privy (EVM managed, Base Sepolia) ---
  {
    const privyConfig = {
      appId: "demo-privy-app",
      appSecret: "demo-privy-secret",
      privateKey: generateEmbeddedWalletKey(),
    };
    const embedded = createEmbeddedWallet(privyConfig);
    const connector = new StripePrivyConnector({
      privy: privyConfig,
      instrumentStore: new PrivyStore(),
    });
    bundles.push(
      bundleOf({
        connector,
        agentAddress: embedded.wallet.address,
        chainName: "Base Sepolia",
        chainId: 84532,
        tokenLabel: "USDC (Circle)",
        tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        tokenDecimals: 6,
        addressExplorer: (a) => `https://sepolia.basescan.org/address/${a}`,
        txExplorer: (h) => `https://sepolia.basescan.org/tx/${h}`,
      })
    );
  }

  // --- Circle Programmable Wallets (EVM, USDC-native + gas station) ---
  {
    const entitySecret = generateEntitySecret();
    const connector = new CircleConnector({
      apiKey: "TEST_API_KEY:demo",
      entitySecret,
      network: "base-sepolia",
      instrumentStore: new CircleStore(),
    });
    bundles.push(
      bundleOf({
        connector,
        agentAddress: connector.walletAddress,
        chainName: "Base Sepolia",
        chainId: 84532,
        tokenLabel: "USDC (Circle gas-station)",
        tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        tokenDecimals: 6,
        addressExplorer: (a) => `https://sepolia.basescan.org/address/${a}`,
        txExplorer: (h) => `https://sepolia.basescan.org/tx/${h}`,
      })
    );
  }

  // --- Magic.link (EVM email-based, Base Sepolia) ---
  {
    const connector = new MagicConnector({
      agentEmail: "agent+oap@openagentpay.dev",
      instrumentStore: new MagicStore(),
    });
    bundles.push(
      bundleOf({
        connector,
        agentAddress: connector.walletAddress,
        chainName: "Base Sepolia",
        chainId: 84532,
        tokenLabel: "USDC (email wallet)",
        tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        tokenDecimals: 6,
        addressExplorer: (a) => `https://sepolia.basescan.org/address/${a}`,
        txExplorer: (h) => `https://sepolia.basescan.org/tx/${h}`,
      })
    );
  }

  // --- ZeroDev (EVM ERC-4337 smart account, Base Sepolia) ---
  {
    const signer = new RealZeroDevSigner({});
    const connector = new ZeroDevConnector({
      signer,
      instrumentStore: new ZeroDevStore(),
      sponsoredGas: true,
    });
    bundles.push(
      bundleOf({
        connector,
        agentAddress: connector.smartAccountAddress,
        chainName: "Base Sepolia",
        chainId: 84532,
        tokenLabel: "USDC (smart account)",
        tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        tokenDecimals: 6,
        addressExplorer: (a) => `https://sepolia.basescan.org/address/${a}`,
        txExplorer: (h) => `https://sepolia.basescan.org/tx/${h}`,
      })
    );
  }

  return bundles;
}
