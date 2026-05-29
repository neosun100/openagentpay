/**
 * @openagentpay/langgraph-plugin (TS) — for @langchain/langgraph
 * ================================================================
 *
 * LangGraph treats tools as graph nodes (each with a runnable). Our adapter
 * exposes:
 *   1. A `Runnable`-shaped node (mirrors LangChain.js StructuredTool).
 *   2. A pure async function (for vanilla LangGraph nodes).
 *
 * For Python LangGraph we ship `openagentpay-langgraph` (separate uv package
 * — see packages/langgraph-plugin/python/ in the repo root).
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type LanggraphPaymentInput = LlamaPaymentToolInput;
export type LanggraphPaymentResult = LlamaPaymentToolResult;
export type CreateLanggraphPaymentToolConfig = CreateLlamaPaymentToolConfig;

/**
 * The shape LangGraph TS expects for a callable graph node:
 *   {
 *     name: string,
 *     description: string,
 *     schema: Record<string, unknown>,   // JSON Schema
 *     invoke(input): Promise<output>,
 *   }
 */
export interface LanggraphNodeDescriptor {
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, unknown>;
  invoke(input: LanggraphPaymentInput): Promise<LanggraphPaymentResult>;
}

const NODE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    amountUsd: { type: "number" },
    recipient: { type: "string" },
    reason: { type: "string" },
    walletProvider: { type: "string" },
    mandates: { type: "array", items: { type: "object" } },
  },
  required: ["amountUsd", "recipient", "reason"],
};

/**
 * Build a LangGraph node descriptor. Wire into a graph:
 *
 *   import { StateGraph } from "@langchain/langgraph";
 *   import { createLanggraphPaymentNode } from "@openagentpay/langgraph-plugin";
 *
 *   const payNode = createLanggraphPaymentNode({ manager, governance, ... });
 *   const graph = new StateGraph(...)
 *     .addNode("pay", payNode.invoke)
 *     .addEdge("decide", "pay")
 *     .compile();
 */
export function createLanggraphPaymentNode(
  cfg: CreateLanggraphPaymentToolConfig
): LanggraphNodeDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    name: "openagentpay_pay",
    description: inner.description,
    schema: NODE_SCHEMA,
    invoke: async (input: LanggraphPaymentInput): Promise<LanggraphPaymentResult> => {
      return inner.runPayment(input);
    },
  };
}
