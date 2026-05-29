/**
 * @openagentpay/protocol-x402 — Coinbase x402 protocol adapter
 * =============================================================
 *
 * Implements the x402 v1/v2 ProtocolAdapter — splits the protocol concern
 * out of wallet-hashkey / wallet-coinbase-cdp / wallet-metamask, etc.
 *
 *   - detect()                — recognises { x402Version: 1|2, accepts: [...] }
 *   - parsePaymentRequired()  — parses the `accepts[]` array, picks first match
 *   - buildRetry()            — emits X-PAYMENT header (base64url JSON token)
 *
 * Spec: https://www.x402.org/x402-whitepaper.pdf  +  https://github.com/coinbase/x402
 *
 * @license Apache-2.0
 */

import {
  type HttpResponse402,
  type HttpRetryEnvelope,
  type Money,
  type PaymentRequest,
  ProtocolError,
  type ProtocolAdapter,
  type ProtocolId,
  type SignedAuthorization,
} from "@openagentpay/core";

// ============================================================================
//  Constants
// ============================================================================

export const PROTOCOL_ID_V1 = "x402-v1" as ProtocolId;
export const PROTOCOL_ID_V2 = "x402-v2" as ProtocolId;
export const X_PAYMENT_HEADER = "X-PAYMENT";
export const SUPPORTED_X402_VERSIONS = [1, 2] as const;
export const DEFAULT_SCHEME = "exact";

// ============================================================================
//  Wire shape — exact 1:1 with x402 v1 spec
// ============================================================================

export interface X402AcceptEntry {
  /** "exact" is the only standardised scheme today; future ones are "inexact" / "stream". */
  readonly scheme: string;
  /** Network identifier — "base", "base-sepolia", "ethereum", "polygon", ... */
  readonly network: string;
  /** Atomic units — stringified integer. */
  readonly maxAmountRequired: string;
  /** Resource URL the merchant is gating. */
  readonly resource: string;
  readonly description?: string;
  readonly mimeType?: string;
  /** Recipient address. */
  readonly payTo: string;
  /** Authorization TTL (seconds). */
  readonly maxTimeoutSeconds: number;
  /** ERC-20 token contract address. */
  readonly asset: string;
  /** Optional extra fields — Coinbase puts EIP-712 token name/version here. */
  readonly extra?: {
    readonly name?: string;
    readonly version?: string;
    readonly decimals?: number;
    [k: string]: unknown;
  };
}

export interface X402402Body {
  readonly x402Version: number;
  readonly accepts: readonly X402AcceptEntry[];
  readonly error?: string;
}

/** Inner payload of the X-PAYMENT header (post-signing). */
export interface X402PaymentPayload {
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: string;
  readonly payload: {
    readonly signature: string;
    readonly authorization: {
      readonly from: string;
      readonly to: string;
      readonly value: string;
      readonly validAfter: string;
      readonly validBefore: string;
      readonly nonce: string;
    };
  };
}

// ============================================================================
//  Selection policy — pick which `accepts[]` we honor
// ============================================================================

export type AcceptSelector = (
  accepts: readonly X402AcceptEntry[]
) => X402AcceptEntry | undefined;

export interface X402ProtocolAdapterConfig {
  /** Networks we'll honor — defaults to all. */
  readonly preferredNetworks?: readonly string[];
  /** Schemes we'll honor — default ["exact"]. */
  readonly supportedSchemes?: readonly string[];
  /** Custom selector — overrides preferred* fields. */
  readonly selectAccept?: AcceptSelector;
  /** Currency / decimals lookup for known token contracts (lowercase address → {symbol, decimals}). */
  readonly assetRegistry?: Readonly<Record<string, { readonly symbol: string; readonly decimals: number }>>;
  /** Override clock for tests. */
  readonly now?: () => number;
}

// ============================================================================
//  Adapter
// ============================================================================

