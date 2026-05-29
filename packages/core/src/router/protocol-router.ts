/**
 * ProtocolRouter — automatic dispatch over multiple ProtocolAdapter instances.
 * ===========================================================================
 *
 * Given a 402 response, walk the registered adapters in priority order and
 * pick the first one whose `detect()` returns true. This enables one Agent
 * to consume:
 *
 *   - x402 v1/v2 endpoints (chain-settled)
 *   - OAP-CEX endpoints (CEX-settled)
 *   - AP2 mandate-bearing endpoints (any settlement)
 *   - Future: MPP, ACP, Solana Pay, ...
 *
 * Without changing one line of business logic.
 *
 * Compose-mode (the user's "暴露成为单一的协议" requirement):
 * If a 402 envelope contains BOTH an AP2 mandate AND a settlement payload,
 * the router parses both and merges them into a single PaymentRequest:
 * mandates flow through `request.mandates`, settlement instructions flow
 * through everything else. Wallet connectors only see the unified shape.
 *
 * @license Apache-2.0
 */

import {
  type HttpResponse402,
  type Mandate,
  type PaymentRequest,
  ProtocolError,
  type ProtocolAdapter,
  type ProtocolId,
} from "../types.js";

// ============================================================================
//  Public API
// ============================================================================

export interface RouteResult {
  readonly adapter: ProtocolAdapter;
  readonly request: PaymentRequest;
  /** True if the response carried AP2 mandates that were merged in. */
  readonly hasMandates: boolean;
  /** Adapter ids consulted in order — useful for debugging routing. */
  readonly trace: readonly ProtocolId[];
}

export interface ProtocolRouterConfig {
  /** Adapters in priority order — first match wins. */
  readonly adapters: ReadonlyArray<ProtocolAdapter>;
  /** Optional: when true, pull mandates from `body.mandates[]` and inject them. */
  readonly carryMandates?: boolean;
}

// ============================================================================
//  Implementation
// ============================================================================

export class ProtocolRouter {
  private readonly adapters: ReadonlyArray<ProtocolAdapter>;
  private readonly carryMandates: boolean;

  constructor(config: ProtocolRouterConfig) {
    if (!Array.isArray(config.adapters) || config.adapters.length === 0) {
      throw new Error("ProtocolRouter requires at least one ProtocolAdapter");
    }
    this.adapters = config.adapters;
    this.carryMandates = config.carryMandates ?? true;
  }

  /** List registered adapter ids (for diagnostics + UI). */
  list(): ReadonlyArray<ProtocolId> {
    return this.adapters.map((a) => a.id);
  }

  /**
   * Route a 402 response to the right adapter and return the parsed
   * PaymentRequest. Mandates from AP2-bearing envelopes are merged in
   * automatically when `carryMandates` is true.
   *
   * Throws ProtocolError("no_adapter_match") when nothing matches.
   */
  async route(response: HttpResponse402): Promise<RouteResult> {
    const trace: ProtocolId[] = [];
    for (const adapter of this.adapters) {
      trace.push(adapter.id);
      let matched = false;
      try {
        matched = adapter.detect(response);
      } catch {
        // Detect MUST NOT throw, but be defensive — treat as miss.
        matched = false;
      }
      if (!matched) continue;

      const baseRequest = await adapter.parsePaymentRequired(response);
      const mandates = this.carryMandates ? extractMandates(response.body) : [];
      const request: PaymentRequest = mandates.length > 0
        ? { ...baseRequest, mandates }
        : baseRequest;
      return { adapter, request, hasMandates: mandates.length > 0, trace };
    }
    throw new ProtocolError(
      `No registered ProtocolAdapter matched the 402 response (consulted: ${trace.join(", ")})`,
      "unsupported_scheme"
    );
  }

  /**
   * Direct lookup by id — use when you've already negotiated which protocol
   * to speak (e.g., the wallet connector reports its preferred protocol).
   */
  byId(id: ProtocolId): ProtocolAdapter | undefined {
    return this.adapters.find((a) => a.id === id);
  }
}

// ============================================================================
//  Mandate extraction (AP2 envelope bridge)
// ============================================================================

/**
 * Pull AP2 mandates out of a 402 body. Supports two carrier shapes:
 *
 *   1. Top-level: { mandates: [Mandate, ...], ...rest }
 *   2. AP2-native: { ap2: { mandates: [...] }, ...rest }
 *
 * Mandates that fail minimal structural validation are silently dropped —
 * higher-level Compliance/Audit layers MAY require them via PolicyEngine.
 */
function extractMandates(body: unknown): Mandate[] {
  if (!isObject(body)) return [];
  const direct = (body as Record<string, unknown>)["mandates"];
  const ap2 = (body as Record<string, unknown>)["ap2"];
  const rawMandates: unknown[] = [];

  if (Array.isArray(direct)) rawMandates.push(...direct);
  if (isObject(ap2) && Array.isArray((ap2 as Record<string, unknown>)["mandates"])) {
    rawMandates.push(...((ap2 as Record<string, unknown>)["mandates"] as unknown[]));
  }
  return rawMandates.filter(isWellFormedMandate) as Mandate[];
}

function isWellFormedMandate(v: unknown): boolean {
  if (!isObject(v)) return false;
  const m = v as Record<string, unknown>;
  if (!Array.isArray(m["@context"])) return false;
  if (typeof m["id"] !== "string") return false;
  if (!Array.isArray(m["type"]) || m["type"].length < 2) return false;
  if (typeof m["issuer"] !== "string") return false;
  if (typeof m["issuanceDate"] !== "string") return false;
  if (!isObject(m["credentialSubject"])) return false;
  if (!isObject(m["proof"])) return false;
  return true;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
