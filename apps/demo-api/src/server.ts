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
  getGovernanceStatus,
  getWalletStatus,
  listWallets,
  processPayment,
  queryAudit,
  type ApiError,
} from "./handlers.js";
import { context, ensureContext } from "./context.js";
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
//  GET /api/wallets — list available wallet providers
// ----------------------------------------------------------------------------
app.get("/api/wallets", async (_req: Request, res: Response) => {
  try {
    const data = await listWallets();
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ----------------------------------------------------------------------------
//  GET /api/wallet?walletProvider=...
// ----------------------------------------------------------------------------
app.get("/api/wallet", async (req: Request, res: Response) => {
  try {
    const wp = req.query["walletProvider"] as string | undefined;
    const data = await getWalletStatus(wp);
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ----------------------------------------------------------------------------
//  GET /api/governance — policies + audit log
// ----------------------------------------------------------------------------
app.get("/api/governance", async (_req: Request, res: Response) => {
  try {
    const data = await getGovernanceStatus();
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ----------------------------------------------------------------------------
//  GET /api/governance/audit?actor=...&kind=...&since=...&limit=...
//  Persistent audit query (DynamoDB if configured, else in-memory)
// ----------------------------------------------------------------------------
app.get("/api/governance/audit", async (req: Request, res: Response) => {
  try {
    const params = {
      ...(req.query["actor"] ? { actor: String(req.query["actor"]) } : {}),
      ...(req.query["kind"] ? { kind: String(req.query["kind"]) } : {}),
      ...(req.query["since"] ? { since: String(req.query["since"]) } : {}),
      ...(req.query["limit"]
        ? { limit: Number(req.query["limit"]) }
        : {}),
      ...(req.query["cursor"]
        ? { cursor: String(req.query["cursor"]) }
        : {}),
    };
    const data = await queryAudit(params);
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
ensureContext()
  .then(() => {
    const ctx = context();
    app.listen(PORT, () => {
      console.log("");
      console.log(color("════════════════════════════════════════════════════════════════", 36));
      console.log(color("  🌐 OpenAgentPay — Demo API (Path D Hybrid)", 36));
      console.log(color("════════════════════════════════════════════════════════════════", 36));
      console.log(`  Listening on:    ${color(`http://localhost:${PORT}`, 36)}`);
      console.log(`  Default wallet:  ${color(ctx.defaultProvider, 36)}`);
      console.log(`  Connectors loaded:`);
      for (const b of ctx.connectors.values()) {
        console.log(
          `    - ${color(b.walletProvider, 36)}  ${b.displayName}  on ${b.chainName}  (${b.tokenLabel})`
        );
        console.log(`      agent: ${b.agentAddress}`);
      }
      console.log("");
      console.log(`  Endpoints:`);
      console.log(`    GET  /api/health`);
      console.log(`    GET  /api/wallets                                         (list providers)`);
      console.log(`    GET  /api/wallet?walletProvider=...                       (status)`);
      console.log(`    GET  /api/governance                                      (policies + audit log)`);
      console.log(`    POST /api/session   { budgetUsd, expiryMinutes }`);
      console.log(`    GET  /api/session/:id`);
      console.log(`    POST /api/pay       { sessionId, amountUsdc, recipient?, walletProvider? }`);
      console.log("");
      console.log(`  Governance enabled: ${ctx.policyDescriptions.length} policies, sanctions check on`);
      console.log("");
    });
  })
  .catch((err: Error) => {
    console.error(color("\n❌ Failed to boot demo-api:", 31), err.message);
    process.exit(1);
  });

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
