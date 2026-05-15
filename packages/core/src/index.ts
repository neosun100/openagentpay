/**
 * @openagentpay/core entrypoint
 *
 * Re-exports the canonical type system. This package contains zero runtime
 * dependencies — types only — so it can be safely imported from Lambda
 * handlers, browser bundles, and CDK stacks alike.
 *
 * @license Apache-2.0
 */

export * from "./types.js";
