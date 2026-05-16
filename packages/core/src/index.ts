/**
 * @openagentpay/core entrypoint
 *
 * Re-exports the canonical type system + lightweight runtime modules
 * (SessionManager). This package contains zero AWS-specific code — it can be
 * safely imported from Lambda handlers, browser bundles, and CDK stacks alike.
 *
 * @license Apache-2.0
 */

export * from "./types.js";
export * from "./session/manager.js";
