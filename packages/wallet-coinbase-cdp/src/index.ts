/**
 * @openagentpay/wallet-coinbase-cdp
 *
 * Coinbase CDP V2 wallet connector for OpenAgentPay.
 * Targets Base Sepolia testnet with Circle's official USDC contract.
 *
 * Use this connector when you want to leverage CDP's managed wallet
 * service (CDP secures private keys via TEE) for the EVM/x402 path.
 *
 * Pairs with @openagentpay/wallet-hashkey for the "path D hybrid":
 *   HashKey Chain (Asia, mock USDC)  +  Coinbase CDP (NA, Circle USDC)
 *   sharing the same WalletConnector interface.
 *
 * @license Apache-2.0
 */
export {
  CoinbaseCDPConnector,
  MemoryInstrumentStore,
  WALLET_PROVIDER_ID,
  COINBASE_CDP_PROTOCOL,
  type CoinbaseCDPConnectorConfig,
  type InstrumentStore,
} from "./connector.js";

export {
  BASE_SEPOLIA_CHAIN,
  BASE_SEPOLIA_USDC_ADDRESS,
  USDC_DECIMALS,
  USDC_EIP712_DOMAIN,
} from "./chain.js";
