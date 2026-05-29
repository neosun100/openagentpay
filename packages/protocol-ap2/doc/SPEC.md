# OpenAgentPay AP2 Protocol Adapter — Mandate-Based Authorization Layer

> **Status**: DRAFT v0.1.0-alpha · 2026-05-21
>
> Bridges Google's [Agent Payments Protocol (AP2)](https://github.com/google-agentic-commerce/AP2)
> mandate envelope with OpenAgentPay's settlement-protocol-agnostic
> `WalletConnector` interface.

## TL;DR

AP2 solves "**WHO** authorized this payment and **WHY**" (authorization).
x402 / OAP-CEX / Solana Pay solve "**HOW** to settle" (settlement).

These are **orthogonal** concerns. OpenAgentPay treats AP2 as an **outer
envelope** that composes with ANY inner settlement protocol:

```
   ┌───────────── HTTP 402 Response ─────────────┐
   │  AP2 Mandates (Verifiable Credentials)      │  ← This adapter
   │     ├── Intent Mandate    (user → agent)    │     parses + verifies
   │     ├── Cart Mandate      (merchant signs)  │
   │     └── Payment Mandate   (PSP-bound)       │
   │                                              │
   │  + ANY ONE OF:                              │
   │     - x402 v1/v2 settlement payload         │  ← Existing adapter
   │     - OAP-CEX v0.1 token                    │
   │     - Solana Pay tx                         │
   │     - MPP / AP2-x402 / future...            │
   └──────────────────────────────────────────────┘
```

The Agent's `PaymentManager` no longer cares which **settlement** protocol
the merchant chose — `ProtocolRouter` picks one. AP2 mandates ride along
in `PaymentRequest.mandates`, where they're available to:

- **PolicyEngine** (Layer 3) — enforce mandate constraints (max amount, allowed merchants, expiry)
- **ComplianceChecker** (Layer 5) — inspect issuer DIDs, presence flags
- **AuditLogger** (Layer 7) — record full mandate chain for SOX/MRM

## Mandate Lifecycle (per AP2 spec)

| # | Step                  | Signer       | Receiver         | Carries                                  |
|---|-----------------------|--------------|------------------|------------------------------------------|
| 1 | Intent Mandate        | User         | Agent            | "buy concert tickets if < $200, max 2"  |
| 2 | Agent shops           | —            | Merchants        | (no mandate exchanged)                   |
| 3 | Cart Mandate          | Merchant     | Agent → User     | Final cart + line items + total          |
| 4 | User confirms         | (User)       | Agent            | (Cart Mandate echoed back)               |
| 5 | Payment Mandate       | Issuer/PSP   | Payment network  | Risk signal: "agent-not-present" etc.   |
| 6 | Settlement            | Wallet       | Settlement layer | x402/OAP-CEX/Solana Pay payload          |

## What This Adapter Does

1. **`detect()`** — recognises AP2-bearing 402 envelopes (`ap2Version`, or `mandates[]` at top-level).
2. **`parsePaymentRequired()`** — pulls the *settlement-pointing* fields out of the **Payment Mandate** (`settlementProtocol`, `settlementPayload`) and constructs a `PaymentRequest`. The full mandate chain is attached to `request.mandates`.
3. **`buildRetry()`** — emits the `X-PAYMENT-AP2` header carrying the wallet-signed Payment Mandate.
4. **`verifyMandateChain()`** — utility for compliance/audit layers: walks Intent → Cart → Payment Mandate, checking referential integrity and structural validity (signature crypto-verification is deferred to a pluggable `MandateVerifier`).

## Composition with x402 / OAP-CEX

Because AP2 is purely an **authorization wrapper**, you don't have to pick:

```typescript
// Setup once at boot:
const router = new ProtocolRouter({
  adapters: [
    new Ap2ProtocolAdapter(),    // outer mandate layer (priority)
    new CexPayAdapter(),         // CEX inner settlement
    // x402 adapter from wallet-hashkey/wallet-coinbase-cdp
  ],
});

// Agent encounters 402:
const { request } = await router.route(httpResponse402);
// request.mandates is auto-populated if AP2 envelope present
// request.protocol is the SETTLEMENT protocol (x402-v1 / cex-pay-v0.1)
// → wallet connector signs settlement, mandates ride along in audit log
```

This is the "**single protocol surface, infinite protocol substrate**"
that the user asked for.

## See Also

- [`@openagentpay/core` types — Mandate, IntentMandateClaims, CartMandateClaims, PaymentMandateClaims](../core/src/types.ts)
- [`ProtocolRouter`](../core/src/router/protocol-router.ts)
- Google AP2 official spec: https://github.com/google-agentic-commerce/AP2
- W3C Verifiable Credentials Data Integrity 1.0: https://www.w3.org/TR/vc-data-integrity/

## License

Apache 2.0 — © 2026 OpenAgentPay Contributors