export class X402ProtocolAdapter implements ProtocolAdapter {
  /** We respond to v1 by default; v2 callers can construct another instance. */
  readonly id: ProtocolId = PROTOCOL_ID_V1;
  private readonly preferredNetworks: ReadonlySet<string> | undefined;
  private readonly supportedSchemes: ReadonlySet<string>;
  private readonly selectAccept: AcceptSelector;
  private readonly assetRegistry: Readonly<
    Record<string, { readonly symbol: string; readonly decimals: number }>
  >;
  private readonly now: () => number;

  constructor(config: X402ProtocolAdapterConfig = {}) {
    this.preferredNetworks = config.preferredNetworks
      ? new Set(config.preferredNetworks)
      : undefined;
    this.supportedSchemes = new Set(config.supportedSchemes ?? [DEFAULT_SCHEME]);
    this.assetRegistry = config.assetRegistry ?? DEFAULT_ASSET_REGISTRY;
    this.now = config.now ?? Date.now;
    this.selectAccept =
      config.selectAccept ??
      ((accepts) => {
        for (const a of accepts) {
          if (!this.supportedSchemes.has(a.scheme)) continue;
          if (this.preferredNetworks && !this.preferredNetworks.has(a.network)) continue;
          return a;
        }
        return undefined;
      });
  }

