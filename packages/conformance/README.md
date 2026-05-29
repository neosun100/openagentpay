# @openagentpay/conformance

> Conformance test suites for OpenAgentPay `WalletConnector` and `ProtocolAdapter` implementations.

If you are writing a **new wallet connector** or **new protocol adapter** for OpenAgentPay (or you fork an existing one), use this package to verify your implementation matches the canonical contract. Pass all tests → your connector is **OpenAgentPay-Certified** and ready to ship to npm.

---

## Why this exists

OpenAgentPay's whole value comes from the contract being identical across providers. The same way every Kubernetes CRI implementation passes the same conformance tests so workloads can move between Docker / containerd / CRI-O without rewriting, every OpenAgentPay `WalletConnector` must pass the same tests so business code doesn't change when you switch from HashKey to Coinbase CDP to Binance Pay.

This package is **not a test framework** — it's a library that uses your existing test framework (vitest, jest, mocha) and exports `runWalletConformance()` and `runProtocolConformance()` for you to call.

---

## Install

```bash
pnpm add -D @openagentpay/conformance vitest
```

---

## Wallet Connector conformance

```typescript
// packages/wallet-mywallet/tests/conformance.test.ts
import { describe } from "vitest";
import { runWalletConformance } from "@openagentpay/conformance/wallet";
import { MyWalletConnector, MemoryInstrumentStore } from "../src/index.js";
import type { PaymentRequest, ProtocolId, UserId } from "@openagentpay/core";

runWalletConformance(
  {
    createConnector: () =>
      new MyWalletConnector({
        // ... your config
        instrumentStore: new MemoryInstrumentStore(),
      }),
    createUserId: (suffix) => `test-user-${suffix}` as UserId,
    buildPaymentRequest: (overrides) => ({
      protocol: "x402-v1" as ProtocolId,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: "0x000000000000000000000000000000000000dEaD",
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 600,
      nonce: "0x" + "0".repeat(64),
      rawPayload: {},
      ...overrides,
    }),
  },
  {
    requiresNetwork: false, // set true + OPENAGENTPAY_LIVE_TESTS=true to actually call the chain
    skipSettle: true,
  }
);
```

Run:

```bash
pnpm test
# or for live network tests:
OPENAGENTPAY_LIVE_TESTS=true pnpm test
```

You'll see ~25 tests across these groups:

1. **Capability self-report** — `getCapabilities()` returns stable, pure data
2. **Instrument lifecycle** — `createInstrument()` is idempotent, populates the right fields
3. **Balance read** — `getBalance()` returns stringified atomic units with valid timestamp
4. **Authorization signing** — `signAuthorization()` echoes the request, populates signature
5. **Settlement** — `settle()` returns canonical `errorCode`, populates `transactionRef` on success
6. **Error handling** — bogus inputs throw, invalid protocols rejected
7. **Determinism** — pure functions stay pure

---

## Protocol Adapter conformance

```typescript
// packages/protocol-myproto/tests/conformance.test.ts
import { runProtocolConformance } from "@openagentpay/conformance/protocol";
import { MyProtocolAdapter } from "../src/index.js";

runProtocolConformance({
  createAdapter: () => new MyProtocolAdapter(),
  buildValidResponse: () => ({
    statusCode: 402,
    headers: { "content-type": "application/json" },
    body: {
      // ... whatever shape your protocol expects
    },
  }),
  buildForeignResponse: () => ({
    statusCode: 402,
    headers: {},
    body: { x402Version: 1, accepts: [] }, // x402 format — your adapter should NOT detect
  }),
  buildSignedAuthorization: () => ({
    request: /* a valid PaymentRequest produced by parsePaymentRequired */,
    signer: "0x...",
    signature: "0x...",
  }),
});
```

Coverage:

1. **Identity** — `id` is non-empty, no whitespace
2. **detect()** — returns true for valid, false for foreign / non-402, never throws
3. **parsePaymentRequired()** — populates required PaymentRequest fields, `protocol` matches `id`
4. **buildRetry()** — returns valid HttpRetryEnvelope
5. **Error handling** — malformed bodies surface `ProtocolError`

---

## Conformance versioning

The current suite version is exported as `CONFORMANCE_VERSION`. When OpenAgentPay's public ABI changes, the major/minor of this version bumps and connectors may need to re-certify.

```typescript
import { CONFORMANCE_VERSION } from "@openagentpay/conformance";
console.log(CONFORMANCE_VERSION); // "0.1.0-alpha"
```

---

## CLI runner (planned)

When the `oap` CLI ships (Wave 1 roadmap, see [docs/POSITIONING.md](../../docs/POSITIONING.md)):

```bash
oap conformance test --connector ./my-wallet
# → runs all conformance tests against the connector exported by ./my-wallet/dist/index.js
# → prints a colored report + emits a signed certificate JSON
```

---

## License

Apache-2.0
