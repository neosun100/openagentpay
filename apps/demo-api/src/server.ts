/**
 * Local development Express server.
 *
 * Wraps the Lambda-shaped handlers in an Express app for local dev.
 * In production, these handlers will run on Lambda Function URL.
 *
 * Usage:
 *   pnpm --filter @openagentpay/demo-api dev
 *   # → starts server on http://localhost:8787
 *
 * @license Apache-2.0
 */

import cors from "cors";
import express, { type Request, type Response } from "express";

import {
  createSession,
  getSession,
  getWalletStatus,
  processPayment,
  type ApiError,
} from "./handlers.js";
import { context } from "./context.js";
import type { SessionId } from "@openagentpay/core";

const PORT = Number(process.env["PORT"] ?? 8787);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: true, credentials: false }));

// Logging middleware
app.use((req, _res, next) => {
  const start = Date.now();
  console.log(`${dim(timestamp())} ${color("→", 36)} ${req.method} ${req.path}`);
  _res.on("finish", () => {
    const ms = Date.now() - start;
    const code = _res.statusCode;
    const codeColor = code < 300 ? 32 : code < 400 ? 33 : 31;
    console.log(
      `${dim(timestamp())} ${color("←", codeColor)} ${req.method} ${req.path} ${color(
        String(code),
        codeColor
      )} (${ms}ms)`
    );
  });
  next();
});

// ----------------------------------------------------------------------------
//  Health
// ----------------------------------------------------------------------------
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ----------------------------------------------------------------------------
//  GET /api/wallet
// ----------------------------------------------------------------------------
app.get("/api/wallet", async (_req: Request, res: Response) => {
  try {
    const data = await getWalletStatus();
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ----------------------------------------------------------------------------
//  POST /api/session
// ----------------------------------------------------------------------------
app.post("/api/session", async (req: Request, res: Response) => {
  try {
    const data = await createSession(req.body);
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ----------------------------------------------------------------------------
//  GET /api/session/:id
// ----------------------------------------------------------------------------
app.get("/api/session/:id", async (req: Request, res: Response) => {
  try {
    const data = await getSession(req.params["id"] as SessionId);
    if (!data) {
      res.status(404).json({ code: "NOT_FOUND", message: "Session not found" });
      return;
    }
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ----------------------------------------------------------------------------
//  POST /api/pay
// ----------------------------------------------------------------------------
app.post("/api/pay", async (req: Request, res: Response) => {
  try {
    const data = await processPayment(req.body);
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ----------------------------------------------------------------------------
//  Error handler
// ----------------------------------------------------------------------------
function handleError(res: Response, err: unknown): void {
  const e = err as ApiError;
  const code = e.code ?? "INTERNAL";
  const message = (err as Error).message ?? "internal error";
  const httpStatus = code === "VALIDATION" ? 400 : code === "NOT_FOUND" ? 404 : 500;
  console.error(`${dim(timestamp())} ${color("error", 31)}: ${code} ${message}`);
  res.status(httpStatus).json({ code, message });
}

// ----------------------------------------------------------------------------
//  Boot — eager-init context to fail fast on missing env
// ----------------------------------------------------------------------------
try {
  const ctx = context();
  app.listen(PORT, () => {
    console.log("");
    console.log(color("════════════════════════════════════════════════════════════════", 36));
    console.log(color("  🌐 OpenAgentPay × HashKey Chain — Demo API", 36));
    console.log(color("════════════════════════════════════════════════════════════════", 36));
    console.log(`  Listening on:    ${color(`http://localhost:${PORT}`, 36)}`);
    console.log(`  Agent address:   ${color(ctx.connector.agentAddress, 36)}`);
    console.log(`  Token address:   ${color(ctx.tokenAddress, 36)}`);
    console.log(`  Network:         HashKey Chain Testnet (chainId=133)`);
    console.log("");
    console.log(`  Endpoints:`);
    console.log(`    GET  /api/health`);
    console.log(`    GET  /api/wallet`);
    console.log(`    POST /api/session   { budgetUsd, expiryMinutes }`);
    console.log(`    GET  /api/session/:id`);
    console.log(`    POST /api/pay       { sessionId, amountUsdc, recipient? }`);
    console.log("");
  });
} catch (err) {
  console.error(color("\n❌ Failed to boot demo-api:", 31), (err as Error).message);
  process.exit(1);
}

// ----------------------------------------------------------------------------
//  helpers
// ----------------------------------------------------------------------------
function color(s: string, code: number): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
function timestamp(): string {
  return new Date().toISOString().split("T")[1]!.split(".")[0]!;
}
