# Competitive Landscape — Crypto Agent Payments (2026 Q2)

> **Purpose**: Map every player in the Crypto Agent Payments space, position OpenAgentPay against them, and harvest concrete design patterns we should copy / improve / explicitly reject.
>
> **Strategic stance**: This is **not a competitive market** — it's a **layered stack** where we want to be *the unifier*. Most projects below are complementary, not competitive.

---

## 1. The five-layer mental model

After mapping every project, the field clearly stratifies into five horizontal layers:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 5  Framework / Agent runtime                                  │
│           LangChain · Strands · AutoGen · Bedrock AgentCore · CrewAI │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 4  Orchestration / Unification                                │
│           ⭐ OpenAgentPay (us) ⭐ ←  WHERE WE PLAY                    │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3  Protocol / Mandate layer                                   │
│           x402 (Coinbase) · AP2 (Google) · MPP (Stripe+Tempo)       │
│           Solana Pay · L402 (Lightning) · OAP-CEX · ERC-8004        │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2  Wallet / Custody / Identity                                │
│           Coinbase CDP · Stripe Privy · Circle Programmable Wallets │
│           Cobo Agentic Wallet · Halliday · Skyfire · Magic.link     │
│           Crossmint · ZeroDev · Pimlico · Fireblocks · Anchorage    │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 1  Settlement                                                 │
│           Base · Ethereum · Solana · Polygon · HashKey · TON · Sui  │
└─────────────────────────────────────────────────────────────────────┘
```

**OpenAgentPay's job is L4** — be the abstraction that sits above L1-L3 and is consumed by L5 frameworks. **Every project below is either an integration target or a copy-this-design source.**

---

## 2. Project-by-project breakdown

### 2.1 Cobo Agentic Wallet ⭐ (very important to study)

**What it is**: Institutional-grade MPC wallet infrastructure with a *declarative policy + approval workflow* layer specifically built for AI agents.

**The "PACT flow"** (Cobo's hero concept):

```
P  Policy        — declarative rules: spend caps, allow-lists, time windows
A  Approval      — multi-party / 2-of-N approval required for some actions
C  Credentials   — agent identity bound to an MPC keyshare quorum
T  Transaction   — only executes after PAC gates pass
```

**Architectural patterns we should copy**:

1. **Approval workflow as first-class primitive** — not just a policy boolean. They model "pending → approved → executed" as a state machine with timeouts, multi-approver, escalation. We have `requireTwoPersonApprovalAboveUsd` as a header — Cobo treats this as a full subsystem.
2. **MPC keyshare topology** — agent never holds a full key; signing requires a quorum that includes a human approver for high-value actions. Production-grade for high-value autonomous agents.
3. **"Agent profile" = identity + capability + policy bundle** — single JSON document a customer ships, contains everything an agent needs.
4. **Audit trail with cryptographic chaining** — each event hash includes prev-event hash → Merkle log. Not just append-only but tamper-evident.

**What we should NOT copy**: Cobo is a managed service (their backend runs MPC nodes). We're open source / self-hostable. We can borrow the *API surface* but not the *MPC backend*.

**Integration plan**: `packages/wallet-cobo` — wrap Cobo's HTTP API as a `WalletConnector`. Customers using Cobo get our 5-layer abstraction on top of their MPC custody.

---

### 2.2 Coinbase x402 + AgentKit

**What it is**: Two related products from Coinbase:
- **x402**: Open HTTP-native micropayments protocol (we already have `protocol-x402`)
- **AgentKit**: Toolkit giving AI agents on-chain capabilities (we already mirror via `wallet-coinbase-cdp`)

**Architectural patterns we should copy**:

1. **HTTP 402 challenge → sign → retry loop** is the right shape. We've adopted it via `protocol-x402` + `protocol-cex-pay`. ✅
2. **Facilitator pattern** — a third party broadcasts the signed authorization. Pays gas. Decouples agent from chain operations. ✅ We have it.
3. **CDP TEE for key isolation** — keys never leave Trusted Execution Environment. ✅ We model this via `requiresUserApproval=false, settlesOnChain=true, features.managedWallet=true`.

**Gap to close**: Coinbase ships an `x402-axios` and `x402-fetch` interceptor that auto-handles 402 responses in client code. We should ship `@openagentpay/http-interceptor` for the same DX.

---

### 2.3 Stripe MPP / Agentic Commerce Protocol (ACP)

**What it is**: Stripe + Tempo's draft IETF protocol for stablecoin-based merchant payments + OpenAI's ACP layered on top for agent commerce semantics.

**Architectural patterns we should copy**:

1. **Cart Mandate semantics** — Stripe ACP and Google AP2 converge here: agent gets a *cart commitment* signed by the merchant before paying. We have this via `protocol-ap2`'s `CartMandate`. ✅
2. **Refund / dispute flow** — Stripe defines a structured refund/chargeback model. We currently have NO refund flow. **Action item**: see B4 (RefundManager).
3. **Receipt as a first-class object** — every payment produces a structured `Receipt` with merchant signature. Customers want this for accounting integrations. **Action item**: see B4 (Receipt API).

---

### 2.4 Google AP2 (Agent Payments Protocol)

**What it is**: Mandate-based authorization layer that composes with any settlement protocol. Backed by 60+ partners (Coinbase, MetaMask, Salesforce, Amex, etc).

**Status in OpenAgentPay**: ✅ **Already built** as `protocol-ap2` with full Intent/Cart/Payment mandate support.

**One thing we should add**: **A2A discovery** — AP2 v0.2 has a registry where agents discover each other's capabilities. We should plug this into our `WalletRouter` (B3) for cross-agent payments.

---

### 2.5 Skyfire (KYA — Know Your Agent)

**What it is**: Identity + payments network for autonomous agents. Issues verifiable agent credentials.

**Status in OpenAgentPay**: ✅ Adapter `protocol-skyfire` exists.

**What we should add**: Skyfire's **Token-bound credential** model lets you sell access to APIs that require KYA-passed agents. We could surface this via a `compliance/SkyfireKYAChecker` that any payment can opt into.

---

### 2.6 Circle Programmable Wallets + Circle Agent Toolkit

**What it is**: Developer SDK for MPC/SCA wallets natively integrated with USDC. Strong compliance posture (Circle = USDC issuer).

**Architectural patterns we should copy**:

1. **Gas Station / Paymaster integration** — agents don't need native gas. Circle abstracts gas sponsorship. We model this loosely via `facilitatorPrivateKey` on `wallet-hashkey`; should formalize as a `PaymentSponsor` interface.
2. **Policy engine on the wallet** — Circle's wallet has built-in spend rules (per-day, per-recipient, per-asset). We have this at L2 (governance) — should we also push down to L4 (wallet)? Probably no — we want it in one place.

**Integration plan**: `packages/wallet-circle-pw` — wrap Circle Programmable Wallets via their REST SDK.

---

### 2.7 Halliday (Agentic Workflow Protocol)

**What it is**: Smart-wallet-based deterministic agent workflow with formal verification.

**The novel idea**: Agent actions are **declarative workflows** committed on-chain BEFORE execution. The smart wallet refuses to execute anything not in the workflow.

**Architectural patterns we should copy**:

1. **Pre-committed workflow** = an explicit agent plan that constrains autonomy. This is essentially **AP2 mandates** done as on-chain bytecode instead of off-chain VC. Same goal. We already cover via mandates.
2. **Their formal verification approach** is overkill for our v1, but we should document it as a roadmap item for "high-assurance mode."

**Integration plan**: NOT a wallet — Halliday is a different abstraction layer (workflow/plan rather than payment). Possibly future `protocol-halliday-workflow` if customers ask.

---

### 2.8 Pimlico + ZeroDev (ERC-4337 Account Abstraction)

**What they are**:
- **Pimlico**: ERC-4337 bundler + paymaster + verifying signature aggregator
- **ZeroDev**: Smart account SDK (Kernel) for AA wallets

**Architectural patterns we should copy**:

1. **Smart accounts give agents native programmable spending limits** without our governance layer needing to know. `Kernel` lets you encode "max $50/day" directly into the smart contract — agent CAN'T spend more even if compromised. Compare to our governance which is *enforcing* it externally.
2. **Bundler / Paymaster split** — gas sponsorship as an explicit role. Cleaner than our current "facilitator wallet" approach.

**Integration plan**: `packages/wallet-zerodev` — wrap ZeroDev SDK as a `WalletConnector`. Smart accounts become a wallet flavor with stronger on-chain guarantees.

---

### 2.9 Magic.link / Web3Auth / Crossmint (Embedded Wallets)

**What they are**: Social-login-based EOA wallets for end users (not agents per se).

**Why we care**: Many agent platforms want a *user-facing* wallet that the agent then uses. Magic/Web3Auth/Crossmint are the L2-of-L2 — wallet-as-a-service for the end user.

**Integration plan**: `packages/wallet-magic-link` and `packages/wallet-web3auth` — both implement EIP-1193, so we extend `MetamaskConnector` (already does EIP-1193) with provider-specific authentication.

---

### 2.10 Fireblocks + Anchorage (Institutional MPC Custody)

**What they are**: Bank-grade MPC custody platforms with full SOC 2 / ISO 27001 / FIPS 140-2.

**Why we care**: Enterprise customers (banks, hedge funds) running agents need this level of custody. Coinbase CDP and Cobo are mid-tier; Fireblocks/Anchorage are the top tier.

**Integration plan**: `packages/wallet-fireblocks` + `packages/wallet-anchorage` — REST API wrappers as `WalletConnector`. Both have well-documented APIs.

---

### 2.11 Nevermined

**What it is**: Subscription / credit-based access to AI services. Customer pays once, gets N credits, agent burns credits per call.

**Status in OpenAgentPay**: ✅ Adapter `protocol-nevermined` exists.

**What we should add**: A `SubscriptionManager` in core that handles credit ledger, top-up, expiration. Not strictly Nevermined-specific — applies to any prepaid agent service. **Action item**: see B4.

---

### 2.12 Project-by-protocol cross-reference

| Project | Type | OpenAgentPay status |
|---|---|---|
| Coinbase CDP | Wallet (managed) | ✅ `wallet-coinbase-cdp` |
| Coinbase x402 | Protocol | ✅ `protocol-x402` |
| Coinbase AgentKit | Framework | (mirrored by our `langchain-plugin`) |
| Stripe Privy | Wallet (managed) | 🟡 Planned `wallet-stripe-privy` |
| Stripe MPP | Protocol | ✅ `protocol-mpp` |
| OpenAI ACP | Protocol layer | 🟡 Wraps with AP2; explicit adapter would be value-add |
| Google AP2 | Protocol (mandate) | ✅ `protocol-ap2` |
| Circle Programmable Wallets | Wallet (MPC) | 🟡 Planned `wallet-circle-pw` |
| Cobo Agentic Wallet | Wallet (MPC + workflow) | 🟡 Planned `wallet-cobo` |
| Skyfire | Identity + protocol | ✅ `protocol-skyfire`; KYA checker planned |
| ERC-8004 | Identity registry | ✅ `protocol-erc8004` |
| ERC-7777 | Governance registry | 🟡 Planned `protocol-erc7777` |
| Halliday | Workflow | ❌ Out of scope (different layer) |
| Pimlico | Bundler/Paymaster | 🟡 Planned `payment-sponsor-pimlico` (NOT wallet — sponsor) |
| ZeroDev | Smart account SDK | 🟡 Planned `wallet-zerodev` |
| Magic.link | Embedded wallet | 🟡 Planned `wallet-magic-link` |
| Web3Auth | Embedded wallet | 🟡 Planned `wallet-web3auth` |
| Crossmint | Wallet + NFT | 🟡 Planned `wallet-crossmint` |
| Fireblocks | Institutional MPC | 🟡 Planned `wallet-fireblocks` |
| Anchorage | Institutional MPC | 🟡 Planned `wallet-anchorage` |
| Solana Pay | Protocol | ✅ `protocol-solana-pay` (in `wallet-solana`) |
| MetaMask | Self-custodial EOA | ✅ `wallet-metamask` |
| WalletConnect | Multi-wallet | ✅ `wallet-walletconnect` |
| Nevermined | Subscription | ✅ `protocol-nevermined` |
| HashKey Chain | Chain + USDC | ✅ `wallet-hashkey` |
| Binance Pay | CEX | ✅ `wallet-binance` |
| OKX / Bitget / Bybit Pay | CEX | 🟡 Planned (OAP-CEX 2nd implementations) |
| HashKey Pro | CEX | 🟡 Planned |
| TRON USDT | Chain + asset | 🟡 Planned `protocol-tron-usdt` |
| Lightning Network (L402) | Chain + protocol | ✅ `protocol-l402` (no wallet yet) |
| Open Payments (Interledger) | Protocol | 🟡 Planned `protocol-open-payments` |
| Hedera HCS micropayments | Chain + protocol | 🟡 Planned `protocol-hedera-hcs` |

---

## 3. Concrete patterns to copy (all credit to upstream)

| Pattern | Source | OpenAgentPay action |
|---|---|---|
| **Approval workflow as state machine** | Cobo PACT | Add `governance/approval-workflow.ts` — see B7 |
| **Cryptographically chained audit log** | Cobo + ERC-8004 | Add `audit/MerkleAuditSink` — see B7 |
| **HTTP client interceptor (auto-402-retry)** | Coinbase x402-axios | Ship `@openagentpay/http-interceptor` — see B4 |
| **Receipt object with merchant signature** | Stripe MPP / ACP | Add `core/Receipt` type + signing — see B4 |
| **Refund / dispute flow** | Stripe MPP | Add `core/RefundManager` — see B4 |
| **A2A capability discovery** | Google AP2 v0.2 | Wire into WalletRouter — see B3 |
| **Token-bound KYA credentials** | Skyfire | Add `governance/SkyfireKYAChecker` — see B7 |
| **Smart-account-encoded spending limits** | ZeroDev / Pimlico | Add `wallet-zerodev` — see Track A |
| **Paymaster as separate role** | Pimlico ERC-4337 | Add `core/PaymentSponsor` interface — see B4 |
| **Gas Station / sponsored gas** | Circle PW | Surface `features.gasSponsored` capability flag |
| **Subscription / credit ledger** | Nevermined | Add `core/SubscriptionManager` — see B4 |
| **MPC keyshare quorum** | Cobo / Fireblocks | Document as `wallet-cobo` / `wallet-fireblocks` integration |

---

## 4. Where OpenAgentPay is *already* ahead

To stay honest about our edge:

1. **No competitor unifies all three: wallets × protocols × frameworks**. Coinbase ships 1 wallet + 1 protocol. Stripe ships 1 wallet + 1 protocol. Cobo ships 1 wallet (no protocol layer). Skyfire ships 1 protocol (no wallet abstraction). **We ship 6 × 13 × 7 today** and growing.
2. **Conformance test suite for third-party connectors** — none of the above have this. It's the Linux-Foundation moat.
3. **Multi-protocol composition** (AP2 + x402 simultaneously routed via ProtocolRouter) — only Google AP2 talks about this; only we ship the router.
4. **Fully open-source, self-hostable**. Coinbase CDP / Stripe Privy / Cobo / Circle / Halliday / Skyfire are all SaaS. Customers who can't (or won't) hand keys to a SaaS need OpenAgentPay.

---

## 5. Decision matrix — what to build next

| If customer wants... | Build first |
|---|---|
| AWS-AgentCore-mirror demo | `wallet-stripe-privy` |
| Asia (HK / SG / JP) compliance | `wallet-hashkey-pro` (CEX) + `wallet-okx` |
| US enterprise compliance | `wallet-circle-pw` + `wallet-fireblocks` |
| Web3-native end users | `wallet-magic-link` + `wallet-zerodev` |
| Lightning / Bitcoin micropayments | `wallet-lightning` (L402 has protocol, no wallet) |
| Cross-border non-USD | `wallet-stellar` (we have protocol, no wallet) |

---

*Last updated: 2026-05-24*
*Maintained by: OpenAgentPay team*
*Source-of-truth for: roadmap prioritization, competitor positioning in fundraising / sales decks*
