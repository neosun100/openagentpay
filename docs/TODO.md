# 📋 OpenAgentPay — Active TODO List

> **Always-up-to-date sprint tasks.** If you finish anything, mark it ✅. If you discover a new task, add it under the right lane.
>
> See [`STATE.md`](./STATE.md) for the resumable-state entry point.
> See [`ROADMAP.md`](./ROADMAP.md) for the quarterly arc.

---

## 🚦 Three lanes — pick what you want to work on

| Lane | Description | Depends on you (Neo)? |
|---|---|---|
| **A. Wallet integrations** | Real testnet wallets to round out the 18-protocol matrix | ✅ Yes — you must register accounts |
| **B. Self-contained polish** | Improvements that don't need external accounts | ❌ No — I can do alone |
| **C. Ecosystem expansion** | New plugins / SDKs / protocols / governance | ❌ No |

---

## Lane A — v0.11 Wallet Integrations (depends on Neo)

### Tier A — pure self-serve (Round 1, ~40 min total to register all 7)

| Status | Wallet | Sign-up URL | Cred fields needed | Effort to implement (after creds) |
|---|---|---|---|---|
| ⏳ pending | **Stellar Lab** | https://laboratory.stellar.org/ | `STELLAR_PUBLIC_KEY`, `STELLAR_SECRET`, `STELLAR_NETWORK=testnet` | ~2 hr |
| ⏳ pending | **Hedera Portal** | https://portal.hedera.com/ | `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY_DER`, `HEDERA_NETWORK=testnet` | ~2 hr |
| ⏳ pending | **Sui (Slush)** | https://slush.app | `SUI_ADDRESS`, `SUI_PRIVATE_KEY_BECH32`, `SUI_NETWORK=devnet` | ~2 hr |
| ⏳ pending | **Aptos (Petra)** | https://petra.app | `APTOS_ADDRESS`, `APTOS_PRIVATE_KEY`, `APTOS_NETWORK=devnet` | ~2 hr |
| ⏳ pending | **TronLink Shasta** | https://www.tronlink.org/ | `TRON_ADDRESS`, `TRON_PRIVATE_KEY`, `TRON_NETWORK=shasta`, `TRON_TRONGRID_API_KEY` | ~2 hr |
| ⏳ pending | **Cosmos Theta (Keplr)** | https://www.keplr.app | `COSMOS_ADDRESS`, `COSMOS_MNEMONIC`, `COSMOS_RPC=...` | ~3 hr |
| ⏳ pending | **Solana Helius** | https://www.helius.dev/ | `SOLANA_KEYPAIR_BASE58`, `SOLANA_HELIUS_API_KEY`, `SOLANA_CLUSTER=devnet` | ~1 hr (just upgrade existing) |

After Round 1: **every protocol has ≥ 1 real wallet** ✅

### Tier B — email-signup developer portals (Round 2, ~60 min total)

| Status | Wallet | URL | Cred fields | Effort |
|---|---|---|---|---|
| ⏳ pending | **Voltage Lightning** | https://voltage.cloud/ | `LND_NODE_URL`, `LND_ADMIN_MACAROON_HEX`, `LND_TLS_CERT_BASE64` | ~3 hr |
| ⏳ pending | **Rafiki Open Payments** | https://rafiki.money/ | `OP_WALLET_ADDRESS`, `OP_PRIVATE_KEY_PEM`, `OP_KEY_ID` | ~3 hr |
| ⏳ pending | **Stripe Privy** | https://dashboard.privy.io/ | `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AGENT_WALLET_ID` | ~2 hr |
| ⏳ pending | **Circle Programmable Wallets** | https://console.circle.com/ | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_ID`, `CIRCLE_NETWORK` | ~3 hr |
| ⏳ pending | **Magic.link** | https://magic.link/ | `MAGIC_PUBLISHABLE_KEY`, `MAGIC_SECRET_KEY` | ~2 hr |
| ⏳ pending | **ZeroDev** | https://dashboard.zerodev.app/ | `ZERODEV_PROJECT_ID`, `ZERODEV_BUNDLER_RPC`, `ZERODEV_PAYMASTER_RPC`, `ZERODEV_OWNER_PRIVATE_KEY` | ~3 hr |

### Tier C — protocol-specific (lower priority)

