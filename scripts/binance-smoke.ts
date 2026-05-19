#!/usr/bin/env tsx
/**
 * Binance Pay Sandbox Smoke Test
 * ================================
 *
 * Verifies an end-to-end happy path against the real Binance Pay sandbox:
 *   1) Reads BINANCE_PAY_API_KEY / BINANCE_PAY_API_SECRET / BINANCE_PAY_MERCHANT_ID
 *      from `.env.local` (gitignored) or environment.
 *   2) Boots a BinancePayConnector with a MemoryInstrumentStore.
 *   3) Calls createInstrument / getBalance / signAuthorization / settle.
 *   4) Prints the prepayId and the structured 12-step trace expected by the
 *      OpenAgentPay observability layer.
 *
 * Run:
 *
 *     # one-off
 *     pnpm tsx scripts/binance-smoke.ts
 *
 *     # or via package.json script (added separately):
 *     pnpm smoke:binance
 *
 * @license Apache-2.0
 */

import { createInterface } from "node:readline/promises";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import {
  PROTOCOL_ID as OAP_CEX_PROTOCOL_ID,
} from "@openagentpay/protocol-cex-pay";
import {
  BinancePayConnector,
  MemoryInstrumentStore,
} from "@openagentpay/wallet-binance";
import {
  InMemorySessionManager,
  type Money,
  type PaymentRequest,
  type UserId,
} from "@openagentpay/core";

