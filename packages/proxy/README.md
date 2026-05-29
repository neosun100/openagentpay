# @openagentpay/proxy

> Standalone HTTP proxy server for OpenAgentPay — multi-tenant, virtual-API-key-gated, language-agnostic. **The LiteLLM Proxy equivalent for Crypto Agent Payments.**

---

## Why

LiteLLM Proxy (`litellm --port 4000`) made `https://api.openai.com` interchangeable with Anthropic / Bedrock / 100+ providers — your code talks to ONE endpoint, the proxy fans out. OpenAgentPay Proxy does the same for crypto agent payments:

- **One HTTP endpoint** (`POST /v1/payments`) regardless of underlying wallet (HashKey / Coinbase CDP / Binance / MetaMask / Solana).
- **Virtual API keys** scoped per team / cost-center / agent — opaque `oap_sk_xxx` tokens you can rotate without redeploying.
- **Per-tenant policy** — daily budget cap, allowed wallets, allowed protocols, sandbox-only, two-person approval threshold.
- **Built-in 7-Layer Guardrail** — every request runs `governance.preCheck()` before signing.

Your agents (LangChain / Strands / AutoGen / any framework) just hit `https://your-oap-proxy.example.com/v1/payments` with a Bearer token. They don't need to know which wallet is at the other end.

---

## Quickstart (local demo)

```bash
pnpm --filter @openagentpay/proxy start
# → boots on :8788, prints a freshly minted demo API key

curl -H "Authorization: Bearer oap_sk_<the-key-printed>" \
  http://localhost:8788/v1/whoami
```

You should see the resolved tenant including its allowed wallets and daily budget.

---

## API surface

All routes (except `/v1/health`) require `Authorization: Bearer oap_sk_xxx` or `X-OpenAgentPay-Key: oap_sk_xxx`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Liveness probe (public) |
| `GET` | `/v1/whoami` | Echo resolved tenant + limits |
| `GET` | `/v1/wallets` | List wallets visible to this tenant (filtered by allow-list) |
| `POST` | `/v1/sessions` | Mint a payment session (enforces tenant daily budget cap) |
| `GET` | `/v1/sessions/:id` | Read a session |
| `POST` | `/v1/instruments` | Bind tenant to a wallet provider |
| `POST` | `/v1/payments` | Process a payment (enforces wallet allow-list + 2-person approval + governance.preCheck + audit) |

`POST /v1/payments` body:

```json
{
  "sessionId": "payment-session-...",
  "instrumentId": "payment-instrument-...",
  "walletProvider": "hashkey",
  "request": {
    "protocol": "x402-v1",
    "amount": { "amountAtomic": "1000", "decimals": 6, "currency": "USDC" },
    "recipient": "0x...",
    "asset": { "symbol": "USDC", "decimals": 6 },
    "validAfter": 0,
    "validBefore": 1779023271,
    "nonce": "0x..."
  }
}
```

---

## Per-tenant enforcement

Each `Tenant` carries hard limits the proxy enforces before delegating to `PaymentManager`:

| Limit | What it does |
|---|---|
| `allowedWallets[]` | Only wallets in this list may be used. Empty = no restriction. |
| `allowedProtocols[]` | Same idea, but for protocol IDs. |
| `dailyBudgetUsd` | `POST /v1/sessions` rejects budgets above this. |
| `requireTwoPersonApprovalAboveUsd` | Payments above this need `X-Second-Approver` header. |
| `sandboxOnly` | Forbid mainnet wallets (planned: capability-flag-based gate). |
| `status` | `suspended` → all requests 403. |

---

## Programmatic mounting

The proxy is just an Express app — mount into any host:

```typescript
import express from "express";
import { createProxy, InMemoryTenantStore } from "@openagentpay/proxy";
import { createInMemoryPaymentManager } from "@openagentpay/core";

const tenantStore = new InMemoryTenantStore();
// ... seed tenants ...

const paymentManager = createInMemoryPaymentManager({ /* ... */ });

const { app: proxyApp } = createProxy({ paymentManager, tenantStore });

const root = express();
root.use("/oap", proxyApp);
root.listen(80);
```

---

## Roadmap (Wave 1, see [docs/POSITIONING.md](../../docs/POSITIONING.md))

- [x] Express server with virtual API key auth
- [x] Multi-tenant store (in-memory)
- [x] Per-tenant wallet allow-list + daily budget cap
- [x] Two-person approval header
- [x] Optional governance.preCheck integration
- [ ] DynamoDB-backed `TenantStore` for production
- [ ] WebSocket event stream (`/v1/stream`) for real-time payment lifecycle
- [ ] Rate limiting per tenant
- [ ] OpenTelemetry trace export
- [ ] OpenAI-style streaming responses (where applicable)
- [ ] `oap proxy start --config openagentpay.yaml` (waits on the `oap` CLI)

---

## License

Apache-2.0
