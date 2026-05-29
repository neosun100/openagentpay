/**
 * createProxy() — main factory.
 *
 * Wires together:
 *   - virtualApiKeyAuth() middleware (multi-tenant)
 *   - PaymentManager (handles processPayment)
 *   - GovernanceManager (preCheck on every payment)
 *   - per-tenant wallet allow-list enforcement
 *   - per-tenant amount cap enforcement (requireTwoPersonApprovalAboveUsd)
 *
 * Mountable into any Express host or used standalone via `oap-proxy` CLI.
 *
 * @license Apache-2.0
 */

import cors from "cors";
import express, { type Express, type Request, type Response } from "express";

import {
  type CreateInstrumentInput,
  type CreateSessionInput,
  type Instrument,
  type InstrumentId,
  type PaymentManager,
  type PaymentRequest,
  type SessionId,
  type UserId,
  type WalletProviderId,
} from "@openagentpay/core";
import type { GovernanceManager } from "@openagentpay/governance";

import {
  virtualApiKeyAuth,
  getAuth,
  type AuthContext,
  type VirtualApiKeyAuthConfig,
} from "./auth.js";
import type { TenantStore } from "./tenant.js";

// ============================================================================
//  Config
// ============================================================================

export interface CreateProxyConfig {
  /** PaymentManager backed by your wallet connectors + session store. */
  readonly paymentManager: PaymentManager;
  /** Governance pre-check + audit. Optional but strongly recommended. */
  readonly governance?: GovernanceManager;
  /** Tenant store for virtual API keys. */
  readonly tenantStore: TenantStore;
  /** Auth middleware overrides. */
  readonly auth?: Omit<VirtualApiKeyAuthConfig, "tenantStore">;
  /** Resolve an instrumentId for a (tenant, walletProvider) pair. */
  readonly resolveInstrument?: (
    tenantId: string,
    walletProvider: WalletProviderId
  ) => Promise<InstrumentId | undefined>;
}

export interface ProxyApp {
  readonly app: Express;
}

// ============================================================================
//  Factory
// ============================================================================

