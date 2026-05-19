/**
 * @openagentpay/langchain-plugin
 *
 * Layer 1 (Framework Plugin) for OpenAgentPay.
 *
 * Wraps PaymentManager + Governance into a LangChain `StructuredTool` that
 * any LangChain Agent (OpenAI Functions / Anthropic / Bedrock / etc.) can
 * call autonomously to make payments.
 *
 * Quick start:
 *
 * ```typescript
 * import { ChatOpenAI } from "@langchain/openai";
 * import { initializeAgentExecutorWithOptions } from "langchain/agents";
 * import { createPaymentTool } from "@openagentpay/langchain-plugin";
 *
 * const tool = createPaymentTool({
 *   manager,                 // PaymentManager (from @openagentpay/core)
 *   governance,              // GovernanceManager (optional, recommended)
 *   userId: "alice" as UserId,
 *   defaultWalletProvider: "coinbase-cdp" as WalletProviderId,
 *   defaultSessionBudgetUsd: 5,    // hard cap per session
 *   defaultSessionExpiryMinutes: 30,
 *   recentPayments: [],            // shared buffer for velocity policies
 * });
 *
 * const agent = await initializeAgentExecutorWithOptions(
 *   [tool, ...otherTools],
 *   new ChatOpenAI({ modelName: "gpt-4o-mini" }),
 *   { agentType: "openai-functions" }
 * );
 *
 * await agent.invoke({
 *   input: "Use the data API at api.example.com to fetch market analysis. Pay if needed."
 * });
 * ```
 *
 * @license Apache-2.0
 */

export { OpenAgentPayTool, createPaymentTool } from "./tool.js";

export type {
  CreatePaymentToolConfig,
  PaymentToolInput,
  PaymentToolResult,
  SessionHandle,
} from "./types.js";

export {
  defaultMoney,
  defaultAsset,
  defaultNonce,
  DEFAULT_BUDGET_USD,
  DEFAULT_EXPIRY_MIN,
} from "./types.js";
