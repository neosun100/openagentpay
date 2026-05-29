/**
 * @openagentpay/proxy — public entry point.
 *
 * Public surface:
 *   - createProxy()             → Express app factory (mountable in any host)
 *   - InMemoryTenantStore       → in-memory tenant + virtual API key store
 *   - generateVirtualApiKey()   → mint a fresh oap_sk_xxx
 *   - virtualApiKeyAuth()       → middleware (rarely used directly)
 *   - getAuth(req)              → typed accessor for the auth context
 *
 * For a runnable CLI, use the `oap-proxy` binary or import `./cli.js`.
 *
 * @license Apache-2.0
 */

export { createProxy, type CreateProxyConfig, type ProxyApp } from "./server.js";
export {
  type Tenant,
  type TenantStore,
  type VirtualApiKey,
  InMemoryTenantStore,
  generateVirtualApiKey,
  hashApiKey,
} from "./tenant.js";
export {
  virtualApiKeyAuth,
  getAuth,
  type AuthContext,
  type AuthedRequest,
  type VirtualApiKeyAuthConfig,
} from "./auth.js";
export {
  bootstrapFromConfig,
  type BootstrapResult,
  type BootstrapOptions,
} from "./configBootstrap.js";