export function createProxy(cfg: CreateProxyConfig): ProxyApp {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(cors({ origin: true, credentials: false }));

  // ---- Auth ----
  app.use(
    virtualApiKeyAuth({ ...(cfg.auth ?? {}), tenantStore: cfg.tenantStore })
  );

  // ---- Health (public) ----
  app.get("/v1/health", (_req: Request, res: Response) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // ---- Whoami ----
  app.get("/v1/whoami", (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    res.json({
      tenantId: auth.tenant.id,
      tenantName: auth.tenant.name,
      allowedWallets: auth.tenant.allowedWallets,
      allowedProtocols: auth.tenant.allowedProtocols,
      dailyBudgetUsd: auth.tenant.dailyBudgetUsd,
      sandboxOnly: auth.tenant.sandboxOnly === true,
      apiKeyHashShort: auth.apiKeyHashShort,
    });
  });

  // ---- List wallets visible to this tenant ----
  app.get("/v1/wallets", (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const all = cfg.paymentManager.listProviders();
    const visible = filterByAllowList(all, auth.tenant.allowedWallets);
    res.json({
      wallets: visible.map((p) => {
        const conn = cfg.paymentManager.getConnector(p);
        return conn ? conn.getCapabilities() : { walletProvider: p };
      }),
    });
  });

  // ---- POST /v1/sessions ----
  app.post("/v1/sessions", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    try {
      const body = req.body as Partial<CreateSessionInput>;
      const budgetUsd = Number(body?.budgetUsd ?? 0);
      const expiresMinutes = Number(body?.expiresMinutes ?? 30);
      if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
        res
          .status(400)
          .json({ error: "invalid_argument", message: "budgetUsd > 0 required" });
        return;
      }
      if (budgetUsd > auth.tenant.dailyBudgetUsd) {
        res.status(403).json({
          error: "exceeds_daily_budget",
          message: `Requested budget ${budgetUsd} > tenant cap ${auth.tenant.dailyBudgetUsd}`,
        });
        return;
      }
      const userId = (body?.userId ?? auth.tenant.id) as UserId;
      const session = await cfg.paymentManager.createPaymentSession({
        userId,
        budgetUsd,
        expiresMinutes,
        ...(body?.metadata !== undefined ? { metadata: body.metadata } : {}),
      });
      res.json(session);
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- GET /v1/sessions/:id ----
  app.get("/v1/sessions/:id", async (req: Request, res: Response) => {
    if (!getAuth(req)) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    try {
      const id = req.params["id"] as string;
      const session = await cfg.paymentManager.getPaymentSession(
        id as SessionId
      );
      if (!session) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(session);
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- POST /v1/instruments ----
  app.post("/v1/instruments", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    try {
      const body = req.body as { walletProvider?: string } & Partial<
        CreateInstrumentInput
      >;
      const wp = body?.walletProvider as WalletProviderId | undefined;
      if (!wp) {
        res.status(400).json({
          error: "invalid_argument",
          message: "walletProvider required",
        });
        return;
      }
      if (!isWalletAllowed(auth, wp)) {
        res.status(403).json({
          error: "wallet_not_allowed",
          message: `Tenant '${auth.tenant.id}' is not allowed to use wallet '${wp}'`,
        });
        return;
      }
      const userId = (body?.userId ?? auth.tenant.id) as UserId;
      const inst = await cfg.paymentManager.createPaymentInstrument(wp, {
        userId,
        ...(body?.metadata !== undefined ? { metadata: body.metadata } : {}),
      });
      res.json(inst);
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- POST /v1/payments ----
  app.post("/v1/payments", async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    try {
      const body = req.body as {
        sessionId?: string;
        instrumentId?: string;
        request?: PaymentRequest;
        walletProvider?: string;
      };
      if (!body?.sessionId || !body?.instrumentId || !body?.request) {
        res.status(400).json({
          error: "invalid_argument",
          message: "sessionId, instrumentId, and request are required",
        });
        return;
      }
      const wp = (body.walletProvider as WalletProviderId | undefined) ?? null;
      if (wp && !isWalletAllowed(auth, wp)) {
        res.status(403).json({
          error: "wallet_not_allowed",
          message: `Tenant '${auth.tenant.id}' is not allowed to use wallet '${wp}'`,
        });
        return;
      }
      // Two-person approval gate
      const cap = auth.tenant.requireTwoPersonApprovalAboveUsd;
      if (typeof cap === "number" && cap > 0) {
        const usd = atomicToUsd(body.request.amount);
        const approved = req.headers["x-second-approver"];
        if (usd > cap && !approved) {
          res.status(403).json({
            error: "second_approval_required",
            message: `Payment ${usd} USD exceeds two-person approval threshold ${cap}. Provide X-Second-Approver header.`,
          });
          return;
        }
      }

      // Optional governance pre-check
      if (cfg.governance) {
        const session = await cfg.paymentManager.getPaymentSession(
          body.sessionId as SessionId
        );
        if (!session) {
          res.status(404).json({ error: "session_not_found" });
          return;
        }
        const decision = await cfg.governance.preCheck({
          userId: session.userId,
          walletProvider: (wp ?? ("" as WalletProviderId)) as WalletProviderId,
          request: body.request,
          session,
          recentPayments: [],
        });
        if (!decision.allowed) {
          res.status(403).json({
            error: "policy_denied",
            message: decision.reason ?? "denied",
            denyPolicyName: decision.denyPolicyName,
          });
          return;
        }
      }

      const out = await cfg.paymentManager.processPayment({
        sessionId: body.sessionId as SessionId,
        instrumentId: body.instrumentId as InstrumentId,
        request: body.request,
      });
      res.json(out);
    } catch (err) {
      sendError(res, err);
    }
  });

  return { app };
}

// ============================================================================
//  Helpers
// ============================================================================

function filterByAllowList<T extends string>(
  all: readonly T[],
  allowed: readonly string[]
): readonly T[] {
  if (allowed.length === 0) return all;
  const set = new Set(allowed);
  return all.filter((id) => set.has(id));
}

function isWalletAllowed(auth: AuthContext, wp: string): boolean {
  if (auth.tenant.allowedWallets.length === 0) return true;
  return auth.tenant.allowedWallets.includes(wp);
}

function atomicToUsd(amount: {
  amountAtomic: string;
  decimals: number;
}): number {
  const a = Number(BigInt(amount.amountAtomic));
  return a / Math.pow(10, amount.decimals);
}

function sendError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error("[proxy] error:", message);
  res.status(500).json({ error: "internal", message });
}

// Re-export Instrument type so consumers can import from this module
export type { Instrument };