| Status | Wallet | URL | Notes |
|---|---|---|---|
| ⏳ pending | **Virtuals (use MetaMask)** | https://app.virtuals.io/ | Just connect MetaMask Base Sepolia, no separate creds |
| 🔒 deferred | **Skyfire developer access** | https://skyfire.xyz/ | Wait-list — apply but don't block |
| 🔒 deferred | **Nevermined** | https://nevermined.io/ | Discord-mediated; 1-2 day review |

### What I do once you give me credentials

For each wallet, the deliverable workflow is:

1. **Implement** `packages/wallet-<name>/` against existing `WalletConnector` interface
2. **Conformance** — wire `runWalletConformance()` from `@openagentpay/conformance` into the test file (must pass all 25 tests)
3. **Smoke test** — write `scripts/<name>-smoke.ts` that does a real testnet tx
4. **CHANGELOG entry** with the testnet tx hash + explorer link as proof
5. **Update demo-web** capability bar to surface the new wallet
6. **Update `docs/STATE.md` Round 1/2 status** to ✅

---

## Lane B — Self-contained polish (no external dependencies)

I can do these without you needing to register anything.

### B1 — Migrate `apps/demo-api` to yaml-bootstrap
- **Status**: ⏳ pending
- **Why**: `apps/demo-api/src/context.ts` still hardcodes wallets. The new `bootstrapFromConfig()` from `@openagentpay/proxy` should drive it.
- **Effort**: ~2 hr
- **Acceptance**:
  - `apps/demo-api` reads `openagentpay.yaml` at boot
  - Live URL still works (regression test against `https://d1p7yxa99nxaye.cloudfront.net`)
  - 22 existing demo-api tests still pass

### B2 — GitHub Actions CI
- **Status**: ⏳ pending
- **Why**: Today every PR is hand-tested. Need automated `pnpm -r build && pnpm -r test` on push.
- **Effort**: ~3 hr
- **Acceptance**:
  - `.github/workflows/ci.yml` runs build + test for both pnpm and uv
  - Conformance suite specifically runs against every wallet package
  - Badges in README link to live build status

### B3 — `oap` CLI: `pay` and `session` subcommands
- **Status**: ⏳ pending
- **Why**: Today the CLI has config / doctor / conformance / version. Missing the actual "make a payment" + "create session" interactive commands that LiteLLM has via `litellm pay`.
- **Effort**: ~3 hr
- **Acceptance**: `oap pay --to <addr> --amount 1.5USDC --wallet hashkey` works against the local proxy

### B4 — Python SDK: full client (not just types)
- **Status**: ⏳ pending
- **Why**: `packages/python-sdk` only has `types.py`. Mirror the TS `PaymentManager` API for Python users who don't want a framework plugin.
- **Effort**: ~4 hr
- **Acceptance**: `from openagentpay import PaymentManager` works; basic `process_payment()` flow against demo-api

### B5 — More framework plugins (Python)
- **Status**: ⏳ pending
- Possible candidates: `bedrock-agentcore-plugin` (deep AWS integration), `dspy-plugin`, `instructor-plugin`
- **Effort**: ~3 hr each (each plugin is a small shim over the framework-agnostic kernel)

### B6 — Refund / Subscription productization
- **Status**: ⏳ pending
- **Why**: Types exist in `core/finance/types.ts` but not wired into `PaymentManager`. Need actual `manager.refund(req)` / `manager.subscribe(plan)` methods.
- **Effort**: ~5 hr
- **Acceptance**:
  - `PaymentManager.refund({originalTransactionRef, amount, reason})` works for x402 wallets
  - `SubscriptionManager` separate class with credit ledger backed by DynamoDB
  - 10+ unit tests

### B7 — `@openagentpay/http-interceptor` (LiteLLM-style auto-402-retry axios/fetch)
- **Status**: ⏳ pending
- **Why**: Coinbase ships `x402-axios` and `x402-fetch`. We should ship one too — it's the developer-experience cherry on top.
- **Effort**: ~4 hr
- **Acceptance**:
  - `wrapAxios(axios, {paymentManager, ...})` returns a wrapped client that auto-handles 402
  - Demo: `curl` against a 402 endpoint → wrapped client retries with X-PAYMENT and gets 200

### B8 — S3 WORM AuditSink
- **Status**: ⏳ pending
- **Why**: For SOX/MRM compliance, audit log must be Write-Once-Read-Many. DynamoDB is queryable but mutable. S3 with Object Lock is true WORM.
- **Effort**: ~3 hr
- **Acceptance**: New class `S3WormAuditSink` in `packages/governance/src/sinks/`, with object-lock retention period config