  // -------------------------------------------------------------------------
  //  ProtocolAdapter contract
  // -------------------------------------------------------------------------

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    const v = body["x402Version"];
    if (typeof v !== "number" || !SUPPORTED_X402_VERSIONS.includes(v as 1 | 2)) {
      return false;
    }
    return Array.isArray(body["accepts"]) && body["accepts"].length > 0;
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);
    const accept = this.selectAccept(body.accepts);
    if (!accept) {
      throw new ProtocolError(
        `No supported (scheme,network) pair in accepts[]: got ${body.accepts
          .map((a) => `${a.scheme}@${a.network}`)
          .join(", ")}`,
        "unsupported_scheme"
      );
    }

    const meta = this.assetRegistry[accept.asset.toLowerCase()];
    const decimals = accept.extra?.decimals ?? meta?.decimals ?? 6;
    const currency = meta?.symbol ?? accept.extra?.name ?? "USDC";
    const amount: Money = {
      amountAtomic: accept.maxAmountRequired,
      decimals,
      currency,
    };

    const validAfter = 0;
    const validBefore =
      Math.floor(this.now() / 1000) + (accept.maxTimeoutSeconds || 600);
    const nonce = generateNonce();

    const chainCaip = caip2(accept.network);
    return {
      protocol: PROTOCOL_ID_V1,
      amount,
      recipient: accept.payTo,
      asset: {
        symbol: currency,
        decimals,
        contract: accept.asset,
        ...(chainCaip !== undefined ? { chain: chainCaip } : {}),
      },
      validAfter,
      validBefore,
      nonce,
      rawPayload: { selectedAccept: accept, fullBody: body },
      ...(accept.description !== undefined ? { description: accept.description } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError(
        "x402 retry requires SignedAuthorization.signature",
        "missing_field"
      );
    }
    // Pull v/r/s authorization from the signed.extra (set by EVM connectors)
    // OR fall back to encoding from request fields directly.
    const e = (signed.extra ?? {}) as Record<string, unknown>;
    const network =
      (e["network"] as string | undefined) ??
      caipChainToNetwork(signed.request.asset.chain);
    if (!network) {
      throw new ProtocolError(
        "x402 retry requires `network` (in signed.extra or request.asset.chain)",
        "missing_field"
      );
    }
    const payload: X402PaymentPayload = {
      x402Version: 1,
      scheme: (e["scheme"] as string | undefined) ?? DEFAULT_SCHEME,
      network,
      payload: {
        signature: signed.signature,
        authorization: {
          from: signed.signer,
          to: signed.request.recipient,
          value: signed.request.amount.amountAtomic,
          validAfter: String(signed.request.validAfter),
          validBefore: String(signed.request.validBefore),
          nonce: signed.request.nonce,
        },
      },
    };
    const encoded = base64urlEncode(JSON.stringify(payload));
    return {
      headers: {
        [X_PAYMENT_HEADER]: encoded,
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  // -------------------------------------------------------------------------
  //  Internals
  // -------------------------------------------------------------------------

  private assertBody(body: unknown): X402402Body {
    if (!isObject(body))
      throw new ProtocolError("x402 body must be an object", "malformed");
    const v = body["x402Version"];
    if (typeof v !== "number")
      throw new ProtocolError("x402 missing x402Version", "missing_field");
    if (!SUPPORTED_X402_VERSIONS.includes(v as 1 | 2)) {
      throw new ProtocolError(
        `x402 version ${v} not supported (this adapter speaks ${SUPPORTED_X402_VERSIONS.join(",")})`,
        "unsupported_version"
      );
    }
    if (!Array.isArray(body["accepts"]) || body["accepts"].length === 0) {
      throw new ProtocolError(
        "x402 accepts[] must be a non-empty array",
        "missing_field"
      );
    }
    for (const a of body["accepts"]) {
      if (!isObject(a)) {
        throw new ProtocolError("accepts[] item not an object", "malformed");
      }
      for (const f of [
        "scheme",
        "network",
        "maxAmountRequired",
        "resource",
        "payTo",
        "maxTimeoutSeconds",
        "asset",
      ] as const) {
        if (a[f] === undefined) {
          throw new ProtocolError(
            `accepts[] item missing field: ${f}`,
            "missing_field"
          );
        }
      }
    }
    return body as unknown as X402402Body;
  }
}

// ============================================================================
//  Decoder utility
// ============================================================================

/** Decode the X-PAYMENT header back to a payload (used by merchant validators). */
export function decodePaymentHeader(headerValue: string): X402PaymentPayload {
  let parsed: unknown;
  try {
    const json = base64urlDecode(headerValue);
    parsed = JSON.parse(json);
  } catch {
    throw new ProtocolError("X-PAYMENT is not valid base64-url JSON", "malformed");
  }
  return parsed as X402PaymentPayload;
}

// ============================================================================
//  Asset registry — maps known ERC-20 contracts to symbol/decimals
// ============================================================================

export const DEFAULT_ASSET_REGISTRY: Readonly<
  Record<string, { readonly symbol: string; readonly decimals: number }>
> = Object.freeze({
  // Circle USDC
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": { symbol: "USDC", decimals: 6 }, // Base Sepolia
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6 }, // Base mainnet
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 }, // Ethereum mainnet
  "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": { symbol: "USDC", decimals: 6 }, // Sepolia
  // OpenAgentPay MockUSDC on HashKey Chain Testnet
  "0x0685c487df4cc0723aa828c299686798294e9803": { symbol: "USDC", decimals: 6 },
});

// ============================================================================
//  Helpers
// ============================================================================

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function base64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function base64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function generateNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Network name → CAIP-2 (eip155:84532, etc.). Best-effort; returns undefined on miss. */
function caip2(network: string): string | undefined {
  const map: Record<string, string> = {
    "base": "eip155:8453",
    "base-sepolia": "eip155:84532",
    "ethereum": "eip155:1",
    "ethereum-sepolia": "eip155:11155111",
    "polygon": "eip155:137",
    "polygon-amoy": "eip155:80002",
    "optimism": "eip155:10",
    "arbitrum": "eip155:42161",
    "hashkey-chain": "eip155:177",
    "hashkey-chain-testnet": "eip155:133",
  };
  return map[network];
}

function caipChainToNetwork(chain?: string): string | undefined {
  if (!chain) return undefined;
  // Reverse lookup
  const reverseMap: Record<string, string> = {
    "eip155:8453": "base",
    "eip155:84532": "base-sepolia",
    "eip155:1": "ethereum",
    "eip155:11155111": "ethereum-sepolia",
    "eip155:137": "polygon",
    "eip155:177": "hashkey-chain",
    "eip155:133": "hashkey-chain-testnet",
  };
  return reverseMap[chain] ?? chain;
}
