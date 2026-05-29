/**
 * @openagentpay/vercel-ai-plugin
 * ===============================
 *
 * Vercel AI SDK tool descriptor. Plugs into `tool()` calls and `streamText`/
 * `generateText`'s `tools: { ... }` map.
 *
 * Vercel AI SDK tool shape (ai 4.x):
 *   {
 *     description: string,
 *     parameters: ZodSchema | JSON Schema,
 *     execute: (args, opts?) => Promise<...>
 *   }
 *
 * We accept both modern (`zod`) and JSON Schema descriptors via the optional
 * `parametersSchema` config. By default we ship a JSON Schema, which the AI
 * SDK accepts directly.
 *
 * Usage:
 *
 *   import { generateText } from "ai";
 *   import { openai } from "@ai-sdk/openai";
 *   import { createVercelAiPaymentTool } from "@openagentpay/vercel-ai-plugin";
 *
 *   const payTool = createVercelAiPaymentTool({ manager, governance, ... });
 *   const result = await generateText({
 *     model: openai("gpt-4o-mini"),
 *     tools: { pay: payTool },
 *     prompt: "...",
 *   });
 *
 * @license Apache-2.0
 */

import {
  OpenAgentPayLlamaTool,
  type CreateLlamaPaymentToolConfig,
  type LlamaPaymentToolInput,
  type LlamaPaymentToolResult,
} from "@openagentpay/llamaindex-plugin";

export type VercelAiPaymentToolInput = LlamaPaymentToolInput;
export type VercelAiPaymentToolResult = LlamaPaymentToolResult;
export type CreateVercelAiPaymentToolConfig = CreateLlamaPaymentToolConfig;

export interface VercelAiToolDescriptor {
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute: (
    args: VercelAiPaymentToolInput,
    options?: { abortSignal?: AbortSignal }
  ) => Promise<VercelAiPaymentToolResult>;
}

const DEFAULT_PARAMETERS: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    amountUsd: {
      type: "number",
      description: "Amount in USD. Settles in USDC at 1:1.",
      exclusiveMinimum: 0,
    },
    recipient: {
      type: "string",
      description: "Recipient address or merchant ID.",
      minLength: 1,
    },
    reason: {
      type: "string",
      description: "Why this payment — surfaces in audit log.",
      minLength: 1,
    },
    walletProvider: {
      type: "string",
      description: "Optional wallet override (defaults to plugin config).",
    },
    mandates: {
      type: "array",
      items: { type: "object" },
      description: "Optional AP2 mandate chain.",
    },
  },
  required: ["amountUsd", "recipient", "reason"],
};

/**
 * Build a Vercel AI SDK tool descriptor. Pass directly into the `tools` map
 * of `generateText` / `streamText` / `useChat`.
 */
export function createVercelAiPaymentTool(
  cfg: CreateVercelAiPaymentToolConfig
): VercelAiToolDescriptor {
  const inner = new OpenAgentPayLlamaTool(cfg);
  return {
    description: inner.description,
    parameters: DEFAULT_PARAMETERS,
    execute: async (
      args: VercelAiPaymentToolInput,
      _opts?: { abortSignal?: AbortSignal }
    ): Promise<VercelAiPaymentToolResult> => {
      return inner.runPayment(args);
    },
  };
}
