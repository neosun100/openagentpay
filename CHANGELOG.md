# Changelog

All notable changes to **OpenAgentPay** are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project does not yet follow strict semver — every commit on `main` is a
working snapshot.

---

## [Unreleased]

### Coming next

- `@openagentpay/governance` — spending controls (velocity limits, merchant
  whitelist, anomaly detection, audit log) borrowed from AgentCore Payments
- LangChain plugin (Layer 1 framework extension)
- Solana Pay protocol adapter (non-EVM path)
- More EVM connectors (MetaMask, WalletConnect, Rabby, Safe)
- DynamoDB AuditSink (persistent audit log)
- Real LangChain agent demo with OpenAI / Anthropic API key

## [0.5.1] · 2026-05-19 — **Layer 1: Strands Plugin (Python)**

> **Headline**: Second Layer 1 framework adapter — `openagentpay-strands` —
> lets AWS Strands Agents (Python) make payments via OpenAgentPay's HTTP API.
> Strands SDK is an OPTIONAL dependency: the package works as a plain async
> function without it, and decorates with @tool when Strands is installed.

### Added — `openagentpay-strands` Python package (`packages/strands-plugin/`)

- `OpenAgentPayClient` — async HTTP client for the demo-api
  - `pay()` with auto session lifecycle (lazy create + 404 recovery)
  - `list_wallets()`, `get_governance()` for inspection
  - Per-instance session affinity counter for tests
  - 30s timeout default, 5s session expiry buffer
- `create_payment_tool()` factory
  - Returns async callable; if Strands SDK installed, also decorates with @tool
  - Custom `name` parameter for multi-tool agents
  - Errors converted to JSON for LLM (never raises to caller)
- `PaymentResult` dataclass with `to_dict()` LLM-friendly output
- `OpenAgentPayError` with structured `code` + `http_status`
- 23 pytest tests covering:
  - PaymentResult/Error shapes
  - HTTP client list_wallets / get_governance / pay
  - Session lazy creation + 404 recovery
  - Governance deny path returns PaymentResult (not exception)
  - 5xx HTTP raises
  - Validation errors (negative amount, empty fields)
  - Tool factory + JSON output
  - Tool error handling (HTTP / validation / governance all → JSON)

### Added — `scripts/strands-demo.py`

- Live demo against production CloudFront with 3 scenarios:
  1. Coinbase CDP payment → real Base Sepolia tx
  2. HashKey Chain payment → real HashKey tx
  3. Over-budget (00) → policy_denied
