# OpenAgentPay Custom CEX Pay Protocol (OAP-CEX) v0.1

> Status: **DRAFT** · Spec version 0.1.0-alpha · Last updated 2026-05-16
>
> Author: Neo Sun (@neosun100) and OpenAgentPay Contributors
> License: Apache-2.0 (specification text under CC-BY-4.0)

## 0. Status of This Document

This is a **draft specification** for the OpenAgentPay Custom CEX Pay Protocol, abbreviated **OAP-CEX**. It is intended to be:

1. The first protocol shipped with OpenAgentPay v0.1 alpha
2. A bridge between Agent runtime (HTTP 402 idiom) and centralized exchange (CEX) payment APIs that do **not** use EIP-3009 / EIP-712 (Binance Pay, OKX Pay, Bybit Pay, HashKey Pro, Alipay, WeChat Pay, ...)
3. A future IETF Internet-Draft submission candidate

It is **not** a replacement for x402; it is complementary. x402 covers on-chain stablecoin micropayments via EIP-3009; OAP-CEX covers off-chain CEX-internal payment rails. A single Agent may use both protocols in parallel, with the OpenAgentPay ProtocolRouter dispatching by 402-response signature.

## 1. Motivation

x402 v1/v2 mandates EIP-3009 `transferWithAuthorization` signatures and a public-blockchain settlement layer. This is excellent for crypto-native flows but excludes:

- **Asia-Pacific FSI customers** whose payment infrastructure lives inside CEX (Binance, OKX, Bitget, Bybit, HashKey, ...)
- **Web2 fiat rails** (Alipay, WeChat Pay, Stripe Charges)
- **Bank-direct flows** (SWIFT, SEPA, FedNow)

These rails share three properties:
1. Authorization is via a **provider-issued API key**, signed with **HMAC** (or OAuth2 token), not EIP-712
2. Settlement is **off-chain** inside the provider, instantaneous, and gas-free
3. Recipients are **provider-internal merchant IDs**, not Ethereum addresses

OAP-CEX standardizes a 402-response shape and a retry envelope that captures these properties without leaking provider specifics into the protocol layer.

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "SHOULD NOT", "MAY" in this document are to be interpreted as described in [RFC 2119].

**Agent**: An autonomous AI program (e.g., Strands Agent on AWS Bedrock AgentCore Runtime) initiating HTTP requests.

**Merchant**: An HTTP origin that returns 402 to charge for access to a resource.

**Wallet Provider**: A CEX or fiat payment provider (Binance Pay, OKX Pay, ...) that holds the Agent's funds and signs/settles transfers via API.

**Facilitator**: An optional intermediary service that validates the signed authorization and submits to the Wallet Provider on the Agent's behalf. In OAP-CEX MVP the Wallet Connector itself acts as facilitator (no separate party).

**Authorization Payload**: Data the Wallet Provider signs to authorize a single transfer.

**Wire Token**: A base64-encoded JSON object placed in the `X-PAYMENT-CEX` header during retry.

## 3. Protocol Overview

OAP-CEX is a 2-roundtrip HTTP protocol identical in shape to x402:

```
Agent  ──────GET /resource──────────▶  Merchant
       ◀──── 402 + oap-cex body ────  Merchant
       (Agent: parse → governor → sign via Wallet Provider)
Agent  ──── GET /resource + X-PAYMENT-CEX ──▶  Merchant
       (Merchant: validate token → settle via provider → return 200)
       ◀──── 200 + content ────────  Merchant
```

The key differences vs x402 are entirely in the **402 response body** and the **retry token format** (Sections 4 and 5).

## 4. The 402 Response (Merchant → Agent)