### B9 — `oap audit` CLI subcommand
- **Status**: ⏳ pending
- **Why**: Read audit logs from CLI without opening browser
- **Effort**: ~1 hr
- **Acceptance**: `oap audit --since 2024-01-01 --kind payment_success` queries the audit sink

### B10 — Spend Analytics Tab v2 — charts
- **Status**: ⏳ pending
- **Why**: Today it's tables. Add a small SVG sparkline for "spend over time" + a pie for wallet share.
- **Effort**: ~2 hr (no library — hand-rolled SVG)

---

## Lane C — Ecosystem expansion (longer-term, I'd pick these last)

### C1 — Java SDK (`com.openagentpay.sdk`)
- **Status**: 🔒 backlog
- **Why**: Spring AI / LangChain4j users — large enterprise market
- **Effort**: ~12 hr (fresh ground-up port)

### C2 — Go SDK (`github.com/openagentpay/sdk-go`)
- **Status**: 🔒 backlog
- **Why**: Cloud / infrastructure programs use Go
- **Effort**: ~10 hr

### C3 — Rust SDK
- **Status**: 🔒 backlog
- **Effort**: ~10 hr (rig.rs / kalosm integration target)

### C4 — OAP-CEX 2nd implementation (validates protocol, not just Binance-shape)
- **Status**: 🔒 backlog (depends on you registering OKX or HashKey Pro)
- **Effort**: ~6 hr per CEX

### C5 — AP2 v0.2 A2A discovery
- **Status**: 🔒 backlog (waits on AP2 spec finalization)
- **Effort**: ~5 hr
- **Why**: Cross-agent payment with capability discovery — google's roadmap item

### C6 — Cobo Agentic Wallet integration
- **Status**: 🔒 deferred (review-required at Cobo)
- **Effort**: ~6 hr after credentials

### C7 — Stripe MPP v2 (when published)
- **Status**: 🔒 backlog
- **Why**: Watch IETF draft progress

### C8 — Federated Conformance — third-party-ran tests
- **Status**: 🔒 backlog
- **Why**: Imagine a public dashboard `oapconformance.io` where any community wallet can submit a PR and get auto-tested. The Linux Foundation playbook.

### C9 — Spend Analytics: anomaly detection (ML)
- **Status**: 🔒 backlog
- **Why**: Detect compromised agents by spend pattern deviation
- **Effort**: ~10 hr (basic z-score baseline)

### C10 — `oap proxy` cluster mode
- **Status**: 🔒 backlog
- **Why**: For high-throughput multi-tenant SaaS — DynamoDB-backed TenantStore, shared session/audit state
- **Effort**: ~8 hr

---

## ✅ Already done (recent — for context)

(See `CHANGELOG.md` for the full history.)

- v0.10.0 (2026-05-24) — CLI · config yaml · WalletRouter · finance types · governance v0.10 (Chainalysis/TRM/OFAC/Approval/PerAgent/Jurisdiction) · 5 new protocols · 3 new framework plugins · proxy yaml-bootstrap · demo-web Spend Analytics · wallet-hashkey conformance (caught real bug)
- v0.9.0 (2026-05-24) — `@openagentpay/proxy` · `@openagentpay/conformance` · `docs/POSITIONING.md`
- v0.8.0 (2026-05-21) — Multi-protocol composition + Framework Plugin matrix + 4 wallet additions
- v0.7.0 (2026-05-20) — DynamoDB SessionManager
- v0.6.0 (2026-05-20) — DynamoDB AuditSink
- v0.5.x (2026-05-19) — LangChain plugin · Strands plugin
- v0.4.x (2026-05-19) — 7-Layer Guardrail
- v0.3.0 (2026-05-19) — Path-D Hybrid (Coinbase CDP + HashKey side-by-side)
- v0.2.0 (2026-05-17) — AWS Live deployment
- v0.1.0 (2026-05-17) — MVP

---

## 📈 Progress meter

```
v0.11 wallet integration matrix (target):
[██████░░░░░░░░░░░░░░] 6 / 19 wallets    (today's session goal: 13 → 19)

v1.0 readiness (subjective):
[████████████████░░░░] 80%
   - Core abstractions: 100%
   - Wallet coverage:   30%   ← biggest gap
   - Protocol coverage: 90%
   - Plugin coverage:   80%
   - Productization:    90%
   - Compliance/gov:    80%
```

---

*Last updated: 2026-05-27 — TODO sprint snapshot*
*Update protocol: when a task moves status, update the row + bump the "Last updated" line.*
