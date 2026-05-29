/**
 * @openagentpay/protocol-aptos — Aptos Pay Adapter
 * =================================================
 *
 * Aptos uses Move (like Sui) but with global storage rooted at addresses.
 * Coin types follow `0x...::module::struct`.
 *
 * Wire envelope:
 *   {
 *     aptosVersion: "1",
 *     recipient: "0x...",
 *     coinType: "0x1::aptos_coin::AptosCoin" | "0x...::usdc::USDC",
 *     amountAtomic: "1000000",       // 1 octa = 1e-8 APT; USDC = 1e-6
 *     network: "mainnet" | "testnet" | "devnet",
 *     reference?: string,
 *     description?: string
 *   }
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

export const PROTOCOL_ID = "aptos-pay-v1" as ProtocolId;
export const X_PAYMENT_APTOS_HEADER = "X-PAYMENT-APTOS";

const KNOWN_COIN_TYPES: Record<string, { symbol: string; decimals: number }> = {
  "0x1::aptos_coin::AptosCoin": { symbol: "APT", decimals: 8 },
  "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b::usdc::USDC": { symbol: "USDC", decimals: 6 },
  "0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDC": { symbol: "USDC", decimals: 6 },
};

export interface AptosPay402Body {
  readonly aptosVersion: string;
  readonly recipient: string;
  readonly coinType: string;
  readonly amountAtomic: string;
  readonly network: "mainnet" | "testnet" | "devnet" | "localnet";
  readonly reference?: string;
  readonly description?: string;
}

export interface AptosAdapterConfig {
  readonly preferredNetworks?: readonly ("mainnet" | "testnet" | "devnet" | "localnet")[];
  readonly knownCoinTypes?: Record<string, { symbol: string; decimals: number }>;
  readonly now?: () => number;
}

export class AptosPayProtocolAdapter implements ProtocolAdapter {
  readonly id = PROTOCOL_ID;
  private readonly preferredNetworks: ReadonlySet<string> | undefined;
  private readonly knownCoinTypes: Record<string, { symbol: string; decimals: number }>;
  private readonly now: () => number;

  constructor(cfg: AptosAdapterConfig = {}) {
    this.preferredNetworks = cfg.preferredNetworks ? new Set(cfg.preferredNetworks) : undefined;
    this.knownCoinTypes = cfg.knownCoinTypes ?? KNOWN_COIN_TYPES;
    this.now = cfg.now ?? Date.now;
  }

  detect(response: HttpResponse402): boolean {
    if (response.statusCode !== 402) return false;
    const body = response.body;
    if (!isObject(body)) return false;
    return typeof body["aptosVersion"] === "string" && typeof body["coinType"] === "string";
  }

  async parsePaymentRequired(response: HttpResponse402): Promise<PaymentRequest> {
    const body = this.assertBody(response.body);
    if (this.preferredNetworks && !this.preferredNetworks.has(body.network)) {
      throw new ProtocolError(`Aptos network '${body.network}' not in preferred set`, "unsupported_scheme");
    }
    if (!isLikelyAptosAddress(body.recipient)) {
      throw new ProtocolError(`Aptos recipient invalid: ${body.recipient}`, "malformed");
    }
    const coinMeta = this.knownCoinTypes[body.coinType] ?? { symbol: "COIN", decimals: 8 };
    const amount: Money = {
      amountAtomic: body.amountAtomic,
      decimals: coinMeta.decimals,
      currency: coinMeta.symbol,
    };
    const validBefore = Math.floor(this.now() / 1000) + 600;
    return {
      protocol: PROTOCOL_ID,
      amount,
      recipient: body.recipient,
      asset: {
        symbol: coinMeta.symbol,
        decimals: coinMeta.decimals,
        contract: body.coinType,
        chain: `aptos:${body.network}`,
      },
      validAfter: 0,
      validBefore,
      nonce: body.reference ?? generateNonce(),
      rawPayload: { aptos: body },
      ...(body.description !== undefined ? { description: body.description } : {}),
    };
  }

  async buildRetry(signed: SignedAuthorization): Promise<HttpRetryEnvelope> {
    if (!signed.signature) {
      throw new ProtocolError("Aptos retry requires tx hash", "missing_field");
    }
    return {
      headers: {
        [X_PAYMENT_APTOS_HEADER]: signed.signature, // Aptos tx hash
      },
    };
  }

  async preSubmit(): Promise<undefined> {
    return undefined;
  }

  private assertBody(body: unknown): AptosPay402Body {
    if (!isObject(body)) throw new ProtocolError("Aptos body must be object", "malformed");
    for (const f of ["aptosVersion", "recipient", "coinType", "amountAtomic", "network"] as const) {
      if (typeof body[f] !== "string") {
        throw new ProtocolError(`Aptos missing field: ${f}`, "missing_field");
      }
    }
    return body as unknown as AptosPay402Body;
  }
}

function isLikelyAptosAddress(s: string): boolean {
  return /^0x[0-9a-f]{1,64}$/i.test(s);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function generateNonce(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
