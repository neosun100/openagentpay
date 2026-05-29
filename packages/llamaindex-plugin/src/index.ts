/**
 * @openagentpay/llamaindex-plugin
 *
 * LlamaIndex.TS Tool integration for OpenAgentPay.
 * Compatible with FunctionTool from llamaindex package.
 *
 * @license Apache-2.0
 */
export {
  OpenAgentPayLlamaTool,
  createLlamaPaymentTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "./tool.js";
