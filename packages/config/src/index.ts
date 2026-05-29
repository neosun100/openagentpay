/**
 * @openagentpay/config — public entry point.
 *
 * Public surface:
 *   - `loadConfig(path | string)` → typed OpenAgentPayConfig
 *   - `validateConfig(unknown)` → returns parsed config or throws ConfigError
 *   - `OpenAgentPayConfigSchema` (zod schema) for further extension
 *   - `defaultConfig()` → blank skeleton, useful for `oap config init`
 *
 * @license Apache-2.0
 */

export {
  OpenAgentPayConfigSchema,
  WalletDeclSchema,
  ProtocolDeclSchema,
  PolicyDeclSchema,
  TenantDeclSchema,
  RoutingDeclSchema,
  type OpenAgentPayConfig,
  type WalletDecl,
  type ProtocolDecl,
  type PolicyDecl,
  type TenantDecl,
  type RoutingDecl,
} from "./schema.js";

export {
  loadConfig,
  loadConfigFromString,
  validateConfig,
  defaultConfig,
  ConfigError,
  type LoadOptions,
} from "./loader.js";
