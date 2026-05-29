# Wallet Candidates — Sign-Up Checklist for Track A

> **Purpose**: For each of OpenAgentPay's 13 protocol adapters, recommend 1-2 wallets to integrate. Each wallet entry tells you exactly what testnet account to register and which credentials to share back so we can implement the connector.
>
> **You sign up. I implement. We verify on testnet.**
>
> **Prefer testnets** — production wallets only after v1.0 GA.

---

## Quick legend

- ✅ **Already integrated**
- ⭐ **Top priority** — strategic value, fast to implement
- 🟢 **Medium priority** — good test coverage, opens new geography or use case
- 🟡 **Long-tail** — useful for matrix completeness

---

## Tier 1 — Top priority sign-ups (recommended order)

### 1. **Stripe Privy** ⭐⭐⭐  (closes the AgentCore-Path-D loop)

| Field | Value |
|---|---|
| **Why first** | AWS Bedrock AgentCore Payments natively supports Coinbase CDP and Stripe Privy. We have CDP. Adding Privy = "feature parity with AgentCore" claim becomes literal. |
| **Protocol mapping** | x402-v1 |
| **Sandbox URL** | https://dashboard.privy.io/ → free dev account |
| **Credentials needed** | `PRIVY_APP_ID` + `PRIVY_APP_SECRET` |
| **Testnet** | Base Sepolia (same as our `wallet-coinbase-cdp`) |
| **Asset** | Circle USDC on Base Sepolia (free faucet) |
| **Effort** | ~1 day to ship `packages/wallet-stripe-privy` |

### 2. **Cobo Portal** ⭐⭐⭐  (institutional MPC + PACT workflow)

| Field | Value |
|---|---|
| **Why** | The most architecturally interesting wallet in the space. PACT flow is a design we want to adopt anyway. |
| **Protocol mapping** | x402-v1 (EVM) + AP2 (mandate compatible) |
| **Sandbox URL** | https://portal.cobo.com/ → request developer access |
| **Credentials needed** | API key + secret + agent wallet address |
| **Testnet** | Goerli / Sepolia / multiple chains |
| **Asset** | USDC testnet |
| **Effort** | ~2-3 days (REST API wrapper + policy translation layer) |

### 3. **Circle Programmable Wallets** ⭐⭐  (USDC native, gas abstraction)

| Field | Value |
|---|---|
| **Why** | Native USDC + Circle's gas-station / paymaster. Strong compliance posture. |
| **Protocol mapping** | x402-v1 |
| **Sandbox URL** | https://console.circle.com/ → Programmable Wallets sandbox |
| **Credentials needed** | `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` |
| **Testnet** | Polygon Amoy / Base Sepolia / ETH Sepolia |
| **Asset** | USDC (testnet) — Circle owns this directly |
| **Effort** | ~1.5 days |

### 4. **OKX Pay (sandbox)** ⭐⭐  (validates OAP-CEX as a real protocol, not Binance-only)

| Field | Value |
|---|---|
| **Why** | OAP-CEX v0.1 needs a 2nd reference implementation (besides Binance) to be a credible IETF draft. |
| **Protocol mapping** | cex-pay-v0.1 (OAP-CEX) |
| **Sandbox URL** | https://www.okx.com/account/my-api → check for sandbox flag |
| **Credentials needed** | `OKX_API_KEY` + `OKX_API_SECRET` + `OKX_PASSPHRASE` (3-piece) |
| **Testnet** | OKX has limited testnet for Pay; primary use is via SPOT with throwaway funds |
| **Asset** | USDT / USDC |
| **Effort** | ~1.5 days (similar shape to Binance connector) |

### 5. **Lightning (LND testnet via Voltage)** ⭐  (only wallet for L402 protocol)

| Field | Value |
|---|---|
| **Why** | We have `protocol-l402` but NO wallet. L402 = Bitcoin agent payments, the OG agent payment use case (early Anthropic / Fewsats demos). |
| **Protocol mapping** | l402-v1 |
| **Sandbox URL** | https://voltage.cloud/ → free testnet LND node |
| **Credentials needed** | LND macaroon + TLS cert + node URL |
| **Testnet** | Bitcoin testnet (free testnet sats from faucets) |
| **Asset** | sats / msats |
| **Effort** | ~2 days (REST + macaroon auth) |

### 6. **Solana wallet via SquadsX or Helius** 🟢  (we have protocol, mock signer only)

