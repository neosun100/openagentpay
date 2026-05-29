/**
 * @openagentpay/config tests — schema + loader.
 */

import { describe, it, expect } from "vitest";
import {
  ConfigError,
  defaultConfig,
  loadConfigFromString,
  validateConfig,
} from "../src/index.js";

const VALID_YAML = `
version: "1"
deployment:
  name: test-deployment
  env: dev
  region: us-east-1

wallets:
  - provider: hashkey
    module: "@openagentpay/wallet-hashkey"
    config:
      tokenAddress: "0x0685C487Df4Cc0723Aa828C299686798294E9803"
    secrets:
      privateKey: "env://HASHKEY_TESTNET_AGENT_PRIVATE_KEY"
  - provider: coinbase-cdp
    module: "@openagentpay/wallet-coinbase-cdp"
    config:
      agentAddress: "0xabc"
    secrets:
      apiKeyId: "env://COINBASE_CDP_API_KEY_ID"
      apiKeySecret: "env://COINBASE_CDP_API_KEY_SECRET"
      walletSecret: "env://COINBASE_CDP_WALLET_SECRET"

protocols:
  - id: "x402-v1"
    module: "@openagentpay/protocol-x402"
    enabled: true
  - id: "ap2-v0.1"
    module: "@openagentpay/protocol-ap2"
    enabled: true
  - id: "cex-pay-v0.1"
    module: "@openagentpay/protocol-cex-pay"
    enabled: true

governance:
  policies:
    - kind: amountThreshold
      maxUsd: 50
    - kind: velocityLimit
      windowSeconds: 60
      maxCount: 20
    - kind: timeOfDay
      startHourUtc: 1
      endHourUtc: 23
  compliance:
    checkers:
      - kind: static-sanctions
  audit:
    sinks:
      - kind: console
      - kind: dynamodb
        config:
          tableName: openagentpay-audit-log

routing:
  strategy: least-cost
  fallback:
    - coinbase-cdp
    - hashkey

tenants:
  - id: research-team
    apiKey: "env://OAP_KEY_RESEARCH"
    allowedWallets: [coinbase-cdp]
    dailyBudgetUsd: 100
  - id: trading-bot
    apiKey: "env://OAP_KEY_TRADING"
    allowedWallets: [hashkey, coinbase-cdp]
    dailyBudgetUsd: 1000
    requireTwoPersonApprovalAboveUsd: 500
    sandboxOnly: true
`;

describe("config — happy path", () => {
  it("parses a complete valid yaml", () => {
    const cfg = loadConfigFromString(VALID_YAML, { applyEnvOverrides: false });
    expect(cfg.version).toBe("1");
    expect(cfg.wallets).toHaveLength(2);
    expect(cfg.protocols).toHaveLength(3);
    expect(cfg.governance.policies).toHaveLength(3);
    expect(cfg.routing.strategy).toBe("least-cost");
    expect(cfg.tenants).toHaveLength(2);
  });

  it("preserves wallet config and secrets", () => {
    const cfg = loadConfigFromString(VALID_YAML, { applyEnvOverrides: false });
    const hk = cfg.wallets.find((w) => w.provider === "hashkey")!;
    expect(hk.module).toBe("@openagentpay/wallet-hashkey");
    expect(hk.secrets.privateKey).toBe("env://HASHKEY_TESTNET_AGENT_PRIVATE_KEY");
  });

  it("normalizes policies as discriminated union", () => {
    const cfg = loadConfigFromString(VALID_YAML, { applyEnvOverrides: false });
    const amount = cfg.governance.policies.find(
      (p) => p.kind === "amountThreshold"
    );
    expect(amount).toBeDefined();
    if (amount?.kind === "amountThreshold") {
      expect(amount.maxUsd).toBe(50);
    }
  });

  it("default config is valid", () => {
    const cfg = defaultConfig();
    expect(cfg.version).toBe("1");
    expect(cfg.governance.audit.sinks[0]?.kind).toBe("console");
  });
});

describe("config — validation errors", () => {
  it("rejects missing version", () => {
    expect(() =>
      loadConfigFromString(`wallets: []`, { applyEnvOverrides: false })
    ).toThrow(ConfigError);
  });

  it("rejects unknown policy kind", () => {
    const bad = `
version: "1"
governance:
  policies:
    - kind: unknownPolicy
      maxUsd: 100
`;
    expect(() => loadConfigFromString(bad)).toThrow(ConfigError);
  });

  it("rejects bad secret URI", () => {
    const bad = `
version: "1"
wallets:
  - provider: x
    module: "@openagentpay/wallet-x"
    secrets:
      privateKey: "not-a-secret-uri"
`;
    expect(() => loadConfigFromString(bad)).toThrow(ConfigError);
  });

  it("rejects bad routing strategy", () => {
    const bad = `
version: "1"
routing:
  strategy: nonsense
`;
    expect(() => loadConfigFromString(bad)).toThrow(ConfigError);
  });

  it("collects all validation issues into ConfigError.issues[]", () => {
    const bad = `
version: "1"
wallets:
  - provider: ""
    module: ""
`;
    try {
      loadConfigFromString(bad);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues ?? [];
      expect(issues.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("config — env overrides", () => {
  it("OAP_DEPLOYMENT_ENV overrides deployment.env", () => {
    const before = process.env["OAP_DEPLOYMENT_ENV"];
    process.env["OAP_DEPLOYMENT_ENV"] = "prod";
    try {
      const cfg = loadConfigFromString(VALID_YAML, { applyEnvOverrides: true });
      expect(cfg.deployment.env).toBe("prod");
    } finally {
      if (before === undefined) {
        delete process.env["OAP_DEPLOYMENT_ENV"];
      } else {
        process.env["OAP_DEPLOYMENT_ENV"] = before;
      }
    }
  });
});

describe("config — validateConfig() direct", () => {
  it("works on a JS object (not just yaml)", () => {
    const cfg = validateConfig({
      version: "1",
      wallets: [],
      protocols: [],
      tenants: [],
    });
    expect(cfg.version).toBe("1");
  });
});
