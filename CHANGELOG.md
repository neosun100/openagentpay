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
