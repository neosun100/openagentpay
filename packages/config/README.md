# @openagentpay/config

> Declarative `openagentpay.yaml` schema + loader. **The LiteLLM `config.yaml` equivalent for Crypto Agent Payments.**

---

## Why

Ops engineers should be able to add a new wallet, change a policy threshold, or rotate an API key **without writing TypeScript**. This package provides:

1. A `zod`-validated schema for `openagentpay.yaml`.
2. A loader that resolves secret references (`env://`, `aws-secretsmanager://`, `file://`).
3. Sensible defaults so a 5-line yaml works.

Read once at boot by the proxy / CLI / Lambda — drives every subsequent runtime decision.

---

## Quickstart

```yaml
# openagentpay.yaml — minimum viable config
version: "1"
wallets:
  - provider: hashkey
    module: "@openagentpay/wallet-hashkey"
    secrets:
      privateKey: "env://HASHKEY_TESTNET_AGENT_PRIVATE_KEY"
protocols:
  - id: "x402-v1"
    module: "@openagentpay/protocol-x402"
```

```typescript
import { loadConfig } from "@openagentpay/config";

const cfg = loadConfig("./openagentpay.yaml");
//   ↑ throws ConfigError on missing/invalid yaml
//   ↑ resolves env:// references against process.env
//   ↑ returns a typed `OpenAgentPayConfig`
```

A full annotated example is in [`src/openagentpay.example.yaml`](./src/openagentpay.example.yaml).

---

## Schema overview

| Section | Purpose |
|---|---|
| `version` | Schema version. Must be `"1"` today |
| `deployment` | Optional metadata: name / env / region |
| `wallets[]` | Every payment provider — provider id, module, config, secrets |
| `protocols[]` | Adapters to enable — id, module, on/off |
| `governance.policies[]` | Discriminated union of `amountThreshold` / `velocityLimit` / `merchantWhitelist` / `merchantBlacklist` / `walletProviderWhitelist` / `timeOfDay` |
| `governance.compliance.checkers[]` | `static-sanctions` / `chainalysis-kyt` / `trm-labs` / etc |
| `governance.audit.sinks[]` | `console` / `dynamodb` / `s3-worm` / `opensearch` / `splunk` |
| `routing.strategy` | `priority` / `least-cost` / `least-latency` / `round-robin` / `user-affinity` |
| `routing.fallback[]` | Wallet provider ids in fallback order |
| `routing.retry` | Max attempts + backoff schedule |
| `tenants[]` | Per-team / per-cost-center API keys + limits |

---

## Secret resolution

Anywhere the schema accepts a secret, you write a URI:

| URI | Resolution |
|---|---|
| `env://VAR` | `process.env.VAR` |
| `aws-secretsmanager://NAME` | AWS Secrets Manager `GetSecretValue` (planned — module hook) |
| `file:///abs/path` | Read from disk |
| `gcp-sm://NAME` | GCP Secret Manager (planned) |
| `inline://VALUE` | Literal — for tests only |

The base loader **only** validates the URI shape. Full resolution is delegated to the consumer (proxy / CLI) so we don't pull cloud SDKs into the config package.

---

## Environment variable overrides

Selected fields can be overridden by env vars (so you can deploy the same yaml to dev/staging/prod):

| Env var | Overrides |
|---|---|
| `OAP_DEPLOYMENT_ENV` | `deployment.env` |
| `OAP_DEPLOYMENT_REGION` | `deployment.region` |
| `OAP_ROUTING_STRATEGY` | `routing.strategy` |

Disable overrides with `loadConfig(path, { applyEnvOverrides: false })`.

---

## API

```typescript
import {
  loadConfig,
  loadConfigFromString,
  validateConfig,
  defaultConfig,
  ConfigError,
  type OpenAgentPayConfig,
  OpenAgentPayConfigSchema,
} from "@openagentpay/config";

// 1. Load + validate from disk
const cfg: OpenAgentPayConfig = loadConfig("./openagentpay.yaml");

// 2. Load from string (tests)
const cfg2 = loadConfigFromString(yaml);

// 3. Validate a JS object (programmatic)
const cfg3 = validateConfig({ version: "1", /* ... */ });

// 4. Get a blank skeleton (e.g. for `oap config init`)
const skeleton = defaultConfig();

// 5. Extend the schema (advanced)
const ExtendedSchema = OpenAgentPayConfigSchema.extend({ /* extra fields */ });
```

---

## License

Apache-2.0
