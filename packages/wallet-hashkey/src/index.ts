/**
 * @openagentpay/wallet-hashkey public entrypoint.
 *
 * @license Apache-2.0
 */

// Chain configuration
export {
  hashkeyChainMainnet,
  hashkeyChainTestnet,
  HASHKEY_MAINNET_TOKENS,
  HASHKEY_TESTNET_MOCK_USDC,
  txExplorerUrl,
  addressExplorerUrl,
} from "./chain.js";

// Token client (low-level)
export {
  HashKeyChainTokenClient,
  EIP3009_USDC_ABI,
  EIP712_TYPES,
  generateNonce,
  createWalletClientFromPrivateKey,
  type Eip3009Authorization,
  type Eip3009SignedAuthorization,
  type HashKeyChainTokenClientConfig,
} from "./token-client.js";

// WalletConnector (high-level, OpenAgentPay interface)
export {
  HashKeyChainConnector,
  WALLET_PROVIDER_ID,
  HASHKEY_PROTOCOL,
  MemoryInstrumentStore,
  type HashKeyChainConnectorConfig,
  type InstrumentStore,
} from "./connector.js";
