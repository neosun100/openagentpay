/**
 * Tests for @openagentpay/wallet-solana — Solana Pay protocol + wallet.
 */

import { describe, expect, it } from "vitest";
import {
  parseSolanaPayUrl,
  buildSolanaPayUrl,
  SolanaPayProtocolAdapter,
  SolanaConnector,
  DemoSolanaSigner,
  MemoryInstrumentStore,
  PROTOCOL_ID,
  WALLET_PROVIDER_ID,
  X_PAYMENT_SOLANA_HEADER,
} from "../src/index.js";
import { ProtocolError, type PaymentRequest, type Session, type UserId } from "@openagentpay/core";

const VALID_RECIPIENT = "9aLzC5J9pvwPCzJ8aB3uDk5vTd23N7TTczbT8X4Hk6QH"; // mock base58
const USDC_DEVNET = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

// ----------------------------------------------------------------------------
//  URL parser / builder
// ----------------------------------------------------------------------------

describe("parseSolanaPayUrl", () => {
  it("parses minimal URL", () => {
    const f = parseSolanaPayUrl(`solana:${VALID_RECIPIENT}`);
    expect(f.recipient).toBe(VALID_RECIPIENT);
    expect(f.amount).toBeUndefined();
  });

  it("parses URL with all fields", () => {
    const url = `solana:${VALID_RECIPIENT}?amount=0.001&spl-token=${USDC_DEVNET}&reference=ABC123&label=Hello&message=Pay%20me&memo=invoice-1`;
    const f = parseSolanaPayUrl(url);
    expect(f.amount).toBe("0.001");
    expect(f.splToken).toBe(USDC_DEVNET);
    expect(f.reference).toEqual(["ABC123"]);
    expect(f.label).toBe("Hello");
    expect(f.message).toBe("Pay me");
    expect(f.memo).toBe("invoice-1");
  });

  it("supports multiple reference fields", () => {
    const url = `solana:${VALID_RECIPIENT}?reference=R1&reference=R2`;
    const f = parseSolanaPayUrl(url);
    expect(f.reference).toEqual(["R1", "R2"]);
  });

  it("rejects URLs without solana: scheme", () => {
    expect(() => parseSolanaPayUrl("https://x")).toThrowError(ProtocolError);
  });

  it("rejects URL without recipient", () => {
    expect(() => parseSolanaPayUrl("solana:")).toThrowError(/missing recipient/);
  });

  it("rejects non-base58 recipient", () => {
    expect(() => parseSolanaPayUrl("solana:NOT-B58-AT-ALL")).toThrowError(/base58/);
  });
});

describe("buildSolanaPayUrl", () => {
  it("round-trips parse → build → parse", () => {
    const original = `solana:${VALID_RECIPIENT}?amount=0.001&spl-token=${USDC_DEVNET}&reference=R1&label=X`;
    const fields = parseSolanaPayUrl(original);
    const rebuilt = buildSolanaPayUrl(fields);
    const reparsed = parseSolanaPayUrl(rebuilt);
    expect(reparsed.recipient).toBe(fields.recipient);
    expect(reparsed.amount).toBe(fields.amount);
    expect(reparsed.splToken).toBe(fields.splToken);
    expect(reparsed.reference).toEqual(fields.reference);
    expect(reparsed.label).toBe(fields.label);
  });

  it("URL-encodes message with spaces", () => {
    const url = buildSolanaPayUrl({
      recipient: VALID_RECIPIENT,
      message: "Pay me 5 USDC",
    });
    expect(url).toMatch(/message=Pay%20me%205%20USDC/);
  });
});

// ----------------------------------------------------------------------------
//  ProtocolAdapter
// ----------------------------------------------------------------------------