A merchant that wants to charge in a CEX rail MUST return:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "oapCexVersion": 1,
  "scheme": "cex-pay",
  "accepts": [
    {
      "provider": "binance-pay",
      "asset": "USDT",
      "amount": "1000",
      "amountDecimals": 6,
      "recipient": "merchant_28571234",
      "recipientType": "merchant_id",
      "validBefore": 1778861254,
      "nonce": "0x1aef...8d92",
      "metadata": {
        "merchantName": "Example Premium Data Co",
        "memo": "premium-analytics-eth-2026-05-16"
      }
    },
    {
      "provider": "okx-pay",
      "asset": "USDT",
      "amount": "1000",
      "amountDecimals": 6,
      "recipient": "okx_merchant_5172",
      "recipientType": "merchant_id",
      "validBefore": 1778861254,
      "nonce": "0x1aef...8d92"
    }
  ],
  "description": "Premium analytics report — ETH"
}
```

### 4.1 Field Definitions

| Field | Type | Required | Description |
|---|---|:---:|---|
| `oapCexVersion` | integer | yes | Protocol major version. MUST be `1` for this spec. |
| `scheme` | string | yes | MUST be `"cex-pay"`. Reserved for future schemes. |
| `accepts` | array | yes | One or more acceptable payment options. Agent picks one. |
| `description` | string | no | Human-readable description for audit log. |

### 4.2 `accepts[]` Item Fields

| Field | Type | Required | Description |
|---|---|:---:|---|
| `provider` | string | yes | Wallet Provider ID (`binance-pay`, `okx-pay`, `bitget-pay`, `bybit-pay`, `hashkey-pro`, `alipay`, `wechat-pay`, ...). Free-form; Agent matches against its capability list. |
| `asset` | string | yes | Asset symbol (`USDT`, `USDC`, `HKD`, ...). |
| `amount` | string | yes | Amount in atomic units, **stringified integer** (preserves precision over JSON). |
| `amountDecimals` | integer | yes | Decimals; final amount = `amount / 10^amountDecimals`. |
| `recipient` | string | yes | Provider-specific recipient identifier. |
| `recipientType` | enum | yes | `"merchant_id"`, `"user_id"`, `"address"` (some providers, e.g., HashKey, allow on-chain). |
| `validAfter` | integer | no | Unix seconds — earliest time auth is valid. Default 0. |
| `validBefore` | integer | yes | Unix seconds — latest time auth is valid. Agent MUST reject if past. |
| `nonce` | string | yes | 32-byte hex random — replay protection. |
| `metadata` | object | no | Free-form merchant metadata. |

### 4.3 Multiple `accepts[]` Entries

Merchants MAY list multiple provider options. The Agent's ProtocolRouter picks the first entry whose `provider` matches an installed Wallet Connector (or falls back to a routing policy).

## 5. The Retry (Agent → Merchant)

After signing, the Agent retries the original request with a `X-PAYMENT-CEX` header:

```http
GET /resource HTTP/1.1
Host: merchant.example
X-PAYMENT-CEX: eyJvYXBDZXhWZXJzaW9uIjox...    (base64 of token JSON)
```

### 5.1 Token Decoded Form

```json
{
  "oapCexVersion": 1,
  "scheme": "cex-pay",
  "provider": "binance-pay",
  "authorization": {
    "asset": "USDT",
    "amount": "1000",
    "amountDecimals": 6,
    "from": "agent_account_94821",
    "to": "merchant_28571234",
    "nonce": "0x1aef...8d92",
    "validBefore": 1778861254,
    "signedAt": 1778860654
  },
  "signature": {
    "alg": "HMAC-SHA512",
    "value": "9b3f1ae...c8df01"
  },
  "providerExtensions": {
    "binancePayPrepayId": "P_28571234_1778860656_a4f9e1"
  }
}
```

### 5.2 Field Definitions

| Field | Type | Required | Description |
|---|---|:---:|---|
| `oapCexVersion` | integer | yes | MUST match merchant's. |
| `scheme` | string | yes | MUST be `"cex-pay"`. |
| `provider` | string | yes | One of merchant's `accepts[].provider` values. |
| `authorization` | object | yes | Mirror of the merchant's `accepts[]` entry chosen, with `from` filled in. |
| `signature.alg` | string | yes | One of `HMAC-SHA512`, `HMAC-SHA256`, `Ed25519`, `OAuth2-Bearer`. |
| `signature.value` | string | yes | Hex / base64 / token string per `alg`. |
| `providerExtensions` | object | no | Provider-specific opaque blob (e.g., Binance Pay prepayId). Merchant MAY pass through to the provider during settlement. |

### 5.3 Encoding

The token is the **base64 (URL-safe, no padding)** encoding of the canonical JSON serialization of the decoded form. Whitespace MUST be eliminated before encoding.

## 6. Settlement (Merchant)

On receiving a valid `X-PAYMENT-CEX`, the merchant SHOULD:

1. Decode and validate the token shape (this spec)
2. Verify `validBefore > now`
3. Submit the authorization to the Wallet Provider's settlement API (e.g., Binance Pay `POST /v3/order`)
4. Return `200 OK` + content if settlement succeeds, or `402` with `errorCode` if it fails

This step is **provider-specific** and out of scope for this spec — it is the merchant's responsibility (or the merchant's facilitator).

## 7. Security Considerations

### 7.1 Replay Protection
The `nonce` MUST be 32 bytes of cryptographic randomness. Merchants MUST reject duplicate `(provider, recipient, nonce)` tuples within at least 24 hours.

### 7.2 Time Bounds
`validBefore` MUST be enforced. Agents SHOULD set `validBefore = now + 600s` (10 minutes) by default to limit replay window.

### 7.3 Asset Type-Confusion
The merchant MUST verify that the `authorization.asset` and `authorization.amount` exactly match what the Agent saw in the `accepts[]` it chose — defends against MITM downgrade.

### 7.4 Credential Storage
Wallet Provider credentials (Binance API key + secret, OKX passphrase, ...) MUST be stored in a secrets manager (AWS Secrets Manager via AgentCore Identity, HashiCorp Vault, ...). They MUST NOT appear in logs or telemetry.

### 7.5 Compliance / KYT
This spec does not mandate sanctions / KYT screening. Implementations SHOULD integrate provider-side or independent screening (e.g., Chainalysis, Coinbase CDP Facilitator's built-in checks).

## 8. Compatibility with x402

A merchant MAY return both `oap-cex` and `x402` 402 responses simultaneously by listing both formats in a multi-protocol envelope:

```json
{
  "x402Version": 1,
  "oapCexVersion": 1,
  "schemes": ["exact", "cex-pay"],
  "accepts": [
    { "scheme": "exact", "...": "x402 v1 fields" },
    { "scheme": "cex-pay", "provider": "binance-pay", "...": "oap-cex fields" }
  ]
}
```

The Agent's ProtocolRouter then chooses based on installed connectors and policy. This negotiated mode is OPTIONAL.

## 9. Versioning

- `oapCexVersion` is a **major** version. Breaking changes increment it.
- The current version is `1` (v0.1 spec). Backward-incompatible v2 will use `oapCexVersion: 2`.
- Within a major version, additive optional fields are allowed.

## 10. References

- [RFC 2119] — Key words for use in RFCs to Indicate Requirement Levels
- [RFC 7807] — Problem Details for HTTP APIs (inspiration for error responses)
- [x402 Specification](https://github.com/coinbase/x402/tree/main/specs) — Coinbase x402 protocol
- [EIP-3009] — Transfer with authorization (used by x402)
- [Binance Pay API](https://developers.binance.com/docs/binance-pay/) — Reference CEX provider
- [OAP-CEX repository](https://github.com/neosun100/openAgentPay/tree/main/packages/protocol-cex-pay) — Implementation

## Appendix A · MVP Scope (v0.1.0-alpha)

For OpenAgentPay MVP, only **Binance Pay** is implemented as a `provider` value. Other providers will be added in v0.2:

| Provider | Status |
|---|---|
| `binance-pay` | ✅ MVP |
| `okx-pay` | 🚧 v0.2 |
| `bitget-pay` | 🚧 v0.2 |
| `bybit-pay` | 🚧 v0.2 |
| `hashkey-pro` | 🚧 v0.3 |
| `alipay` | 🚧 v0.3 |
| `wechat-pay` | 🚧 v0.3 |

## Appendix B · Change Log

- **0.1.0-alpha** (2026-05-16) — Initial draft (this document).