| Field | Value |
|---|---|
| **Why** | `wallet-solana` currently has only `DemoSolanaSigner`. Need a real signer. |
| **Protocol mapping** | solana-pay-v1 |
| **Sandbox URL** | https://www.helius.dev/ (RPC) + a manual keypair OR https://app.squads.so/ |
| **Credentials needed** | Helius RPC API key + a base58 keypair (we generate) |
| **Testnet** | Solana devnet (free SOL faucet) |
| **Asset** | USDC devnet |
| **Effort** | ~1 day (replace `DemoSolanaSigner` with `@solana/web3.js` signer) |

### 7. **Stellar (Stellar Lab + test SEP-31 anchor)** 🟢

| Field | Value |
|---|---|
| **Why** | Same situation as Solana — protocol exists, no wallet. Stellar uniquely targets cross-border USD remittance. |
| **Protocol mapping** | stellar-sep31-v1 |
| **Sandbox URL** | https://laboratory.stellar.org/ + https://testanchor.stellar.org/ |
| **Credentials needed** | Stellar testnet keypair (we generate) + anchor home_domain |
| **Testnet** | Stellar testnet |
| **Asset** | USDC (Circle issues on Stellar) |
| **Effort** | ~2 days (Horizon SDK + SEP-31 quote/payment flow) |

---

## Tier 2 — Medium priority (open new geographies / use cases)

### 8. **HashKey Pro Sandbox** 🟢  (Asia institutional CEX, OAP-CEX 3rd impl)

| Field | Value |
|---|---|
| **Sandbox URL** | https://pro.hashkey.com/ → developer portal |
| **Credentials** | API key + secret + (sub-account ID for testnet pool) |
| **Protocol** | cex-pay-v0.1 (OAP-CEX) |
| **Asset** | USDT / USDC / HSK |
| **Why** | HashKey is the strategic partner identified in `STRATEGY.md`. CEX-internal path completes the HashKey narrative. |

### 9. **Magic.link (Email-based EOA)** 🟢

| Field | Value |
|---|---|
| **Sandbox URL** | https://magic.link/ → free dev account |
| **Credentials** | `MAGIC_PUBLISHABLE_KEY` + `MAGIC_SECRET_KEY` |
| **Protocol** | x402-v1 (EIP-1193 reuses our metamask connector) |
| **Asset** | Circle USDC on Base Sepolia |
| **Why** | Mainstream user wallets — agents acting on behalf of non-crypto users |

### 10. **ZeroDev (Smart Account / ERC-4337)** 🟢

| Field | Value |
|---|---|
| **Sandbox URL** | https://dashboard.zerodev.app/ → free dev account |
| **Credentials** | ZeroDev project ID + paymaster ID |
| **Protocol** | x402-v1 (smart accounts can sign EIP-712) |
| **Asset** | Circle USDC on Base Sepolia |
| **Why** | Smart accounts encode spending limits ON-CHAIN — strongest agent safety story |

### 11. **Crossmint (NFT-aware embedded wallet)** 🟡

| Field | Value |
|---|---|
| **Sandbox URL** | https://www.crossmint.com/console |
| **Credentials** | `CROSSMINT_API_KEY` (server) + project ID |
| **Protocol** | x402-v1 |
| **Asset** | USDC + NFT |
| **Why** | Agent commerce involving digital goods — Crossmint is the standard |

### 12. **Web3Auth (Social-login MPC)** 🟡

| Field | Value |
|---|---|
| **Sandbox URL** | https://dashboard.web3auth.io/ |
| **Credentials** | `W3A_CLIENT_ID` + `W3A_CLIENT_SECRET` |
| **Protocol** | x402-v1 |
| **Asset** | Circle USDC on Base Sepolia |
| **Why** | Same role as Magic.link, different vendor — diversification |

---

## Tier 3 — Long-tail (matrix completeness)

### 13. **Bitget Wallet Pay** 🟡  (Asia CEX 4th OAP-CEX impl)
- Sandbox: https://www.bitget.com/en/api-doc → sandbox section
- Same shape as Binance/OKX — quickest possible PR after OKX merges

### 14. **Bybit Pay** 🟡
- Sandbox: https://testnet.bybit.com/ + Pay API
- OAP-CEX, throwaway

### 15. **Fireblocks Sandbox** 🟡  (institutional MPC, enterprise tier)
- Sandbox: https://developers.fireblocks.com/ → dev portal
- API key + secret PEM
- x402-v1 (Fireblocks supports EIP-712 signing via REST)
- Use case: hedge funds running agents

### 16. **Anchorage Sandbox** 🟡
- Sandbox: https://anchorage.com/ → enterprise sales (no public dev portal)
- LATER — needs sales engagement

### 17. **Polygon zkEVM testnet wallet (any EOA)** 🟡
- Just needs a private key + faucet
- Validates `wallet-metamask` works on a non-Base EVM chain