describe("SolanaPayProtocolAdapter.detect", () => {
  it("detects body.solanaPay URL", () => {
    const a = new SolanaPayProtocolAdapter();
    const url = `solana:${VALID_RECIPIENT}?amount=0.001&spl-token=${USDC_DEVNET}`;
    expect(
      a.detect({ statusCode: 402, headers: {}, body: { solanaPay: url } })
    ).toBe(true);
  });

  it("detects raw string body", () => {
    const a = new SolanaPayProtocolAdapter();
    const url = `solana:${VALID_RECIPIENT}?amount=0.001`;
    expect(
      a.detect({ statusCode: 402, headers: {}, body: url })
    ).toBe(true);
  });

  it("detects via x-solana-pay-url header", () => {
    const a = new SolanaPayProtocolAdapter();
    const url = `solana:${VALID_RECIPIENT}?amount=0.001`;
    expect(
      a.detect({
        statusCode: 402,
        headers: { "x-solana-pay-url": url },
        body: { ap2Version: "0.1" }, // unrelated body
      })
    ).toBe(true);
  });

  it("rejects non-solana 402 bodies", () => {
    const a = new SolanaPayProtocolAdapter();
    expect(a.detect({ statusCode: 402, headers: {}, body: { x402Version: 1 } })).toBe(false);
  });
});

describe("SolanaPayProtocolAdapter.parsePaymentRequired", () => {
  it("converts USDC URL into PaymentRequest with USDC currency + 6 decimals", async () => {
    const a = new SolanaPayProtocolAdapter();
    const url = `solana:${VALID_RECIPIENT}?amount=0.001&spl-token=${USDC_DEVNET}&reference=REF1&message=Pay%20me`;
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: { solanaPay: url },
    });
    expect(r.protocol).toBe(PROTOCOL_ID);
    expect(r.amount.currency).toBe("USDC");
    expect(r.amount.decimals).toBe(6);
    expect(r.amount.amountAtomic).toBe("1000"); // 0.001 USDC
    expect(r.recipient).toBe(VALID_RECIPIENT);
    expect(r.nonce).toBe("REF1");
    expect(r.description).toBe("Pay me");
  });

  it("treats SOL native (no spl-token) with 9 decimals", async () => {
    const a = new SolanaPayProtocolAdapter();
    const url = `solana:${VALID_RECIPIENT}?amount=0.5`;
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: { solanaPay: url },
    });
    expect(r.amount.currency).toBe("SOL");
    expect(r.amount.decimals).toBe(9);
    expect(r.amount.amountAtomic).toBe("500000000"); // 0.5 SOL
  });

  it("treats unknown SPL mint as 'SPL' (default decimals=9)", async () => {
    const a = new SolanaPayProtocolAdapter();
    const unknownMint = "Z" + "1".repeat(43);
    const url = `solana:${VALID_RECIPIENT}?amount=1&spl-token=${unknownMint}`;
    const r = await a.parsePaymentRequired({
      statusCode: 402,
      headers: {},
      body: { solanaPay: url },
    });
    expect(r.amount.currency).toBe("SPL");
    expect(r.amount.decimals).toBe(9);
    expect(r.asset.contract).toBe(unknownMint);
  });

  it("throws when amount is missing", async () => {
    const a = new SolanaPayProtocolAdapter();
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: { solanaPay: `solana:${VALID_RECIPIENT}` },
      })
    ).rejects.toThrowError(/amount/);
  });

  it("throws when no URL extracted", async () => {
    const a = new SolanaPayProtocolAdapter();
    await expect(
      a.parsePaymentRequired({
        statusCode: 402,
        headers: {},
        body: { x402Version: 1 },
      })
    ).rejects.toThrowError(ProtocolError);
  });
});

describe("SolanaPayProtocolAdapter.buildRetry", () => {
  it("emits X-PAYMENT-SOLANA header with the tx signature", async () => {
    const a = new SolanaPayProtocolAdapter();
    const env = await a.buildRetry({
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
        recipient: VALID_RECIPIENT,
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 9_999_999_999,
        nonce: "REF1",
        rawPayload: {},
      },
      signer: VALID_RECIPIENT,
      signature: "TXSIG_demo_abcdef",
    });
    expect(env.headers[X_PAYMENT_SOLANA_HEADER]).toBe("TXSIG_demo_abcdef");
  });
});

// ----------------------------------------------------------------------------
//  WalletConnector
// ----------------------------------------------------------------------------

