/**
 * Loader — read + validate `openagentpay.yaml` files (or strings).
 *
 * @license Apache-2.0
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  OpenAgentPayConfigSchema,
  type OpenAgentPayConfig,
} from "./schema.js";

// ============================================================================
//  Errors
// ============================================================================

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    message: string,
    public readonly issues?: ReadonlyArray<{ path: string; message: string }>
  ) {
    super(message);
  }
}

// ============================================================================
//  Public API
// ============================================================================

export interface LoadOptions {
  /** When true (default), apply environment-variable overlays after parse. */
  readonly applyEnvOverrides?: boolean;
  /** Optional strict mode — fail if any unknown keys present. */
  readonly strict?: boolean;
}

/**
 * Load a config from a yaml file path. Throws ConfigError on missing file
 * or invalid schema.
 */
export function loadConfig(
  path: string,
  options: LoadOptions = {}
): OpenAgentPayConfig {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new ConfigError(`config file not found: ${abs}`);
  }
  const text = readFileSync(abs, "utf8");
  return loadConfigFromString(text, options);
}

/**
 * Load a config from a yaml string (for tests / programmatic use).
 */
export function loadConfigFromString(
  yaml: string,
  options: LoadOptions = {}
): OpenAgentPayConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (err) {
    throw new ConfigError(
      `yaml parse error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const cfg = validateConfig(parsed, options);
  if (options.applyEnvOverrides ?? true) {
    return applyEnvOverrides(cfg);
  }
  return cfg;
}

/**
 * Validate a parsed JS object against the schema. Returns the typed config or
 * throws ConfigError with a structured `issues[]` array.
 */
export function validateConfig(
  raw: unknown,
  _options: LoadOptions = {}
): OpenAgentPayConfig {
  const result = OpenAgentPayConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    throw new ConfigError(
      `config validation failed (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
      issues
    );
  }
  return result.data;
}

/**
 * Build a minimal valid config skeleton. Useful for `oap config init`.
 */
export function defaultConfig(): OpenAgentPayConfig {
  return validateConfig({
    version: "1",
    deployment: { env: "dev" },
    wallets: [],
    protocols: [],
    governance: {
      policies: [],
      compliance: { checkers: [] },
      audit: { sinks: [{ kind: "console", config: {}, secrets: {} }] },
    },
    routing: {
      strategy: "priority",
      fallback: [],
      retry: { maxAttempts: 3, backoffMs: [500, 2000, 5000] },
    },
    tenants: [],
  });
}

// ============================================================================
//  Env-override helper
// ============================================================================

/**
 * Apply environment variable overrides:
 *   OAP_DEPLOYMENT_ENV=prod         → deployment.env
 *   OAP_DEPLOYMENT_REGION=us-east-1 → deployment.region
 *   OAP_ROUTING_STRATEGY=...        → routing.strategy
 */
function applyEnvOverrides(cfg: OpenAgentPayConfig): OpenAgentPayConfig {
  const env = process.env;
  let next = cfg;
  if (env["OAP_DEPLOYMENT_ENV"]) {
    next = {
      ...next,
      deployment: {
        ...next.deployment,
        env: env["OAP_DEPLOYMENT_ENV"] as "dev" | "staging" | "prod",
      },
    };
  }
  if (env["OAP_DEPLOYMENT_REGION"]) {
    next = {
      ...next,
      deployment: { ...next.deployment, region: env["OAP_DEPLOYMENT_REGION"] },
    };
  }
  if (env["OAP_ROUTING_STRATEGY"]) {
    next = {
      ...next,
      routing: {
        ...next.routing,
        strategy: env["OAP_ROUTING_STRATEGY"] as never,
      },
    };
  }
  return next;
}
