/**
 * @openagentpay/protocol-ap2 public entrypoint.
 *
 * @license Apache-2.0
 */
export {
  Ap2ProtocolAdapter,
  NullMandateVerifier,
  PROTOCOL_ID,
  X_PAYMENT_AP2_HEADER,
  SUPPORTED_AP2_VERSIONS,
  buildIntentMandate,
  buildCartMandate,
  buildPaymentMandate,
  type Ap2402Body,
  type Ap2ProtocolAdapterConfig,
  type MandateVerifier,
} from "./adapter.js";