describe("SolanaConnector — capabilities", () => {
  it("reports walletProvider=solana", () => {
    const signer = new DemoSolanaSigner();
    const c = new SolanaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const caps = c.getCapabilities();
    expect(caps.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(caps.supportedProtocols).toContain(PROTOCOL_ID);
    expect(caps.supportedAssets.find((a) => a.symbol === "USDC")).toBeDefined();
    expect(caps.supportedAssets.find((a) => a.symbol === "SOL")).toBeDefined();
    expect(caps.features?.nonEvm).toBe(true);
    expect(caps.features?.ed25519).toBe(true);
  });

  it("displayName includes cluster", () => {
    const signer = new DemoSolanaSigner();
    const c = new SolanaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
      cluster: "mainnet-beta",
    });
    expect(c.getCapabilities().displayName).toContain("mainnet-beta");
  });
});

describe("SolanaConnector.createInstrument + getBalance", () => {
  it("creates instrument with signer.address as publicHandle", async () => {
    const signer = new DemoSolanaSigner({ address: "MYDEMOADDR1234" });
    const c = new SolanaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    expect(inst.walletProvider).toBe(WALLET_PROVIDER_ID);
    expect(inst.publicHandle).toBe("MYDEMOADDR1234");
  });

  it("idempotent — same userId returns same instrument", async () => {
    const signer = new DemoSolanaSigner();
    const c = new SolanaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const a = await c.createInstrument({ userId: "alice" as UserId });
    const b = await c.createInstrument({ userId: "alice" as UserId });
    expect(a.id).toBe(b.id);
  });

  it("getBalance reports signer balance in atomic units", async () => {
    const signer = new DemoSolanaSigner({ initialBalanceAtomic: "5000000" }); // 5 USDC
    const c = new SolanaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const bal = await c.getBalance(inst.id);
    expect(bal.money.amountAtomic).toBe("5000000");
    expect(bal.money.currency).toBe("USDC");
  });
});

describe("SolanaConnector.signAuthorization + settle", () => {
  it("happy path → SettlementResult.success=true with tx signature", async () => {
    const signer = new DemoSolanaSigner();
    const store = new MemoryInstrumentStore();
    const c = new SolanaConnector({ signer, instrumentStore: store });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    const req: PaymentRequest = {
      protocol: PROTOCOL_ID,
      amount: { amountAtomic: "1000", decimals: 6, currency: "USDC" },
      recipient: VALID_RECIPIENT,
      asset: { symbol: "USDC", decimals: 6 },
      validAfter: 0,
      validBefore: 9_999_999_999,
      nonce: "REF_TEST",
      rawPayload: {},
    };
    const signed = await c.signAuthorization({
      instrumentId: inst.id,
      request: req,
      session: {} as Session,
    });
    expect(signed.signer).toBe(signer.address);
    expect(signed.signature).toContain("DEMOSIG_");
    const settled = await c.settle(signed);
    expect(settled.success).toBe(true);
    expect(settled.transactionRef).toBe(signed.signature);
    expect(settled.network).toMatch(/solana-/);
    expect((settled.raw as any).explorerUrl).toContain("explorer.solana.com");
  });

  it("rejects non-solana protocol", async () => {
    const signer = new DemoSolanaSigner();
    const c = new SolanaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const inst = await c.createInstrument({ userId: "alice" as UserId });
    await expect(
      c.signAuthorization({
        instrumentId: inst.id,
        request: { protocol: "x402-v1" } as any,
        session: {} as Session,
      })
    ).rejects.toThrow(/only supports solana-pay-v1/);
  });

  it("settle returns failure when signature missing", async () => {
    const signer = new DemoSolanaSigner();
    const c = new SolanaConnector({
      signer,
      instrumentStore: new MemoryInstrumentStore(),
    });
    const r = await c.settle({
      request: {
        protocol: PROTOCOL_ID,
        amount: { amountAtomic: "1", decimals: 6, currency: "USDC" },
        recipient: VALID_RECIPIENT,
        asset: { symbol: "USDC", decimals: 6 },
        validAfter: 0,
        validBefore: 999,
        nonce: "X",
        rawPayload: {},
      },
      signer: signer.address,
      signature: "",
    });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("signature_invalid");
  });

  it("generateNonce produces non-empty base58-ish string", () => {
    const c = new SolanaConnector({
      signer: new DemoSolanaSigner(),
      instrumentStore: new MemoryInstrumentStore(),
    });
    const n = c.generateNonce();
    expect(n).toBeTypeOf("string");
    expect(n.length).toBeGreaterThan(10);
  });
});
