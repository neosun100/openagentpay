/**
 * @openagentpay/wallet-binance — Public entrypoint.
 *
 * Exports BinancePayClient (low-level REST) and BinancePayConnector
 * (WalletConnector-conformant high-level wrapper).
 *
 * @license Apache-2.0
 */

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
