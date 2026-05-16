/**
 * @openagentpay/wallet-binance public entrypoint.
 *
 * Re-exports both the low-level REST client and the high-level WalletConnector.
 *
 * @license Apache-2.0
 */

// REST client
export {
  BinancePayClient,
  BinancePayError,
  type BinancePayClientConfig,
  type CreateOrderInput,
  type CreateOrderResponse,
  type QueryOrderInput,
  type QueryOrderResponse,
  type QueryBalanceInput,
  type QueryBalanceResponse,
} from "./binance-client.js";

// WalletConnector
export {
  BinancePayConnector,
  WALLET_PROVIDER_ID,
  MemoryInstrumentStore,
  type BinancePayConnectorConfig,
  type InstrumentStore,
} from "./connector.js";
