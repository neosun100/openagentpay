/**
 * @openagentpay/mastra-plugin
 * ===========================
 *
 * Mastra-shaped Tool wrapper. Mastra (https://mastra.ai) tools have shape:
 *   { id, description, inputSchema, execute({ context }) }
 *
 * We delegate the payment heavy-lifting to @openagentpay/llamaindex-plugin's
 * `OpenAgentPayLlamaTool` (same logic; framework-neutral) and expose a
 * Mastra-shaped descriptor.
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type MastraPaymentToolInput = LlamaPaymentToolInput;
export type MastraPaymentToolResult = LlamaPaymentToolResult;
export type CreateMastraPaymentToolConfig = CreateLlamaPaymentToolConfig;

export interface MastraToolDescriptor {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  execute: (args: { context: MastraPaymentToolInput }) => Promise<MastraPaymentToolResult>;
}

const PARAMETERS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    amountUsd: { type: "number", description: "Amount in USD; settles in USDC." },
    recipient: { type: "string", description: "0x… or merchant id." },
    reason: { type: "string", description: "Audit-log reason." },
    walletProvider: { type: "string", description: "Optional wallet override." },
    mandates: {
      type: "array",
      items: { type: "object" },
      description: "Optional AP2 mandate chain.",
    },
  },
  required: ["amountUsd", "recipient", "reason"],
};

/**
 * Build a Mastra-shaped tool. Plug into Mastra:
 *
 *   import { Agent } from "@mastra/core";
 *   import { createMastraPaymentTool } from "@openagentpay/mastra-plugin";
 *   const payTool = createMastraPaymentTool({ manager, governance, ... });
 *   new Agent({ ..., tools: { pay: payTool } });
 */
export function createMastraPaymentTool(
  cfg: CreateMastraPaymentToolConfig
): MastraToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    id: "openagentpay_pay",
    description: inner.description,
    inputSchema: PARAMETERS_JSON_SCHEMA,
    execute: async ({ context }: { context: MastraPaymentToolInput }) => {
      return inner.runPayment(context);
    },
  };
}