// ----------------------------------------------------------------------------
//  .env.local loader (zero-dep)
// ----------------------------------------------------------------------------
function loadDotenvLocal(): void {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

// ----------------------------------------------------------------------------
//  Pretty printer
// ----------------------------------------------------------------------------
const colors = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

let stepCount = 0;
const startTime = Date.now();
function trace(emoji: string, msg: string): void {
  const elapsed = Date.now() - startTime;
  stepCount++;
  console.log(
    `  ${colors.dim(`+${String(elapsed).padStart(5)}ms`)} ${emoji} ${colors.dim(`(${stepCount})`)} ${msg}`
  );
}

// ----------------------------------------------------------------------------
//  Confirm with user before hitting real network
// ----------------------------------------------------------------------------
async function confirm(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  console.log(
    colors.yellow(
      "\n⚠️  This will hit the real Binance Pay sandbox.\n" +
        "    No real funds will move (sandbox account)\n" +
        "    but you will create a test order on Binance servers.\n"
    )
  );
  const ans = (await rl.question("    Continue? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (ans !== "y" && ans !== "yes") {
    console.log(colors.dim("\n  aborted"));
    process.exit(0);
  }
}

// ----------------------------------------------------------------------------
//  Main
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  loadDotenvLocal();

  const apiKey = process.env["BINANCE_PAY_API_KEY"];
  const apiSecret = process.env["BINANCE_PAY_API_SECRET"];
  const merchantId = process.env["BINANCE_PAY_MERCHANT_ID"];
  const baseUrl = process.env["BINANCE_PAY_BASE_URL"] ?? "https://bpay.binanceapi.com";
  const skipConfirm = process.env["BINANCE_PAY_SKIP_CONFIRM"] === "true";

  if (!apiKey || !apiSecret || !merchantId) {
    console.error(colors.red("\n❌ Missing required env variables.\n"));
    console.error("Please populate one of:");
    console.error("  • " + colors.cyan("~/Code/openAgentPay/.env.local"));
    console.error("  • environment variables exported in your shell\n");
    console.error("With these keys:");
    console.error(colors.dim(`
    BINANCE_PAY_API_KEY=<your sandbox merchant API Key>
    BINANCE_PAY_API_SECRET=<your sandbox merchant API Secret>
    BINANCE_PAY_MERCHANT_ID=<8-digit merchant id>
    BINANCE_PAY_BASE_URL=https://bpay.binanceapi.com   # default

    # After populating, .env.local is auto-ignored by git.
    `));
    process.exit(2);
  }

  console.log(
    colors.bold(colors.cyan("\n🌐 OpenAgentPay × Binance Pay Sandbox Smoke Test\n"))
  );
  console.log(`  ${colors.dim("base url      :")} ${baseUrl}`);
  console.log(`  ${colors.dim("merchant id   :")} ${merchantId}`);
  console.log(`  ${colors.dim("api key       :")} ${apiKey.slice(0, 8)}***`);
  console.log(`  ${colors.dim("api secret    :")} (hidden — never logged)`);

  if (!skipConfirm) {
    await confirm();
  }

  console.log(colors.bold("\n▶ Tracing the full 12-step OpenAgentPay flow:\n"));

  // ── 1. Build dependencies ────────────────────────────────────────────────
  trace("🔧", "Initialize MemoryInstrumentStore + InMemorySessionManager");
  const instrumentStore = new MemoryInstrumentStore();
  const sessionMgr = new InMemorySessionManager();

  trace("🔌", "Wire up BinancePayConnector (HMAC SHA512 sign + /v3/order)");
  const connector = new BinancePayConnector({
    apiKey,
    apiSecret,
    merchantId,
    baseUrl,
    instrumentStore,
  });

  // ── 2. Create instrument for this user ───────────────────────────────────
  trace("👤", "createInstrument for user 'odin-wang'");
  const userId = "odin-wang" as UserId;
  const instrument = await connector.createInstrument({ userId });
  trace("✓ ", `instrumentId = ${colors.cyan(instrument.id)}`);

  // ── 3. Create session with a budget ──────────────────────────────────────
  trace("💰", "createSession budget=$1.00 ttl=60min");
  const session = await sessionMgr.createSession({
    userId,
    budgetUsd: 1.0,
    expiresMinutes: 60,
  });
  trace("✓ ", `sessionId = ${colors.cyan(session.id)}`);

  // ── 4. Synthesize a PaymentRequest (would normally come from a 402) ──────
  trace("📥", "Simulate HTTP 402 + parse OAP-CEX accepts[]");
  const amount: Money = { amountAtomic: "1000", decimals: 6, currency: "USDT" }; // 0.001 USDT
  const validBefore = Math.floor(Date.now() / 1000) + 600;
  const request: PaymentRequest = {
    protocol: OAP_CEX_PROTOCOL_ID,
    amount,
    asset: { symbol: "USDT", decimals: 6 },
    recipient: merchantId, // self-pay in smoke test (sandbox)
    validAfter: 0,
    validBefore,
    nonce: "0x" + Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64),
    rawPayload: { synthetic: true },
    description: "OpenAgentPay smoke test micropayment (0.001 USDT)",
  };

  // ── 5. Reserve budget ────────────────────────────────────────────────────
  trace("🛡 ", "Session.checkAndReserve(0.001 USDC)");
  const usdcEquivalent: Money = { amountAtomic: "1000", decimals: 6, currency: "USDC" };
  const reservation = await sessionMgr.checkAndReserve(session.id, usdcEquivalent);
  if (!reservation.approved) {
    console.log(colors.red(`\n❌ Reservation rejected: ${reservation.reason}\n`));
    process.exit(1);
  }
  trace("✓ ", `remainingBudget = ${reservation.remainingBudget.amountAtomic}`);

  // ── 6. Sign authorization (produces OAP-CEX wire token) ──────────────────
  trace("🔐", "BinancePayConnector.signAuthorization (HMAC SHA512)");
  const signed = await connector.signAuthorization({
    instrumentId: instrument.id,
    request,
    session,
  });
  trace(
    "✓ ",
    `signature = ${colors.dim(signed.signature.slice(0, 16) + "…" + signed.signature.slice(-16))}`
  );
  trace(
    "📦",
    `X-PAYMENT-CEX header (${signed.encoded?.length} bytes base64-url)`
  );

  // ── 7. Settle (creates a real Binance Pay sandbox order) ─────────────────
  trace("⛓ ", "BinancePayConnector.settle → POST /binancepay/openapi/v3/order");
  const result = await connector.settle(signed);

  // ── 8. Commit (or release) the reservation ───────────────────────────────
  trace(
    result.success ? "✅" : "❌",
    `settle result: success=${result.success}` +
      (result.success ? ` txRef=${colors.green(String(result.transactionRef))}` : ` errorCode=${colors.red(String(result.errorCode))}`)
  );
  await sessionMgr.commit(session.id, usdcEquivalent, result.success);
  trace("📊", `Session.commit (success=${result.success}) → updated spent`);

  // ── Summary ──────────────────────────────────────────────────────────────
  const finalSession = await sessionMgr.getSession(session.id);
  console.log("");
  if (result.success) {
    console.log(colors.green(colors.bold("✅ Smoke test PASSED")));
    console.log(`   prepayId : ${colors.cyan(String(result.transactionRef))}`);
    console.log(`   network  : ${result.network}`);
    console.log(`   spent    : ${finalSession?.spent.amountAtomic} ${finalSession?.spent.currency}`);
    console.log(
      `   ${colors.dim("see your sandbox order at")} ${colors.cyan("https://merchant-test.binance.com")}`
    );
  } else {
    console.log(colors.red(colors.bold("❌ Smoke test FAILED at settlement")));
    console.log(`   errorCode    : ${result.errorCode}`);
    console.log(`   errorMessage : ${result.errorMessage}`);
    console.log("\n   Common causes:");
    console.log(
      colors.dim("   • Wrong API key/secret (regenerate at merchant-test.binance.com)")
    );
    console.log(
      colors.dim("   • Sandbox not enabled on the merchant account")
    );
    console.log(
      colors.dim("   • IP whitelist blocked your connection")
    );
    console.log(
      colors.dim("   • Insufficient sandbox balance (reset via merchant portal)")
    );
    process.exit(1);
  }
  console.log("");
}

main().catch((err: unknown) => {
  console.error(colors.red("\n❌ Unhandled error:"));
  console.error(err);
  process.exit(99);
});
