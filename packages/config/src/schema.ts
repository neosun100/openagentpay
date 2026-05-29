/**
 * Schema for `openagentpay.yaml` — the declarative configuration that wires
 * wallets / protocols / policies / governance / tenants.
 *
 * Designed to be the LiteLLM `config.yaml` analog: an ops engineer reads it
 * and knows exactly what wallets are live, what limits apply, and which
 * tenants can use what — without reading any TypeScript.
 *
 * Backed by `zod` for runtime validation and to derive a TypeScript type.
 *
 * @license Apache-2.0
 */

import { z } from "zod";

// ============================================================================
//  Sub-schemas
// ============================================================================

/** Reference to a secret. Resolved at boot time by SecretResolver. */
const SecretRef = z
  .string()
  .regex(
    /^(env|aws-secretsmanager|file|gcp-sm|inline):\/\/[^\s]+$/,
    "secret ref must be one of: env://VAR, aws-secretsmanager://NAME, file:///path, gcp-sm://NAME, inline://VALUE"
  )
  .describe(
    "Secret reference URI. The loader resolves env://X by reading process.env.X; aws-secretsmanager://NAME by SDK; file:///path by reading the file; inline://VALUE for tests."
  );

/** A registered wallet provider. */
export const WalletDeclSchema = z.object({
  /** Stable wallet provider id matching what the connector reports. */
  provider: z.string().min(1),
  /** Optional display name (UI). */
  name: z.string().optional(),
  /** Wallet-class — drives which @openagentpay/wallet-* package is loaded. */
  module: z
    .string()
    .min(1)
    .describe("npm package name, e.g. @openagentpay/wallet-hashkey"),
  /** Wallet-specific config (free-form, validated by the wallet package). */
  config: z.record(z.unknown()).default({}),
  /** Where to read sensitive values from. */
  secrets: z.record(SecretRef).default({}),
  /** Optional capability overrides (rare). */
  capabilities: z
    .object({
      asset: z.string().optional(),
      chain: z.string().optional(),
      sandboxOnly: z.boolean().optional(),
    })
    .optional(),
});
export type WalletDecl = z.infer<typeof WalletDeclSchema>;

/** A registered protocol adapter. */
export const ProtocolDeclSchema = z.object({
  id: z.string().min(1).describe("ProtocolId, e.g. x402-v1"),
  module: z.string().min(1),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
});
export type ProtocolDecl = z.infer<typeof ProtocolDeclSchema>;

/** A policy expression. The `kind` discriminates the rest of the body. */
export const PolicyDeclSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("amountThreshold"),
    maxUsd: z.number().positive(),
    currency: z.string().optional(),
  }),
  z.object({
    kind: z.literal("velocityLimit"),
    windowSeconds: z.number().positive(),
    maxCount: z.number().int().positive().optional(),
    maxAmountUsd: z.number().positive().optional(),
  }),
  z.object({
    kind: z.literal("merchantWhitelist"),
    addresses: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal("merchantBlacklist"),
    addresses: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal("walletProviderWhitelist"),
    providers: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal("timeOfDay"),
    startHourUtc: z.number().int().min(0).max(23),
    endHourUtc: z.number().int().min(0).max(23),
  }),
]);
export type PolicyDecl = z.infer<typeof PolicyDeclSchema>;

/** Governance / compliance / audit setup. */
const GovernanceDeclSchema = z.object({
  policies: z.array(PolicyDeclSchema).default([]),
  compliance: z
    .object({
      checkers: z
        .array(
          z.object({
            kind: z.enum([
              "static-sanctions",
              "chainalysis-kyt",
              "trm-labs",
              "elliptic",
              "ofac-sdn",
            ]),
            config: z.record(z.unknown()).default({}),
            secrets: z.record(SecretRef).default({}),
          })
        )
        .default([]),
    })
    .default({ checkers: [] }),
  audit: z
    .object({
      sinks: z
        .array(
          z.object({
            kind: z.enum([
              "in-memory",
              "console",
              "dynamodb",
              "s3-worm",
              "opensearch",
              "splunk",
            ]),
            config: z.record(z.unknown()).default({}),
            secrets: z.record(SecretRef).default({}),
          })
        )
        .default([{ kind: "console", config: {}, secrets: {} }]),
    })
    .default({ sinks: [{ kind: "console", config: {}, secrets: {} }] }),
});

/** Wallet routing strategy. */
export const RoutingDeclSchema = z.object({
  strategy: z
    .enum(["priority", "least-cost", "least-latency", "round-robin", "user-affinity"])
    .default("priority"),
  fallback: z.array(z.string()).default([]),
  retry: z
    .object({
      maxAttempts: z.number().int().positive().default(3),
      backoffMs: z.array(z.number().int().nonnegative()).default([500, 2000, 5000]),
    })
    .default({ maxAttempts: 3, backoffMs: [500, 2000, 5000] }),
});
export type RoutingDecl = z.infer<typeof RoutingDeclSchema>;

/** A multi-tenant team / cost-center / agent. */
export const TenantDeclSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  apiKey: SecretRef.describe("Secret ref to the virtual API key plaintext"),
  allowedWallets: z.array(z.string()).default([]),
  allowedProtocols: z.array(z.string()).default([]),
  dailyBudgetUsd: z.number().positive(),
  monthlyBudgetUsd: z.number().positive().optional(),
  requireTwoPersonApprovalAboveUsd: z.number().positive().optional(),
  sandboxOnly: z.boolean().default(false),
  metadata: z.record(z.string()).default({}),
});
export type TenantDecl = z.infer<typeof TenantDeclSchema>;

// ============================================================================
//  Top-level schema
// ============================================================================

export const OpenAgentPayConfigSchema = z.object({
  version: z.literal("1").describe("Schema version. Currently only '1'."),
  /** Optional deployment metadata. */
  deployment: z
    .object({
      name: z.string().optional(),
      env: z.enum(["dev", "staging", "prod"]).default("dev"),
      region: z.string().optional(),
    })
    .default({ env: "dev" }),
  wallets: z.array(WalletDeclSchema).default([]),
  protocols: z.array(ProtocolDeclSchema).default([]),
  governance: GovernanceDeclSchema.default({
    policies: [],
    compliance: { checkers: [] },
    audit: { sinks: [{ kind: "console", config: {}, secrets: {} }] },
  }),
  routing: RoutingDeclSchema.default({
    strategy: "priority",
    fallback: [],
    retry: { maxAttempts: 3, backoffMs: [500, 2000, 5000] },
  }),
  tenants: z.array(TenantDeclSchema).default([]),
});

export type OpenAgentPayConfig = z.infer<typeof OpenAgentPayConfigSchema>;
