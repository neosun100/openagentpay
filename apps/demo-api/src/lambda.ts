/**
 * AWS Lambda Function URL handler — production mode.
 *
 * The same handlers in `handlers.ts` (used by local Express in `server.ts`)
 * but wrapped for Lambda Function URL invocation. CDK NodejsFunction bundles
 * this entrypoint via esbuild.
 *
 * Routes (matched by HTTP method + path):
 *   GET  /api/health
 *   GET  /api/wallet
 *   POST /api/session
 *   GET  /api/session/:id
 *   POST /api/pay
 *
 * Environment variables (set by CDK):
 *   HASHKEY_TESTNET_AGENT_PRIVATE_KEY_SECRET_ARN  — Secrets Manager ARN
 *   HASHKEY_USDC_ADDRESS                          — pre-deployed token
 *   HASHKEY_RPC_URL                               — testnet RPC
 *
 * @license Apache-2.0
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";

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
import { _resetContext, ensureContext } from "./context.js";
import type { SessionId } from "@openagentpay/core";

// CORS — allow all origins for demo (TODO: tighten in production)
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(
  body: unknown,
  status = 200
): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

function errorResponse(err: unknown, fallbackStatus = 500): APIGatewayProxyResultV2 {
  const e = err as ApiError;
  const code = e.code ?? "INTERNAL";
  const message = (err as Error).message ?? "internal error";
  const status = code === "VALIDATION" ? 400 : code === "NOT_FOUND" ? 404 : fallbackStatus;
  console.error(`API error: ${code} ${message}`);
  return jsonResponse({ code, message }, status);
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const body = event.body
    ? (event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf-8")
        : event.body)
    : "";

  console.log(`${method} ${path}`);

  // Preflight
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  try {
    // Initialize context (idempotent — first call fetches from Secrets Manager)
    await ensureContext();

    // GET /api/health
    if (method === "GET" && path === "/api/health") {
      return jsonResponse({ ok: true, ts: new Date().toISOString() });
    }

    // GET /api/wallets — list available wallet providers
    if (method === "GET" && path === "/api/wallets") {
      const data = await listWallets();
      return jsonResponse(data);
    }

    // GET /api/wallet?walletProvider=...
    if (method === "GET" && path === "/api/wallet") {
      const wp = event.queryStringParameters?.["walletProvider"];
      const data = await getWalletStatus(wp);
      return jsonResponse(data);
    }

    // GET /api/governance — policies + audit log
    if (method === "GET" && path === "/api/governance") {
      const data = await getGovernanceStatus();
      return jsonResponse(data);
    }

    // GET /api/governance/audit?actor=...&kind=...&since=...&limit=...
    if (method === "GET" && path === "/api/governance/audit") {
      const q = event.queryStringParameters ?? {};
      const params = {
        ...(q["actor"] ? { actor: q["actor"] } : {}),
        ...(q["kind"] ? { kind: q["kind"] } : {}),
        ...(q["since"] ? { since: q["since"] } : {}),
        ...(q["limit"] ? { limit: Number(q["limit"]) } : {}),
        ...(q["cursor"] ? { cursor: q["cursor"] } : {}),
      };
      const data = await queryAudit(params);
      return jsonResponse(data);
    }

    // POST /api/session
    if (method === "POST" && path === "/api/session") {
      const parsed = body ? JSON.parse(body) : {};
      const data = await createSession(parsed);
      return jsonResponse(data);
    }

    // GET /api/session/:id
    if (method === "GET" && path.startsWith("/api/session/")) {
      const id = path.replace("/api/session/", "") as SessionId;
      const data = await getSession(id);
      if (!data) return jsonResponse({ code: "NOT_FOUND", message: "Session not found" }, 404);
      return jsonResponse(data);
    }

    // POST /api/pay
    if (method === "POST" && path === "/api/pay") {
      const parsed = body ? JSON.parse(body) : {};
      const data = await processPayment(parsed);
      return jsonResponse(data);
    }

    // Unknown
    return jsonResponse({ code: "NOT_FOUND", message: `${method} ${path} not found` }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}

// Avoid pruning of internal symbol used for tests
export const __internal = { _resetContext };
