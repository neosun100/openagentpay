/**
 * Virtual API key authentication middleware.
 *
 * Reads `Authorization: Bearer oap_sk_xxx` (or `X-OpenAgentPay-Key: oap_sk_xxx`),
 * hashes it, looks up the Tenant, and attaches it to req.auth so downstream
 * handlers can enforce wallet allow-lists and per-tenant budgets.
 *
 * 401 if no key, 403 if key hash not found or tenant suspended.
 *
 * @license Apache-2.0
 */

import type { NextFunction, Request, Response } from "express";
import { hashApiKey, type Tenant, type TenantStore } from "./tenant.js";

// ============================================================================
//  AuthContext attached to req via casting (no module augmentation needed)
// ============================================================================

export interface AuthContext {
  readonly tenant: Tenant;
  readonly apiKeyHashShort: string;
}

/** Express Request with our AuthContext attached. Use this type in handlers. */
export type AuthedRequest = Request & { auth?: AuthContext };

/** Get auth from a request (typed). */
export function getAuth(req: Request): AuthContext | undefined {
  return (req as AuthedRequest).auth;
}

// ============================================================================
//  Middleware factory
// ============================================================================

export interface VirtualApiKeyAuthConfig {
  readonly tenantStore: TenantStore;
  /**
   * Routes that don't require auth (always public). Default:
   *   ["/health", "/api/health", "/v1/health", "/metrics"]
   */
  readonly publicPaths?: readonly string[];
  /**
   * If true, allow plain anonymous access (no auth required). Useful for
   * local dev / single-tenant deployments. Default false.
   */
  readonly anonymousAllowed?: boolean;
}

const DEFAULT_PUBLIC_PATHS = [
  "/health",
  "/api/health",
  "/v1/health",
  "/metrics",
];

export function virtualApiKeyAuth(
  cfg: VirtualApiKeyAuthConfig
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const publicPaths = new Set(cfg.publicPaths ?? DEFAULT_PUBLIC_PATHS);
  const anonymousAllowed = cfg.anonymousAllowed === true;

  return async function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (publicPaths.has(req.path)) {
      next();
      return;
    }

    const key = extractApiKey(req);
    if (!key) {
      if (anonymousAllowed) {
        next();
        return;
      }
      res.status(401).json({
        error: "missing_api_key",
        message:
          "Authorization header missing. Use 'Authorization: Bearer oap_sk_...' or 'X-OpenAgentPay-Key' header.",
      });
      return;
    }

    const hash = hashApiKey(key);
    const tenant = await cfg.tenantStore.findByApiKeyHash(hash);
    if (!tenant) {
      res.status(403).json({
        error: "invalid_api_key",
        message: "API key not recognized.",
      });
      return;
    }

    if (tenant.status !== "active") {
      res.status(403).json({
        error: "tenant_suspended",
        message: `Tenant '${tenant.id}' is suspended.`,
      });
      return;
    }

    (req as AuthedRequest).auth = {
      tenant,
      apiKeyHashShort: hash.slice(0, 12),
    };
    next();
  };
}

// ============================================================================
//  Helper — extract API key from headers
// ============================================================================

function extractApiKey(req: Request): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    if (match && match[1]) return match[1];
  }
  const xk = req.headers["x-openagentpay-key"];
  if (typeof xk === "string" && xk.length > 0) return xk;
  return undefined;
}