### 18. **TRON Shasta testnet (TronLink)** 🟡
- Sandbox: https://www.trongrid.io/ + Shasta faucet
- Protocol mapping: needs new `protocol-tron-usdt` (USDT on TRON is the largest stablecoin volume on earth)
- Asset: USDT-TRC20

### 19. **Sui devnet wallet (Sui Wallet / Suiet)** 🟡
- Sandbox: https://suiwallet.com/ → devnet config + faucet
- Protocol: ✅ `protocol-sui` exists, no wallet
- Asset: SUI / USDC (testnet)

### 20. **Aptos devnet wallet (Petra)** 🟡
- Sandbox: https://petra.app/ → devnet
- Protocol: ✅ `protocol-aptos` exists, no wallet
- Asset: APT / USDC

---

## Coverage matrix — every protocol gets ≥ 1-2 wallets

| Protocol | Wallets (existing + planned) |
|---|---|
| **x402-v1** | ✅ wallet-coinbase-cdp · ✅ wallet-hashkey · ✅ wallet-metamask · ✅ wallet-walletconnect · 🟡 wallet-stripe-privy · 🟡 wallet-cobo · 🟡 wallet-circle-pw · 🟡 wallet-magic-link · 🟡 wallet-zerodev · 🟡 wallet-crossmint · 🟡 wallet-web3auth · 🟡 wallet-fireblocks |
| **x402-v2** | (compatible with all x402-v1 wallets via Adapter version negotiation) |
| **cex-pay-v0.1 (OAP-CEX)** | ✅ wallet-binance · 🟡 wallet-okx · 🟡 wallet-hashkey-pro · 🟡 wallet-bitget · 🟡 wallet-bybit |
| **ap2-v0.1** | (orthogonal to settlement — every wallet supports it via mandate envelope) |
| **solana-pay-v1** | ✅ wallet-solana (mock signer) → 🟡 wallet-solana-helius (real signer) |
| **mpp-v0.1** | (sub-protocol of x402; reuses x402 wallets) |
| **l402-v1** | 🟡 wallet-lightning-lnd  ⭐ critical — protocol has no wallet today |
| **stellar-sep31-v1** | 🟡 wallet-stellar-anchor  ⭐ critical |
| **w3c-payment-v1** | (browser-mediated; reuses metamask/walletconnect) |
| **sui-pay-v1** | 🟡 wallet-sui-suiet  ⭐ critical |
| **aptos-pay-v1** | 🟡 wallet-aptos-petra  ⭐ critical |
| **erc8004-v1** | (registry, not settlement; uses any x402 wallet) |
| **skyfire-v1** | (identity layer; uses any x402 wallet + Skyfire KYA token) |
| **virtuals-acp-v1** | (4-phase ACP on Base; reuses x402 wallets, e.g., Coinbase CDP) |
| **nevermined-v1** | (subscription on Base; reuses x402 wallets) |

**Conclusion**: With **Tier 1 (7 wallets)** signed up, every active protocol gets at least one real wallet. With **Tier 1 + Tier 2 (12 wallets)**, every protocol gets ≥ 2.

---

## What I need from you per wallet

For each wallet you sign up, please paste back into our chat (or a `.env.local.candidates` file you can keep private):

```
=== WALLET: <name> ===
SANDBOX_URL: ...
API_KEY: ...
API_SECRET: ...
EXTRA_FIELD_1: ...
TESTNET_NAME: ...
ASSET_FAUCET_URL: ...   # so we can self-fund our test runs
NOTES: any quirks (e.g., "Privy requires CORS allowlist for localhost:8788")
```

I'll then:
1. Implement `packages/wallet-<name>/` against our existing `WalletConnector` interface
2. Write conformance tests using `@openagentpay/conformance`
3. Run a real testnet smoke test (1 USDC / 1 sat / 1 USDT)
4. Open a PR with passing tests + on-chain tx URL as proof

---

## Recommended sign-up batches

Don't try to register all 20 at once. Suggested cadence:

- **Batch 1 (this week)**: Stripe Privy + Circle Programmable Wallets + Cobo Portal
  - Why: All three are well-documented, free dev accounts, USDC native. Closes 3 strategic gaps in 1 week.
- **Batch 2 (next week)**: OKX Pay + Lightning (Voltage) + Solana (Helius)
  - Why: Validates OAP-CEX, fills L402 wallet gap, real Solana signing.
- **Batch 3 (week 3)**: HashKey Pro + Stellar + Magic.link + ZeroDev
  - Why: Asia / Cross-border / Mainstream / Smart account use cases.
- **Batch 4 (later)**: Crossmint, Web3Auth, Bitget, Bybit, Fireblocks, TRON, Sui, Aptos

---

*Last updated: 2026-05-24*
*Coordinated by: Neo + OpenAgentPay maintainer team*
