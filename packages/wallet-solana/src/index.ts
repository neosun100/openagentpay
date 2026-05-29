/**
 * @openagentpay/wallet-solana public entrypoint.
 *
 * Provides BOTH a ProtocolAdapter (for parsing Solana Pay 402 responses)
 * and a WalletConnector (for executing the payment). They're packaged
 * together because both halves are required to use Solana — no other
 * existing OpenAgentPay package adapts the Solana Pay protocol.
 *
 * @license Apache-2.0
 */

export {
  // Protocol layer
  SolanaPayProtocolAdapter,
  parseSolanaPayUrl,
  buildSolanaPayUrl,
  // Wallet layer
  SolanaConnector,
  DemoSolanaSigner,
  MemoryInstrumentStore,
  // Constants
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_SOLANA_HEADER,
  // Types
  type SolanaPayAdapterConfig,
  type SolanaPayUrlFields,
  type SolanaConnectorConfig,
  type SolanaSigner,
  type InstrumentStore,
} from "./connector.js";