- Verified tx (this release):
  - Base Sepolia: [`0xa26f99b8…`](https://sepolia.basescan.org/tx/0xa26f99b8a64577e5254510ff56d777596da38e218f69186598a65592edda15e0)
  - HashKey: [`0x229995d9…`](https://testnet-explorer.hsk.xyz/tx/0x229995d90ce7e7b1198d0a8709919fc82cbbd5c95d0f0c8ab8a927eae3b8df71)

### Test totals

```
TypeScript: 157 passed
Python:      23 passed (strands-plugin)
─────────────────────────────────────
Grand total: 180 passed
```

E2E smoke (12 steps) against production: 12/12 ✅

### 5-Layer Architecture (post v0.5.1)

| Layer | Components | Status |
|---|---|---|
| **L1 Framework Plugin** | langchain-plugin (TS) · **strands-plugin (Py)** | ✅ × 2 |
| L2 PaymentManager | core | ✅ |
| L3 ProtocolAdapter | protocol-cex-pay | ✅ |
| L4 WalletConnector | wallet-{hashkey, coinbase-cdp, binance} | ✅ |
| L5 Settlement | chain RPC + CEX API | ✅ |


## [0.5.0] · 2026-05-19 — **Layer 1: LangChain Plugin**

> **Headline**: OpenAgentPay now ships **Layer 1 framework integration** — the
> 5-layer architecture is complete. Any LangChain agent (OpenAI Functions /
> Anthropic / Bedrock / etc.) can autonomously make payments by calling
> a single `StructuredTool`.

### Added — `@openagentpay/langchain-plugin` package

- **OpenAgentPayTool** extending `@langchain/core` `StructuredTool`
  - Returns JSON string back to LLM (parseable, structured)
  - Built-in zod schema (amountUsd, recipient, reason, walletProvider?)
  - Description tells LLM exactly when and how to use it
- **createPaymentTool(cfg)** factory — preferred public API
- Lazy session creation + auto-renewal on expiry
- Optional governance integration — preCheck before signing, audit after
- Pluggable hooks: `resolveProtocolForWallet`, `toMoney`, `toAsset`,
  `generateNonce`, `now` (for tests), `recentPayments` buffer
- 23 unit tests covering metadata, schema validation, happy path,
  governance deny paths, session lifecycle, _call (LangChain invocation),
  error handling, recentPayments buffer

### Added — Live demo script

- `scripts/langchain-demo.ts` — exercises full plugin against HashKey Chain
  Testnet with 3 scenarios:
  1. Allowed payment → real on-chain tx
  2. Over-budget payment → policy_denied
  3. Sanctioned recipient → compliance denied
- All 6 audit events recorded as expected
- Demo-verified tx: [`0xf94385c2…`](https://testnet-explorer.hsk.xyz/tx/0xf94385c2d7f8cf6ba1e0122693ac9875e103988ad4aa51ce57a1ed30fe6e97bb)

### 5-Layer architecture status (post v0.5.0)

| Layer | Component | Status |
|---|---|---|
| **L1 Framework Plugin** | `@openagentpay/langchain-plugin` | ✅ NEW v0.5.0 |
| L2 PaymentManager | `@openagentpay/core` | ✅ |
| L3 ProtocolAdapter | `@openagentpay/protocol-cex-pay` | ✅ |
| L4 WalletConnector | wallet-hashkey, wallet-coinbase-cdp, wallet-binance | ✅ |
| L5 Settlement | chain RPC, CEX API | ✅ |

### Test results

```
@openagentpay/core              21 passed
@openagentpay/governance        23 passed
@openagentpay/protocol-cex-pay  18 passed
@openagentpay/wallet-hashkey    23 passed
@openagentpay/wallet-coinbase-cdp 11 passed
@openagentpay/wallet-binance    20 passed
@openagentpay/langchain-plugin  23 passed   ← NEW
demo-api                        18 passed
─────────────────────────────────────────
Total                          157 passed
```

E2E smoke (12 steps) against production: 12/12 ✅

## [0.4.2] · 2026-05-19 — **Test Coverage Hardening**

Pre-Layer-1-extension hardening release. Locks in current behavior with
comprehensive test coverage before adding the LangChain plugin.

### Added

- **demo-api integration tests** (18 new tests, total 134 across monorepo)
  - `tests/fixtures/mock-context.ts`: mock connectors that record every call
  - `tests/integration.test.ts`: 7 describe blocks
- **scripts/smoke-e2e.ts**: automated e2e against any deployment URL
  - `pnpm smoke:e2e` (local) / `pnpm smoke:e2e:prod` (CloudFront)
  - 12-step pipeline including real on-chain payments
- New test API: `__setContextForTest()` for context injection

### Fixed

- **Real production bug**: `RECENT[]` payment cache was a module-level
  mutable array, leaking state across tests AND across Lambda warm
  invocations. Moved to `ctx.recentPayments`. Verified deployed to production.

## [0.4.1] · 2026-05-19 — **Guardrail Dashboard Tab + Architecture Diagram**

Patch release surfacing the 7-Layer Guardrail across UI, docs, and an
SVG architecture diagram.

### Added

- **demo-web 4th tab** (`GuardrailTab.tsx`): 7-layer stack visualization,
  Try-It buttons, real-time audit log auto-refreshing every 3s
- **SVG architecture diagram** (`svg/guardrail-7-layers.svg`): vertical
  600x920 layout. Hosted on CDN.
- **`docs/GOVERNANCE.md`** (380 lines): per-layer deep dive with code
  examples and AgentCore Payments comparison


## [0.4.0] · 2026-05-19 — **Governance: 7-Layer Guardrail**

> **Headline**: OpenAgentPay now ships **Layer 3 (Policy) + Layer 5 (Compliance) +
> Layer 7 (Audit)** of the AgentCore Payments-style 7-layer Guardrail. Every payment
> goes through a configurable spending policy chain, sanctions check, and append-only
> audit log — all enforced before signing or settlement.

### Added — `@openagentpay/governance` package

- **PolicyEngine** with composable rules:
  - `velocityLimit({ windowMs, maxCount, maxAmountAtomic })` — sliding-window rate limits
  - `amountThreshold({ maxAtomic })` — single-payment hard cap
  - `merchantWhitelist(addresses)` / `merchantBlacklist(addresses)` — allow/block lists
  - `walletProviderWhitelist(providers)` — restrict wallets per agent
  - `timeOfDay({ startHourUtc, endHourUtc })` — only allow during business hours
- **ComplianceChecker** for sanctions / OFAC / illicit finance:
  - `StaticSanctionsChecker` — in-memory list with multiple sources
  - `CompositeComplianceChecker` — fail-closed aggregator (extension point for Chainalysis / TRM Labs / Elliptic)
- **AuditLogger** with append-only structured events:
  - `InMemoryAuditSink` (capacity-bounded circular buffer for demo)
  - `ConsoleAuditSink` (single-line JSON for grep/jq parsing)
  - Future production sinks: S3 / CloudWatch / OpenSearch / Splunk
- **GovernanceManager** facade — single `preCheck()` call runs Policy + Compliance + Audit
- 23 unit tests covering all policies, compliance composition, audit retention

### Added — Demo API integration

- `apps/demo-api/src/context.ts` builds a default `GovernanceManager` with:
  - $50 single-payment cap (`amountThreshold`)
  - 20 payments per minute velocity limit
  - $100 hourly spend cap velocity limit
  - Demo sanctions list (Tornado Cash router + Lazarus Group illustrative addresses)
- `POST /api/pay` runs `governance.preCheck()` BEFORE signing — denies surface as
  `success: false, errorCode: 'policy_denied'` with structured reason
- Successful and failed payments record `recordSuccess` / `recordFailure` audit events
- **`GET /api/governance`** new endpoint — lists active policies, compliance status,
  last 50 audit events. UI can subscribe / refresh to show audit trail in real time.
- Recent payments tracked in-memory for velocity policy lookback

### Test results — `pnpm -r test`

```
@openagentpay/core              21 passed
@openagentpay/governance        23 passed   ← NEW
@openagentpay/protocol-cex-pay  18 passed
@openagentpay/wallet-hashkey    23 passed
@openagentpay/wallet-coinbase-cdp 11 passed
@openagentpay/wallet-binance    20 passed
─────────────────────────────────────────
Total                          116 passed   (was 93)
```

### 7-Layer Guardrail status (post v0.4.0)

| # | Layer | OpenAgentPay implementation | Status |
|---|---|---|---|
| 1 | Authorization | Out of scope (upstream auth) | — |
| 2 | Session | `@openagentpay/core` SessionManager (budget + TTL) | ✅ |
| 3 | **Policy** | `@openagentpay/governance` PolicyEngine | ✅ NEW |
| 4 | On-chain | EIP-3009 transferWithAuthorization | ✅ |
| 5 | **Compliance** | `@openagentpay/governance` ComplianceChecker | ✅ NEW |
| 6 | Identity | AWS Secrets Manager + KMS | ✅ |
| 7 | **Audit** | `@openagentpay/governance` AuditLogger | ✅ NEW |

---

---

## [0.3.0] · 2026-05-19 — **Path D Hybrid: Multi-Wallet, Multi-Chain**

> **Headline**: OpenAgentPay now ships with **two production-grade wallet
> connectors** running side-by-side in the same demo. Switch wallets with a
> single click; same `PaymentManager`, same `Session`, same business code.

### Added — Coinbase CDP wallet connector ([`packages/wallet-coinbase-cdp/`](./packages/wallet-coinbase-cdp/))

- **CoinbaseCDPConnector** implementing `WalletConnector` against
  [Coinbase CDP V2 SDK](https://docs.cdp.coinbase.com/) (managed wallets, TEE-secured keys)
- Targets **Base Sepolia testnet** (chainId 84532) with **Circle's official
  USDC contract** (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) — production-grade,
  not mock
- Full EIP-3009 `transferWithAuthorization` flow:
  - `signAuthorization()` → CDP `account.signTypedData()` (private key never leaves CDP TEE)
  - `settle()` → CDP `account.sendTransaction()` broadcasts on-chain
- Conformance tests: 11 unit tests covering capabilities, instrument lifecycle, nonce generation
- E2E smoke script `scripts/coinbase-cdp-smoke.ts` — verified on-chain
  (tx [`0xb8f4f86a…`](https://sepolia.basescan.org/tx/0xb8f4f86ac5cb16d46f18507d12e4baa962e78077de93eb4d40f3bf4259fb9e37))

### Added — Demo API path D hybrid

- **`apps/demo-api/src/context.ts`**: `connectors: Map<provider, ConnectorBundle>`
  loads HashKey + Coinbase CDP side-by-side
- **`GET /api/wallets`**: lists all available wallet providers with chain/token metadata
- **All endpoints** now accept optional `walletProvider` parameter (query string
  on `GET /api/wallet`, body field on `POST /api/pay`) — routing by UI dropdown
- Lambda integration: secrets loaded from Secrets Manager via ARN
  (`COINBASE_CDP_API_KEY_SECRET_ARN`, `COINBASE_CDP_WALLET_SECRET_ARN`)

### Added — Demo Web UI redesign

- **Capability Bar** replaces old static "HashKey Chain Testnet" badge:
  - **LIVE section**: chips for every available wallet (active glows green,
    others click to switch). Replaces the old dropdown.
  - **ROADMAP section**: 22 planned wallets across 5 categories
    (EVM self-custodial · managed · non-EVM chains · CEX · traditional payment)
    with category-colored left border accents
  - `+∞` chip emphasizes "any wallet matching the `WalletConnector` interface plugs in"
- **Tab status pill**: tabs row shows current chain + token (`Base Sepolia · USDC (Circle official)`)
- **Banner tagline** changed from `Live · HashKey Chain Testnet` to
  permanent `Open · Pluggable · Agent Payments`
- HTML `<title>` updated to `OpenAgentPay · Open Agent Payments`
- Sidebar dynamically renders chain/token labels and architecture flow per
  selected wallet (no more hardcoded HashKey values)

### Added — CDK infrastructure

- `DemoStackProps` extended with optional `coinbaseCdp*` fields
- Two new Secrets Manager secrets created when CDP credentials present:
  - `CoinbaseCdpApiKeySecret` (KMS-encrypted)
  - `CoinbaseCdpWalletSecret` (KMS-encrypted, PKCS#8 PEM)
- Lambda IAM policy automatically grants read on both new secrets
- Deployment is **opt-in**: if CDP env vars not set, stack still deploys with
  HashKey only (backward compatible)

### Verified on production CloudFront

| # | Path | Tx | Chain |
|---|---|---|---|
| 1 | `scripts/coinbase-cdp-smoke.ts` (local) | [`0xb8f4f86a…`](https://sepolia.basescan.org/tx/0xb8f4f86ac5cb16d46f18507d12e4baa962e78077de93eb4d40f3bf4259fb9e37) | Base Sepolia |
| 2 | localhost:8787 demo-api | [`0x0ef38063…`](https://sepolia.basescan.org/tx/0x0ef380636fb722c4b3ca0d9247cdbdfd4caed45018eb7bf77afa2ec3b3024463) | Base Sepolia |
| 3 | localhost:8787 demo-api (HashKey switch) | [`0x6bc45964…`](https://testnet-explorer.hsk.xyz/tx/0x6bc45964a249c8cfc8ba651fec05ee66e2b39915b9c1e400fbda78b6ac5b8b12) | HashKey Chain |
| 4 | **Production CloudFront → Lambda** | [`0xb6e6674f…`](https://sepolia.basescan.org/tx/0xb6e6674ffe5c269e7664d4a8a776ab95077ab0d46b03ed980909c7ff1d91db97) | Base Sepolia |

### Changed

- `apps/demo-api/src/handlers.ts` rewritten: every handler accepts optional
  `walletProvider`, falls back to `ctx.defaultProvider` for backward compat
- `apps/demo-web/src/api.ts`: `wallet()`, `pay()` accept optional
  `walletProvider` argument
- `Sidebar.tsx`: dropdown now driven by `/api/wallets` response, dynamically
  renders explorer links per chain (Basescan vs Blockscout)

### Test results — `pnpm -r test`

```
@openagentpay/core              21 passed
@openagentpay/protocol-cex-pay  18 passed
@openagentpay/wallet-hashkey    23 passed
@openagentpay/wallet-coinbase-cdp 11 passed   ← NEW
@openagentpay/wallet-binance    20 passed
─────────────────────────────────────────
Total                           93 passed   (0 failed)
```

---

## [0.2.0] · 2026-05-17 — **Live on AWS**

- AWS deployment: API Gateway HTTP API + Lambda + CloudFront + S3 + Secrets Manager (KMS)
- Live URL: https://d1p7yxa99nxaye.cloudfront.net
- AWS Lambda → HashKey Chain Testnet verified (tx [`0xd18cb0f1…`](https://testnet-explorer.hsk.xyz/tx/0xd18cb0f19359bdaae17aa89a0e14c47ccb7793579b9a09ac0423eefb1390a06a))
- 23-page presentation deck + 18,928-word talk notes
- 13 architecture diagrams (10 SVG + 3 generated)

---

## [0.1.0] · 2026-05-17 — **MVP**

- Project scaffold + Apache 2.0 license
- `WalletConnector` and `ProtocolAdapter` interfaces in `@openagentpay/core`
- `@openagentpay/wallet-binance` — Binance Pay (OAP-CEX path, sandbox-locked)
- `@openagentpay/protocol-cex-pay` — OAP-CEX v0.1 spec + adapter (24-page IETF-style draft)
- `@openagentpay/wallet-hashkey` — HashKey Chain Connector (TypeScript)
  - MockUSDC + EIP-3009 deployed to HashKey Chain Testnet
  - Python reference implementation in `scripts/hashkey/transfer-with-auth.py`
  - Both Python and TypeScript implementations produce identical on-chain effects
- `@openagentpay/core` — `InMemoryPaymentManager` + `InMemorySessionManager`
- Express API + Vite React three-tab UI
- 4 on-chain transactions verifying end-to-end flow

---

*Maintainer: [Neo Sun](https://github.com/neosun100). Issues and PRs welcome.*
