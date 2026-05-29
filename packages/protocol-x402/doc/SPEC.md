# OpenAgentPay x402 Protocol Adapter

> Coinbase [x402](https://www.x402.org/) v1/v2 protocol adapter for the
> OpenAgentPay `ProtocolAdapter` interface. Brings standard x402 envelopes
> (the same shape Coinbase / Cloudflare / Stripe Privy emit) into the same
> `ProtocolRouter` that already routes OAP-CEX, AP2, and Solana Pay.

## What this package does

Splits the **protocol concern** out of the wallet packages:

```
Before v0.9.0:
   wallet-hashkey   ← contained the x402 encoding logic
   wallet-coinbase-cdp ← duplicated it
   wallet-metamask  ← duplicated again

After v0.9.0:
   protocol-x402    ← single source of truth for the wire format
   wallet-*         ← each wallet just signs (its job)
```

That mirrors the LiteLLM model: protocol adapter = `provider`, wallet
connector = `transport`. ProtocolRouter can finally `detect()` standard
x402 bodies and dispatch them properly.

## Wire format (x402 v1)

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "1000",
      "resource": "https://api.example.com/data",
      "description": "Premium data access",
      "mimeType": "application/json",
      "payTo": "0x...",
      "maxTimeoutSeconds": 60,
      "asset": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      "extra": { "name": "USDC", "version": "2" }
    }
  ]
}
```

## Retry envelope (X-PAYMENT)

`X-PAYMENT: <base64url(JSON({ x402Version, scheme, network, payload }))>`

where `payload` carries:
```json
{
  "signature": "0x...",
  "authorization": {
    "from": "0x...",
    "to": "0x...",
    "value": "1000",
    "validAfter": "0",
    "validBefore": "9999999999",
    "nonce": "0x..."
  }
}
```

## Composition with AP2

x402 + AP2 mandates compose:

```typescript
import { Ap2ProtocolAdapter } from "@openagentpay/protocol-ap2";
import { X402ProtocolAdapter } from "@openagentpay/protocol-x402";
import { ProtocolRouter } from "@openagentpay/core";

const router = new ProtocolRouter({
  adapters: [
    new Ap2ProtocolAdapter(),    // outer envelope (mandates)
    new X402ProtocolAdapter(),   // settlement
  ],
});
```

When a 402 carries BOTH mandates AND x402 fields, AP2 wins (it's the
authorization layer); the mandate's `settlementProtocol` field still points
at `x402-v1` so the wallet ultimately signs EIP-3009.

## License

Apache 2.0 — © 2026 OpenAgentPay Contributors.
